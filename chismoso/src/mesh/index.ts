/**
 * CHISMOSO V1.0 — Agent Mesh (Task EXP-2)
 *
 * A SIMPLE outbox + inbox pattern layered on top of the existing SQLite
 * database. No external broker is required.
 *
 *   ┌──────────────┐   publishOpportunity   ┌──────────────┐
 *   │ Orchestrator │ ─────────────────────▶ │  mesh_outbox │
 *   └──────────────┘                        └──────┬───────┘
 *                                                  │ deliverPending
 *                                                  ▼
 *                                          ┌──────────────┐  POST webhook
 *                                          │  Subscriber  │ ────────────▶ AGENTE-LEADS
 *                                          └──────────────┘
 *   ┌──────────────┐  POST /api/mesh/external-signals
 *   │ External     │ ──────────────────────────────────▶ ┌──────────────────┐
 *   │ Agent        │                                       │ external_signals │
 *   │ (e.g. NEX)   │ ◀────────────── unconsumedSignals    └──────────────────┘
 *   └──────────────┘                                    (consumed by orchestrator)
 *
 * Publish: CHISMOSO writes an event to `mesh_outbox` for each Opportunity
 * it generates (target agent = opportunity.suggestedNextAgent, typically
 * "AGENTE-LEADS").
 *
 * Consume: External agents can either poll `GET /api/mesh/events?agent=X`
 * (returns pending events and lets the client ACK them), or register a
 * webhook subscriber so CHISMOSO pushes events to them via `deliverPending`.
 *
 * External signals: External agents POST signals (e.g. "youtube_growth
 * detected for topic X") to `/api/mesh/external-signals`; they land in
 * `external_signals`. The orchestrator (or scheduler) can pick them up via
 * `unconsumedExternalSignals()` on its next run.
 */

import type { Opportunity } from '../models.js';
import { generateId, nowISO } from '../models.js';
import { logger } from '../logger.js';
import { MeshDB, DEFAULT_MESH_DB_PATH } from './db.js';
import { deliverWebhook } from './webhook.js';

// ---------------------------------------------------------------------------
// PUBLIC TYPES
// ---------------------------------------------------------------------------

export interface MeshConfigSubscriber {
  agentName: string;
  webhookUrl: string;
  secret?: string;
  eventsFilter?: string[];
}

export interface MeshConfig {
  enabled: boolean;
  subscribers: MeshConfigSubscriber[];
}

export interface OpportunityEvent {
  id: string;
  opportunityId: string;
  agentTarget: string;
  payload: any;
  createdAt: string;
  deliveredAt?: string;
}

export interface ExternalSignalEvent {
  id: string;
  sourceAgent: string;
  signalType: string;
  payload: any;
  receivedAt: string;
  consumedAt?: string;
}

export interface DeliveryStats {
  attempted: number;
  delivered: number;
  failed: number;
}

// ---------------------------------------------------------------------------
// AGENT MESH
// ---------------------------------------------------------------------------

export class AgentMesh {
  private db: MeshDB;

  constructor(private dbPath: string = DEFAULT_MESH_DB_PATH) {
    this.db = new MeshDB(dbPath);
    // Ensure default config exists (enabled=false by default — explicit opt-in).
    if (!this.getMeta('enabled')) {
      this.setMeta('enabled', 'false');
    }
  }

  // -------------------------------------------------------------------------
  // OUTBOX: publish / pending / ack / deliver
  // -------------------------------------------------------------------------

