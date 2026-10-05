/**
 * CHISMOSO V1.0 — Mesh DB (Task EXP-2)
 *
 * Adds 4 new tables to the existing `data/chismoso.db` SQLite database via
 * a SEPARATE better-sqlite3 connection (we never touch `ChismosoDB` directly
 * — that class is owned by the foundation layer). All migrations are
 * idempotent (`CREATE TABLE IF NOT EXISTS`) so it's safe to call on every
 * boot.
 *
 * Tables:
 *   - mesh_outbox       : pending/delivered opportunity events (outbox pattern)
 *   - external_signals  : signals pushed by external agents (inbox pattern)
 *   - mesh_subscribers  : registered webhook subscribers (target agents)
 *   - mesh_meta         : key/value store for mesh config (enabled flag, etc.)
 */

import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../logger.js';

export const DEFAULT_MESH_DB_PATH = '/home/z/my-project/chismoso/data/chismoso.db';

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

/**
 * Open a SEPARATE better-sqlite3 connection to the CHISMOSO database and
 * ensure the mesh tables exist. Caller is responsible for `.close()`-ing
 * the returned handle (typically via `MeshDB.close()`).
 */
export class MeshDB {
  private db: DB;

  constructor(dbPath: string = DEFAULT_MESH_DB_PATH) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(MESH_SCHEMA);
    logger.info('MeshDB initialized', { path: dbPath });
  }

  prepare(sql: string): import('better-sqlite3').Statement {
    return this.db.prepare(sql);
  }

  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T {
    return this.db.transaction(fn);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // ignore close errors during teardown
    }
  }

  get raw(): DB {
    return this.db;
  }
}
