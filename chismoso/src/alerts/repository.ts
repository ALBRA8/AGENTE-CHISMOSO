/**
 * CHISMOSO V1.0 — Alert repository (Task IMP-4, spec §20)
 *
 * Thin persistence layer over the `alerts` SQLite table. Serializes and
 * deserializes the `Alert` interface; the business logic (dedup, cooldown,
 * severity mapping) lives in `manager.ts`.
 *
 * The repository deliberately knows NOTHING about Anomalies — its contract
 * is "store and retrieve Alert rows". The AlertManager is the only caller
 * that constructs Alert objects.
 */

import type { ChismosoDB } from '../db.js';
import {
  AlertStatus,
  ACTIVE_STATUSES,
  type Alert,
  type AlertSeverity,
  type AlertPriority,
} from './models.js';

// ---------------------------------------------------------------------------
// ROW SHAPE (raw SQLite)
// ---------------------------------------------------------------------------

interface AlertRow {
  id: string;
  anomaly_id: string | null;
  topic: string;
  type: string;
  severity: string;
  priority: string;
  title: string;
  description: string | null;
  recommended_action: string | null;
  evidence_summary: string | null;
  confidence: number | null;
  zscore: number | null;
  detected_at: string;
  sent_at: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  status: string;
  dedup_key: string;
  cooldown_until: string | null;
  related_investigation_id: string | null;
  metadata_json: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// REPOSITORY
// ---------------------------------------------------------------------------

export class AlertRepository {
  constructor(private db: ChismosoDB) {}

  // -------------------------------------------------------------------------
  // WRITES
  // -------------------------------------------------------------------------

