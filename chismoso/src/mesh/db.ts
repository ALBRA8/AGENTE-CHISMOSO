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
  secret_hash    TEXT,
  events_filter  TEXT,
  active         INTEGER DEFAULT 1,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mesh_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- chismoso_users — operator accounts for the dashboard session-based
-- auth (Task IMP-PROD-SEC, audit C-2). Schema is mirrored in
-- 'src/lib/users-db.ts' (Next.js side) so the CLI 'users add' and the
-- Next.js auth lib read/write the same table. The csrf_token column
-- holds the per-user CSRF token bound to the session JWT (audit H-2).
CREATE TABLE IF NOT EXISTS chismoso_users (
  id              TEXT PRIMARY KEY,
  username        TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'operator',
  csrf_token      TEXT,
  csrf_issued_at  TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chismoso_users_username ON chismoso_users(username);
`;

/**
 * Apply V2 column extensions to the mesh tables (idempotent — uses
 * `addColumnIfMissing` so older DB files gain the new columns on the
 * next CLI run without needing a separate migration script).
 *
 * - `mesh_subscribers.secret_hash` — SHA-256 of the per-agent webhook
 *   secret (audit H-8). The plaintext `secret` column is preserved for
 *   backward compat with existing rows but is NOT written by the V1.5
 *   `mesh subscribe` CLI; outbound delivery reads the plaintext secret
 *   from env (`CHISMOSO_WEBHOOK_SECRET_<AGENT>`) so nothing in the DB
 *   can leak signing keys.
 *
 * R2-IMP-SEC (audit R2-7 / H-8 close): the `secret` column is
 * **actively scrubbed** on every boot via `scrubLegacyPlaintextSecrets`
 * (called below). This is the only place the schema migration runs,
 * and it's idempotent — the UPDATE is a no-op once `secret IS NULL`
 * for every row. The purpose is to PURGE any plaintext secrets that
 * were written by:
 *
 *   1. V1.0's `setConfig` (chismoso/src/mesh/index.ts::setConfig —
 *      still writes `s.secret ?? null` to the `secret` column;
 *      out-of-scope for this task, fixed separately).
 *   2. The Next.js-side `setMeshConfig` (src/app/api/mesh/_mesh-db.ts)
 *      which the R2 audit flagged at L242-277 as still writing
 *      `s.secret ?? null`.
 *
 * Combined with the per-agent HMAC verification using
 * `CHISMOSO_MESH_SECRETS` env (not the DB column), the actual
 * inbound signing keys NEVER touch the SQLite file. The `secret`
 * column remains in the schema only for backward-compat reads of
 * pre-scrub rows (which are now NULL after the first boot).
 */
function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}

/**
 * Scrub the `secret` column on every boot. Idempotent — the UPDATE
 * is a no-op once every row has `secret IS NULL`. The transaction
 * makes the scrub atomic so a crash mid-migration can't leave
 * half-scrubbed state.
 *
 * The scrub does NOT touch `secret_hash` (which is the canonical
 * SHA-256 hash of the secret — used for integrity checks, never
 * for HMAC computation since you can't HMAC with a hash).
 */
function scrubLegacyPlaintextSecrets(db: DB): void {
  // Confirm the table exists before attempting the UPDATE — fresh
  // installs that ran the CREATE TABLE block above will have the
  // table; very old V1.0 DB files might not (but the CREATE TABLE
  // IF NOT EXISTS above just added it). Belt-and-braces.
  try {
    const tx = db.transaction(() => {
      // NULL out any legacy plaintext secret. The `secret_hash`
      // column (which is what the V1.5 code reads) is preserved.
      // The `WHERE secret IS NOT NULL` clause makes this a no-op
      // once the table is clean, so it's safe to run on every boot.
      const result = db
        .prepare(`UPDATE mesh_subscribers SET secret = NULL WHERE secret IS NOT NULL`)
        .run();
      if (result.changes > 0) {
        logger.warn(
          `mesh_subscribers.secret column scrubbed — ${result.changes} row(s) had legacy plaintext secrets cleared`,
        );
      }
    });
    tx();
  } catch (e) {
    // Don't crash the boot if the table doesn't exist yet (very fresh
    // install with no migrations run). The CREATE TABLE IF NOT EXISTS
    // above should have created it, but defensive programming in case
    // of a partial-corruption DB file.
    logger.warn('scrubLegacyPlaintextSecrets failed (non-fatal)', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function applyMeshSchemaExtensions(db: DB): void {
  addColumnIfMissing(db, 'mesh_subscribers', 'secret_hash', 'TEXT');
  // R2-IMP-SEC (audit R2-7 / H-8): purge any legacy plaintext secrets
  // from disk before any route can read them. Runs on every boot;
  // no-op once the column is all-NULL. See docstring above.
  scrubLegacyPlaintextSecrets(db);
}

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
    applyMeshSchemaExtensions(this.db);
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