  /**
   * Publish an opportunity to the mesh outbox. The event's `agentTarget`
   * is taken from `opportunity.suggestedNextAgent` (typically "AGENTE-LEADS").
   * Returns the event id.
   *
   * Idempotency: if an event already exists for (opportunityId, agentTarget),
   * no new row is inserted (we silently return the existing id). This lets
   * `autoPublishOpportunities` be called multiple times safely.
   */
  publishOpportunity(opportunity: Opportunity): string {
    const agentTarget = opportunity.suggestedNextAgent || 'AGENTE-LEADS';
    const existing = this.db
      .prepare('SELECT id FROM mesh_outbox WHERE opportunity_id = ? AND agent_target = ?')
      .get(opportunity.id, agentTarget) as { id: string } | undefined;
    if (existing) {
      return existing.id;
    }
    const id = generateId('mesh_evt');
    const now = nowISO();
    const payload = {
      event: 'opportunity',
      opportunity: {
        id: opportunity.id,
        title: opportunity.title,
        description: opportunity.description,
        problem: opportunity.problem,
        targetSegment: opportunity.targetSegment,
        geography: opportunity.geography,
        demand: opportunity.demand,
        growth: opportunity.growth,
        problemSeverity: opportunity.problemSeverity,
        monetization: opportunity.monetization,
        timing: opportunity.timing,
        marketFit: opportunity.marketFit,
        competition: opportunity.competition,
        uncertainty: opportunity.uncertainty,
        score: opportunity.score,
        scoreBreakdown: opportunity.scoreBreakdown,
        confidence: opportunity.confidence,
        suggestedNextAgent: opportunity.suggestedNextAgent,
        trendRef: opportunity.trendRef,
        createdAt: opportunity.createdAt,
      },
      publishedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO mesh_outbox (id, opportunity_id, agent_target, payload_json, created_at, delivery_attempts)
         VALUES (?, ?, ?, ?, ?, 0)`,
      )
      .run(id, opportunity.id, agentTarget, JSON.stringify(payload), now);
    logger.info('Mesh event published', { id, opportunityId: opportunity.id, agentTarget });
    return id;
  }

  /**
   * Returns up to `limit` pending (undelivered) events for `agentName`.
   * Does NOT mark them as delivered — the caller must call `ack(ids)` once
   * it has processed them. This is the polling-consume pattern.
   */
  pendingFor(agentName: string, limit = 50): OpportunityEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM mesh_outbox
         WHERE agent_target = ? AND delivered_at IS NULL
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(agentName, limit) as any[];
    return rows.map(parseOpportunityEventRow);
  }

  /**
   * Marks the given event ids as delivered. Returns the count actually
   * updated (rows that existed and were pending).
   */
  ack(ids: string[]): number {
    if (ids.length === 0) return 0;
    const now = nowISO();
    const stmt = this.db.prepare(
      `UPDATE mesh_outbox SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL`,
    );
    const tx = this.db.transaction(() => {
      let updated = 0;
      for (const id of ids) {
        const r = stmt.run(now, id);
        if (r.changes > 0) updated++;
      }
      return updated;
    });
    return tx();
  }

  /**
   * Attempts webhook delivery for ALL pending events whose target agent has
   * an active subscriber. Returns aggregate stats.
   *
   * On success: `delivered_at` is set, `delivery_attempts` is incremented.
   * On failure: `delivery_attempts` is incremented, `last_error` is set
   * (we do NOT give up — the next call will retry; subscribers can also
   * ACK events manually via the REST API).
   */
  async deliverPending(): Promise<DeliveryStats> {
    const subscribers = this.listActiveSubscribers();
    if (subscribers.length === 0) {
      return { attempted: 0, delivered: 0, failed: 0 };
    }
    const byAgent = new Map<string, MeshConfigSubscriber>();
    for (const s of subscribers) byAgent.set(s.agentName, s);

    const pending = this.db
      .prepare(
        `SELECT * FROM mesh_outbox WHERE delivered_at IS NULL ORDER BY created_at ASC LIMIT 200`,
      )
      .all() as any[];

    let attempted = 0;
    let delivered = 0;
    let failed = 0;
    for (const row of pending) {
      const sub = byAgent.get(row.agent_target);
      if (!sub) continue; // no subscriber for this agent — skip
      attempted++;
      let payload: any;
      try {
        payload = JSON.parse(row.payload_json);
      } catch (e: any) {
        failed++;
        this.recordDeliveryFailure(row.id, `payload_parse_failed: ${e?.message ?? e}`);
        continue;
      }
      const result = await deliverWebhook({
        url: sub.webhookUrl,
        secret: sub.secret,
        payload,
      });
      if (result.ok) {
        delivered++;
        this.db
          .prepare(
            `UPDATE mesh_outbox
             SET delivered_at = ?, delivery_attempts = delivery_attempts + 1, last_error = NULL
             WHERE id = ?`,
          )
          .run(nowISO(), row.id);
      } else {
        failed++;
        this.recordDeliveryFailure(row.id, result.error ?? 'unknown_error');
      }
    }
    logger.info('Mesh delivery sweep done', { attempted, delivered, failed });
    return { attempted, delivered, failed };
  }

  private recordDeliveryFailure(id: string, error: string): void {
    this.db
      .prepare(
        `UPDATE mesh_outbox
         SET delivery_attempts = delivery_attempts + 1, last_error = ?
         WHERE id = ?`,
      )
      .run(error.slice(0, 500), id);
  }

  // -------------------------------------------------------------------------
  // INBOX: external signals
  // -------------------------------------------------------------------------

  /**
   * Ingests an external signal into the inbox. Returns the new signal id.
   */
  ingestExternalSignal(sourceAgent: string, signalType: string, payload: any): string {
    const id = generateId('mesh_sig');
    const now = nowISO();
    this.db
      .prepare(
        `INSERT INTO external_signals (id, source_agent, signal_type, payload_json, received_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, sourceAgent, signalType, JSON.stringify(payload ?? {}), now);
    logger.info('External signal ingested', { id, sourceAgent, signalType });
    return id;
  }

  /**
   * Returns up to `limit` unconsumed external signals (oldest first).
   * Does NOT mark them consumed — caller must call `markConsumed(id)`.
   */
  unconsumedExternalSignals(limit = 50): ExternalSignalEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM external_signals
         WHERE consumed_at IS NULL
         ORDER BY received_at ASC
         LIMIT ?`,
      )
      .all(limit) as any[];
    return rows.map(parseExternalSignalRow);
  }

  /**
   * Returns ALL external signals (including consumed ones) for debugging.
   */
  listExternalSignals(limit = 50): ExternalSignalEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM external_signals ORDER BY received_at DESC LIMIT ?`,
      )
      .all(limit) as any[];
    return rows.map(parseExternalSignalRow);
  }

  markConsumed(signalId: string): void {
    this.db
      .prepare(`UPDATE external_signals SET consumed_at = ? WHERE id = ?`)
      .run(nowISO(), signalId);
  }

  // -------------------------------------------------------------------------
  // SUBSCRIBERS
  // -------------------------------------------------------------------------

  listSubscribers(): MeshConfigSubscriber[] {
    const rows = this.db
      .prepare(`SELECT * FROM mesh_subscribers ORDER BY created_at ASC`)
      .all() as any[];
    return rows.map(parseSubscriberRow);
  }

  listActiveSubscribers(): MeshConfigSubscriber[] {
    const rows = this.db
      .prepare(`SELECT * FROM mesh_subscribers WHERE active = 1 ORDER BY created_at ASC`)
      .all() as any[];
    return rows.map(parseSubscriberRow);
  }

  upsertSubscriber(sub: MeshConfigSubscriber): void {
    const id = generateId('mesh_sub');
    const eventsFilter = sub.eventsFilter ? JSON.stringify(sub.eventsFilter) : null;
    this.db
      .prepare(
        `INSERT INTO mesh_subscribers (id, agent_name, webhook_url, secret, events_filter, active, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(agent_name) DO UPDATE SET
           webhook_url = excluded.webhook_url,
           secret = excluded.secret,
           events_filter = excluded.events_filter,
           active = 1`,
      )
      .run(id, sub.agentName, sub.webhookUrl, sub.secret ?? null, eventsFilter, nowISO());
  }

  removeSubscriber(agentName: string): boolean {
    const r = this.db
      .prepare(`DELETE FROM mesh_subscribers WHERE agent_name = ?`)
      .run(agentName);
    return r.changes > 0;
  }

  // -------------------------------------------------------------------------
  // CONFIG (mesh_meta)
  // -------------------------------------------------------------------------

  getConfig(): MeshConfig {
    const enabled = this.getMeta('enabled') === 'true';
    const subscribers = this.listSubscribers();
    return { enabled, subscribers };
  }

  setConfig(cfg: MeshConfig): void {
    this.setMeta('enabled', cfg.enabled ? 'true' : 'false');
    // Replace all subscribers atomically.
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM mesh_subscribers`).run();
      for (const s of cfg.subscribers ?? []) {
        const id = generateId('mesh_sub');
        const eventsFilter = s.eventsFilter ? JSON.stringify(s.eventsFilter) : null;
        this.db
          .prepare(
            `INSERT INTO mesh_subscribers (id, agent_name, webhook_url, secret, events_filter, active, created_at)
             VALUES (?, ?, ?, ?, ?, 1, ?)`,
          )
          .run(id, s.agentName, s.webhookUrl, s.secret ?? null, eventsFilter, nowISO());
      }
    });
    tx();
    logger.info('Mesh config updated', { enabled: cfg.enabled, subscribers: cfg.subscribers?.length ?? 0 });
  }

  // -------------------------------------------------------------------------
  // STATUS (used by `chismoso mesh status`)
  // -------------------------------------------------------------------------

  status(): {
    pendingOutbox: number;
    deliveredOutbox: number;
    unconsumedSignals: number;
    totalSignals: number;
    subscribers: number;
    activeSubscribers: number;
    enabled: boolean;
  } {
    const count = (sql: string): number => {
      const r = this.db.prepare(sql).get() as { c: number } | undefined;
      return r?.c ?? 0;
    };
    return {
      pendingOutbox: count(`SELECT COUNT(*) AS c FROM mesh_outbox WHERE delivered_at IS NULL`),
      deliveredOutbox: count(`SELECT COUNT(*) AS c FROM mesh_outbox WHERE delivered_at IS NOT NULL`),
      unconsumedSignals: count(`SELECT COUNT(*) AS c FROM external_signals WHERE consumed_at IS NULL`),
      totalSignals: count(`SELECT COUNT(*) AS c FROM external_signals`),
      subscribers: count(`SELECT COUNT(*) AS c FROM mesh_subscribers`),
      activeSubscribers: count(`SELECT COUNT(*) AS c FROM mesh_subscribers WHERE active = 1`),
      enabled: this.getMeta('enabled') === 'true',
    };
  }

  // -------------------------------------------------------------------------
  // LIFECYCLE
  // -------------------------------------------------------------------------

  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // mesh_meta helpers
  // -------------------------------------------------------------------------

  private getMeta(key: string): string | undefined {
    const r = this.db.prepare(`SELECT value FROM mesh_meta WHERE key = ?`).get(key) as { value: string } | undefined;
    return r?.value;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO mesh_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }
}

// ---------------------------------------------------------------------------
// ROW PARSERS
// ---------------------------------------------------------------------------

function parseOpportunityEventRow(r: any): OpportunityEvent {
  return {
    id: r.id,
    opportunityId: r.opportunity_id,
    agentTarget: r.agent_target,
    payload: r.payload_json ? JSON.parse(r.payload_json) : null,
    createdAt: r.created_at,
    deliveredAt: r.delivered_at ?? undefined,
  };
}

function parseExternalSignalRow(r: any): ExternalSignalEvent {
  return {
    id: r.id,
    sourceAgent: r.source_agent,
    signalType: r.signal_type,
    payload: r.payload_json ? JSON.parse(r.payload_json) : null,
    receivedAt: r.received_at,
    consumedAt: r.consumed_at ?? undefined,
  };
}

function parseSubscriberRow(r: any): MeshConfigSubscriber {
  return {
    agentName: r.agent_name,
    webhookUrl: r.webhook_url,
    secret: r.secret ?? undefined,
    eventsFilter: r.events_filter ? JSON.parse(r.events_filter) : undefined,
  };
}
