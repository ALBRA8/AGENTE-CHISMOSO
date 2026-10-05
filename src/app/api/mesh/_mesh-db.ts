/**
 * Shared mesh SQLite helper for the Next.js API routes.
 *
 * We open a SEPARATE better-sqlite3 connection to the CHISMOSO database
 * (in WAL mode this is safe — SQLite supports concurrent readers/writers
 * across connections). All mesh tables live in the same DB file as the
 * rest of CHISMOSO; this helper ensures they exist (idempotent) before
 * the route handlers read/write them.
 *
 * The mesh protocol (publish/consume/ack/deliver logic) lives in the
 * CHISMOSO package; the Next.js routes are THIN HTTP wrappers around
 * direct SQL — they DO NOT duplicate the publish/subscribe semantics,
 * they only expose the raw outbox/inbox tables for external agents
 * (which is what an external agent like AGENTE-LEADS would consume).
 */

import Database from 'better-sqlite3';

const MESH_DB_PATH = '/home/z/my-project/chismoso/data/chismoso.db';

const MESH_SCHEMA = `
CREATE TABLE IF NOT EXISTS mesh_outbox (
  id                  TEXT PRIMARY KEY,
  opportunity_id      TEXT NOT NULL,
  agent_target        TEXT NOT NULL,
  payload_json        TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  delivered_at        TEXT,
  delivery_attempts   INTEGER DEFAULT 0,
  last_error          TEXT
);
CREATE INDEX IF NOT EXISTS idx_mesh_outbox_agent_delivered ON mesh_outbox(agent_target, delivered_at);
CREATE INDEX IF NOT EXISTS idx_mesh_outbox_created ON mesh_outbox(created_at);

CREATE TABLE IF NOT EXISTS external_signals (
  id            TEXT PRIMARY KEY,
  source_agent  TEXT NOT NULL,
  signal_type   TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  received_at   TEXT NOT NULL,
  consumed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_external_signals_consumed ON external_signals(consumed_at);
CREATE INDEX IF NOT EXISTS idx_external_signals_received ON external_signals(received_at);

CREATE TABLE IF NOT EXISTS mesh_subscribers (
  id             TEXT PRIMARY KEY,
  agent_name     TEXT NOT NULL UNIQUE,
  webhook_url    TEXT NOT NULL,
  secret         TEXT,
  events_filter  TEXT,
  active         INTEGER DEFAULT 1,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mesh_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export interface MeshOpportunityEvent {
  id: string;
  opportunity_id: string;
  agent_target: string;
  payload: any;
  created_at: string;
  delivered_at?: string | null;
  delivery_attempts?: number;
  last_error?: string | null;
}

export interface MeshExternalSignal {
  id: string;
  source_agent: string;
  signal_type: string;
  payload: any;
  received_at: string;
  consumed_at?: string | null;
}

export interface MeshSubscriberRow {
  agent_name: string;
  webhook_url: string;
  secret?: string | null;
  events_filter?: string | null;
  active: number;
}

export interface MeshStatus {
  pending_outbox: number;
  delivered_outbox: number;
  unconsumed_signals: number;
  total_signals: number;
  subscribers: number;
  active_subscribers: number;
  enabled: boolean;
}

/**
 * Open a connection to the CHISMOSO DB with the mesh tables ensured.
 * Caller MUST call `db.close()` (typically in a `finally` block).
 */
export function openMeshDb(): Database.Database {
  const db = new Database(MESH_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(MESH_SCHEMA);
  return db;
}

export function generateId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${ts}${rnd}`;
}

// ---------------------------------------------------------------------------
// Outbox operations
// ---------------------------------------------------------------------------

