/**
 * Shared mesh SQLite helper for the Next.js API routes.
 *
 * FIX-2 (AUDIT-PERF Critical #2 + Bonus): previously every mesh route
 * (`/api/mesh/config`, `/api/mesh/events`, `/api/mesh/external-signals`)
 * called `openMeshDb()` which instantiated a fresh `MeshDB` per request,
 * costing ~10–50ms per connection open. Now we expose a single process-wide
 * `Database` instance.
 *
 * The mesh route handlers all call `db.close()` in a `finally` block. To
 * keep them as drop-in callers without modification, we override `close`
 * on the singleton instance so it becomes a no-op — the connection lives
 * for the lifetime of the Next.js process.
 *
 * Bonus fix (AUDIT-PERF Bonus): mkdirSync the parent directory before
 * opening the connection, so `/api/mesh/config` no longer 500s on a
 * fresh install where `chismoso/data/` doesn't exist yet.
 *
 * The canonical `MeshDB` class (which sets up the 4 mesh tables + WAL)
 * is imported from the precompiled `chismoso/dist/mesh/db.js`. Its
 * constructor already does `mkdirSync`, but we replicate it here as
 * defense in depth — if a future refactor changes the chismoso MeshDB
 * to skip mkdirSync, this side still works.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
// Import the canonical MeshDB (compiled JS + sibling .d.ts map).
// Path is relative to this file: src/app/api/mesh/_mesh-db.ts
//   → ../../../../chismoso/dist/mesh/db.js
import { MeshDB, DEFAULT_MESH_DB_PATH } from '../../../../chismoso/dist/mesh/db.js';
// Silence chismoso's structured logger on every request — MeshDB's constructor
// logs an INFO line on each instantiation, which is too noisy for a per-request
// helper. This is a global change but safe: chismoso code does not run
// independently inside the Next.js process.
import { logger as chismosoLogger, LogLevel } from '../../../../chismoso/dist/logger.js';
chismosoLogger.setLevel(LogLevel.WARN);

// Re-export so callers don't hardcode the path.
export { DEFAULT_MESH_DB_PATH };

// ---------------------------------------------------------------------------
// Singleton Database — survives HMR, never closed
// ---------------------------------------------------------------------------

// Ensure parent dir exists before opening — fixes the 500 on /api/mesh/config
// when chismoso hasn't been run yet.
mkdirSync(dirname(DEFAULT_MESH_DB_PATH), { recursive: true });

// Use globalThis to survive Next.js HMR in dev (a fresh module graph would
// otherwise re-instantiate MeshDB and leak file descriptors).
const globalForMeshDb = globalThis as unknown as {
  __meshDb?: Database.Database;
};

function createMeshDb(): Database.Database {
  const meshDb = new MeshDB(DEFAULT_MESH_DB_PATH);
  const raw = meshDb.raw;
  // Override `close` on the instance so route handlers that call
  // `db.close()` in a `finally` block don't kill the singleton. This is
  // safe because:
  //   - `close` is on Database.prototype; assigning an own property on the
  //     instance shadows it.
  //   - better-sqlite3's Database is a normal JS class — instance own
  //     properties work as expected.
  (raw as unknown as { close: () => void }).close = () => {
    /* no-op — singleton lives for the process lifetime */
  };
  return raw;
}

const meshDbSingleton: Database.Database =
  globalForMeshDb.__meshDb ?? createMeshDb();

if (process.env.NODE_ENV !== 'production') {
  globalForMeshDb.__meshDb = meshDbSingleton;
}

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
 * Return the shared mesh DB connection (singleton). The returned object's
 * `close()` method is a no-op, so callers that follow the standard
 * `try { db = openMeshDb(); ... } finally { db.close(); }` pattern will
 * NOT close the shared connection.
 *
 * Implementation note: we instantiate a chismoso `MeshDB` (which sets up
 * the schema + WAL pragma) and return its raw `better-sqlite3` handle.
 */
export function openMeshDb(): Database.Database {
  return meshDbSingleton;
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