  /**
   * Insert a new Alert row. The `id` and `created_at` are auto-populated
   * if not already set on the input.
   *
   * Returns the fully-hydrated Alert as it now exists in the DB.
   */
  insert(alert: Omit<Alert, 'created_at'> & { created_at?: string }): Alert {
    const now = new Date().toISOString();
    const createdAt = alert.created_at ?? now;
    const metadataJson = alert.metadata ? JSON.stringify(alert.metadata) : null;

    this.db.prepare(`
      INSERT INTO alerts (
        id, anomaly_id, topic, type, severity, priority,
        title, description, recommended_action, evidence_summary,
        confidence, zscore, detected_at, sent_at,
        acknowledged_at, acknowledged_by, resolved_at, resolution_note,
        status, dedup_key, cooldown_until, related_investigation_id,
        metadata_json, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      alert.id,
      alert.anomaly_id ?? null,
      alert.topic,
      alert.type,
      alert.severity,
      alert.priority,
      alert.title,
      alert.description ?? null,
      alert.recommended_action ?? null,
      alert.evidence_summary ?? null,
      alert.confidence ?? null,
      alert.zscore ?? null,
      alert.detected_at,
      alert.sent_at ?? null,
      alert.acknowledged_at ?? null,
      alert.acknowledged_by ?? null,
      alert.resolved_at ?? null,
      alert.resolution_note ?? null,
      alert.status,
      alert.dedup_key,
      alert.cooldown_until ?? null,
      alert.related_investigation_id ?? null,
      metadataJson,
      createdAt,
    );

    return this.findById(alert.id)!;
  }

  /**
   * Generic status update. `extra` may include any subset of Alert fields
   * that should be updated alongside the status (e.g. `sent_at`, `resolved_at`).
   */
  updateStatus(id: string, status: AlertStatus, extra: Partial<Alert> = {}): void {
    const sets: string[] = ['status = ?'];
    const vals: (string | number | null)[] = [status];

    const fieldMap: Record<string, string> = {
      sent_at: 'sent_at',
      acknowledged_at: 'acknowledged_at',
      acknowledged_by: 'acknowledged_by',
      resolved_at: 'resolved_at',
      resolution_note: 'resolution_note',
      severity: 'severity',
      priority: 'priority',
      title: 'title',
      description: 'description',
      recommended_action: 'recommended_action',
      evidence_summary: 'evidence_summary',
      confidence: 'confidence',
      zscore: 'zscore',
      cooldown_until: 'cooldown_until',
      related_investigation_id: 'related_investigation_id',
    };

    for (const [k, v] of Object.entries(extra)) {
      const column = fieldMap[k];
      if (!column) continue; // ignore unknown fields defensively
      sets.push(`${column} = ?`);
      vals.push(v as string | number | null);
    }

    sets.push('created_at = created_at'); // no-op to keep trailing comma clean
    vals.push(id);

    this.db.prepare(`UPDATE alerts SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  /**
   * Mark an alert as ACKNOWLEDGED. Sets `acknowledged_at` and `acknowledged_by`.
   * If the alert is already ACKNOWLEDGED, this is a no-op (idempotent).
   */
  acknowledge(id: string, by: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE alerts
      SET status = ?,
          acknowledged_at = ?,
          acknowledged_by = ?
      WHERE id = ?
    `).run(AlertStatus.ACKNOWLEDGED, now, by, id);
  }

  /**
   * Mark an alert as RESOLVED. Sets `resolved_at` and `resolution_note`.
   * Idempotent: re-resolving updates the note + timestamp.
   */
  resolve(id: string, note: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE alerts
      SET status = ?,
          resolved_at = ?,
          resolution_note = ?
      WHERE id = ?
    `).run(AlertStatus.RESOLVED, now, note, id);
  }

  // -------------------------------------------------------------------------
  // READS
  // -------------------------------------------------------------------------

  /** Find a single alert by primary key. */
  findById(id: string): Alert | null {
    const row = this.db.prepare('SELECT * FROM alerts WHERE id = ?').get(id) as AlertRow | undefined;
    return row ? parseAlertRow(row) : null;
  }

  /**
   * Find the most recent alert with the given dedup_key. Used by the
   * AlertManager to check cooldown before emitting a new alert.
   *
   * "Most recent" = the row with the largest `created_at` (creation time,
   * not detection time — created_at is unique per emit).
   */
  findByDedupKey(key: string): Alert | null {
    const row = this.db
      .prepare('SELECT * FROM alerts WHERE dedup_key = ? ORDER BY created_at DESC, id DESC LIMIT 1')
      .get(key) as AlertRow | undefined;
    return row ? parseAlertRow(row) : null;
  }

  /** All alerts whose status is in (DETECTED, SENT, ACKNOWLEDGED). */
  findActive(): Alert[] {
    const placeholders = ACTIVE_STATUSES.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM alerts WHERE status IN (${placeholders}) ORDER BY detected_at DESC`)
      .all(...ACTIVE_STATUSES) as AlertRow[];
    return rows.map(parseAlertRow);
  }

  /** All alerts in a specific status. */
  findByStatus(status: AlertStatus): Alert[] {
    const rows = this.db
      .prepare('SELECT * FROM alerts WHERE status = ? ORDER BY detected_at DESC')
      .all(status) as AlertRow[];
    return rows.map(parseAlertRow);
  }

  /** All alerts for a given topic, most recent first. */
  findByTopic(topic: string): Alert[] {
    const rows = this.db
      .prepare('SELECT * FROM alerts WHERE topic = ? ORDER BY detected_at DESC')
      .all(topic) as AlertRow[];
    return rows.map(parseAlertRow);
  }

  /** N most recent alerts across all topics/statuses. */
  listRecent(limit: number): Alert[] {
    const rows = this.db
      .prepare('SELECT * FROM alerts ORDER BY detected_at DESC, created_at DESC LIMIT ?')
      .all(limit) as AlertRow[];
    return rows.map(parseAlertRow);
  }

  /**
   * Filtered list. Any of `status`, `priority`, `topic` may be undefined
   * (= no filter). Always sorted by detected_at DESC.
   */
  list(opts: {
    status?: AlertStatus;
    priority?: AlertPriority;
    topic?: string;
    severity?: AlertSeverity;
    limit?: number;
  }): Alert[] {
    const where: string[] = [];
    const vals: (string | number)[] = [];
    if (opts.status) {
      where.push('status = ?');
      vals.push(opts.status);
    }
    if (opts.priority) {
      where.push('priority = ?');
      vals.push(opts.priority);
    }
    if (opts.severity) {
      where.push('severity = ?');
      vals.push(opts.severity);
    }
    if (opts.topic) {
      where.push('topic = ?');
      vals.push(opts.topic);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = opts.limit ?? 100;
    const rows = this.db
      .prepare(`SELECT * FROM alerts ${whereSql} ORDER BY detected_at DESC, created_at DESC LIMIT ?`)
      .all(...vals, limit) as AlertRow[];
    return rows.map(parseAlertRow);
  }

  /**
   * Aggregate counts grouped by status / severity / priority. Used by the
   * CLI `chismoso alerts stats` command.
   */
  stats(): {
    byStatus: Record<string, number>;
    bySeverity: Record<string, number>;
    byPriority: Record<string, number>;
    total: number;
  } {
    const byStatus: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    const byPriority: Record<string, number> = {};
    let total = 0;
    for (const s of Object.values(AlertStatus)) byStatus[s] = 0;
    for (const s of ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']) bySeverity[s] = 0;
    for (const p of ['P1', 'P2', 'P3', 'P4']) byPriority[p] = 0;

    const rows = this.db
      .prepare('SELECT status, severity, priority FROM alerts')
      .all() as Array<{ status: string; severity: string; priority: string }>;
    for (const r of rows) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      bySeverity[r.severity] = (bySeverity[r.severity] ?? 0) + 1;
      byPriority[r.priority] = (byPriority[r.priority] ?? 0) + 1;
      total++;
    }
    return { byStatus, bySeverity, byPriority, total };
  }
}

// ---------------------------------------------------------------------------
// ROW → MODEL PARSER
// ---------------------------------------------------------------------------

function parseAlertRow(r: AlertRow): Alert {
  return {
    id: r.id,
    anomaly_id: r.anomaly_id ?? undefined,
    topic: r.topic,
    type: r.type,
    severity: r.severity as AlertSeverity,
    priority: r.priority as AlertPriority,
    title: r.title,
    description: r.description ?? '',
    recommended_action: r.recommended_action ?? '',
    evidence_summary: r.evidence_summary ?? '',
    confidence: r.confidence ?? 0,
    zscore: r.zscore ?? undefined,
    detected_at: r.detected_at,
    sent_at: r.sent_at ?? undefined,
    acknowledged_at: r.acknowledged_at ?? undefined,
    acknowledged_by: r.acknowledged_by ?? undefined,
    resolved_at: r.resolved_at ?? undefined,
    resolution_note: r.resolution_note ?? undefined,
    status: r.status as AlertStatus,
    dedup_key: r.dedup_key,
    cooldown_until: r.cooldown_until ?? undefined,
    related_investigation_id: r.related_investigation_id ?? undefined,
    metadata: r.metadata_json ? safeParse(r.metadata_json) : undefined,
    created_at: r.created_at,
  };
}

function safeParse(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}