export function fetchPendingEvents(
  db: Database.Database,
  agentName: string,
  limit: number,
): MeshOpportunityEvent[] {
  const rows = db
    .prepare(
      `SELECT * FROM mesh_outbox
       WHERE agent_target = ? AND delivered_at IS NULL
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(agentName, limit) as any[];
  return rows.map(parseOpportunityEventRow);
}

export function ackEvents(db: Database.Database, ids: string[]): number {
  if (ids.length === 0) return 0;
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `UPDATE mesh_outbox SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL`,
  );
  let updated = 0;
  const tx = db.transaction(() => {
    for (const id of ids) {
      const r = stmt.run(now, id);
      if (r.changes > 0) updated++;
    }
  });
  tx();
  return updated;
}

// ---------------------------------------------------------------------------
// External signals operations
// ---------------------------------------------------------------------------

export function ingestExternalSignal(
  db: Database.Database,
  sourceAgent: string,
  signalType: string,
  payload: unknown,
): { id: string; received_at: string } {
  const id = generateId('mesh_sig');
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO external_signals (id, source_agent, signal_type, payload_json, received_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, sourceAgent, signalType, JSON.stringify(payload ?? {}), now);
  return { id, received_at: now };
}

export function fetchExternalSignals(
  db: Database.Database,
  limit: number,
  unconsumedOnly: boolean,
): MeshExternalSignal[] {
  const sql = unconsumedOnly
    ? `SELECT * FROM external_signals WHERE consumed_at IS NULL ORDER BY received_at ASC LIMIT ?`
    : `SELECT * FROM external_signals ORDER BY received_at DESC LIMIT ?`;
  const rows = db.prepare(sql).all(limit) as any[];
  return rows.map(parseExternalSignalRow);
}

// ---------------------------------------------------------------------------
// Subscribers + config
// ---------------------------------------------------------------------------

export function listSubscribers(db: Database.Database): MeshSubscriberRow[] {
  return db
    .prepare(`SELECT * FROM mesh_subscribers ORDER BY created_at ASC`)
    .all() as MeshSubscriberRow[];
}

export function getMeshConfig(db: Database.Database): {
  enabled: boolean;
  subscribers: Array<{
    agentName: string;
    webhookUrl: string;
    secret?: string;
    eventsFilter?: string[];
    active: boolean;
  }>;
} {
  const row = db.prepare(`SELECT value FROM mesh_meta WHERE key = ?`).get('enabled') as
    | { value: string }
    | undefined;
  const enabled = row?.value === 'true';
  const subs = listSubscribers(db);
  return {
    enabled,
    subscribers: subs.map((s) => ({
      agentName: s.agent_name,
      webhookUrl: s.webhook_url,
      secret: s.secret ?? undefined,
      eventsFilter: s.events_filter ? JSON.parse(s.events_filter) : undefined,
      active: s.active === 1,
    })),
  };
}

export function setMeshConfig(
  db: Database.Database,
  enabled: boolean,
  subscribers: Array<{
    agentName: string;
    webhookUrl: string;
    secret?: string;
    eventsFilter?: string[];
  }>,
): void {
  db.prepare(
    `INSERT INTO mesh_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run('enabled', enabled ? 'true' : 'false');

  // Replace all subscribers atomically.
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM mesh_subscribers`).run();
    const now = new Date().toISOString();
    const stmt = db.prepare(
      `INSERT INTO mesh_subscribers (id, agent_name, webhook_url, secret, events_filter, active, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    );
    for (const s of subscribers) {
      stmt.run(
        generateId('mesh_sub'),
        s.agentName,
        s.webhookUrl,
        s.secret ?? null,
        s.eventsFilter ? JSON.stringify(s.eventsFilter) : null,
        now,
      );
    }
  });
  tx();
}

export function getMeshStatus(db: Database.Database): MeshStatus {
  const count = (sql: string): number => {
    const r = db.prepare(sql).get() as { c: number } | undefined;
    return r?.c ?? 0;
  };
  const cfg = getMeshConfig(db);
  return {
    pending_outbox: count(`SELECT COUNT(*) AS c FROM mesh_outbox WHERE delivered_at IS NULL`),
    delivered_outbox: count(`SELECT COUNT(*) AS c FROM mesh_outbox WHERE delivered_at IS NOT NULL`),
    unconsumed_signals: count(`SELECT COUNT(*) AS c FROM external_signals WHERE consumed_at IS NULL`),
    total_signals: count(`SELECT COUNT(*) AS c FROM external_signals`),
    subscribers: count(`SELECT COUNT(*) AS c FROM mesh_subscribers`),
    active_subscribers: count(`SELECT COUNT(*) AS c FROM mesh_subscribers WHERE active = 1`),
    enabled: cfg.enabled,
  };
}

// ---------------------------------------------------------------------------
// Row parsers
// ---------------------------------------------------------------------------

function parseOpportunityEventRow(r: any): MeshOpportunityEvent {
  return {
    id: r.id,
    opportunity_id: r.opportunity_id,
    agent_target: r.agent_target,
    payload: r.payload_json ? JSON.parse(r.payload_json) : null,
    created_at: r.created_at,
    delivered_at: r.delivered_at ?? null,
    delivery_attempts: r.delivery_attempts,
    last_error: r.last_error,
  };
}

function parseExternalSignalRow(r: any): MeshExternalSignal {
  return {
    id: r.id,
    source_agent: r.source_agent,
    signal_type: r.signal_type,
    payload: r.payload_json ? JSON.parse(r.payload_json) : null,
    received_at: r.received_at,
    consumed_at: r.consumed_at ?? null,
  };
}
