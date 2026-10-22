/**
 * CHISMOSO V1.0 — Writable SQLite connection for the alerts subsystem
 * (Task IMP-4, spec §20).
 *
 * The main reader (`./db-chismoso.ts`) opens the chismoso DB in READONLY
 * mode so the dashboard can never accidentally mutate core tables. Alerts
 * — which are derived from anomalies and have a managed lifecycle —
 * need WRITE access: every detected anomaly emits an Alert row, and
 * users ack/resolve via POST.
 *
 * This module creates a separate, process-wide writable singleton on the
 * SAME SQLite file. SQLite supports multiple connections to the same file
 * (WAL mode enables concurrent readers + 1 writer). The chismoso CLI
 * already runs `PRAGMA journal_mode=WAL`, so concurrent reads from the
 * readonly singleton and writes from this writer are safe.
 *
 * Schema bootstrap
 * ---
 * The writer ALSO ensures the `alerts` table exists. This is necessary
 * because the chismoso CLI may not have run yet when the Next.js process
 * first boots — without this, the first /api/alerts call would 500 with
 * "no such table: alerts". `CREATE TABLE IF NOT EXISTS` is idempotent and
 * matches the SCHEMA_V4 constant in `chismoso/src/db.ts` exactly.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const DB_PATH =
  process.env.CHISMOSO_DB_PATH ?? '/home/z/my-project/chismoso/data/chismoso.db';

mkdirSync(path.dirname(DB_PATH), { recursive: true });

const globalForWritableDb = globalThis as unknown as {
  __chismosoWritableDb?: Database.Database;
};

export const chismosoWritableDb: Database.Database =
  globalForWritableDb.__chismosoWritableDb ?? new Database(DB_PATH);

if (process.env.NODE_ENV !== 'production') {
  globalForWritableDb.__chismosoWritableDb = chismosoWritableDb;
}

// REL2-P0-2 — Apply the SAME WAL/concurrency pragmas as
// `chismoso/src/db.ts` so concurrent writes from this writer + concurrent
// reads from `./db-chismoso.ts` (the readonly singleton) don't trip
// SQLITE_BUSY under load. Without `busy_timeout`, two investigations
// racing for the writer lock would synchronously crash the second one
// (better-sqlite3 throws SQLITE_BUSY immediately on lock contention
// when busy_timeout=0, the default).
//
// Order matters: `journal_mode=WAL` should be the FIRST pragma so the
// subsequent pragmas apply to the WAL-enabled DB. `wal_autocheckpoint`
// has no effect in rollback journal mode.
chismosoWritableDb.pragma('journal_mode = WAL');
chismosoWritableDb.pragma('foreign_keys = ON');
// Block up to 5s waiting for a writer lock instead of throwing
// SQLITE_BUSY synchronously — matches the CLI side's setup so both
// writer singletons behave identically under contention.
chismosoWritableDb.pragma('busy_timeout = 5000');
// synchronous=NORMAL is safe under WAL (the WAL itself is fsync'd on
// checkpoint) and ~10x faster than the default FULL.
chismosoWritableDb.pragma('synchronous = NORMAL');
// 64MB page cache — reduces disk I/O for hot reads/writes (alerts +
// audit_log are high-frequency tables under prod load). Default is 2MB.
chismosoWritableDb.pragma('cache_size = -64000');
// Auto-checkpoint the WAL every 1000 pages (~4MB) so we don't grow an
// unbounded WAL under burst write traffic.
chismosoWritableDb.pragma('wal_autocheckpoint = 1000');

// SCHEMA_V4 (alerts table) — identical to chismoso/src/db.ts.
// Idempotent. Safe to run on every cold start.
chismosoWritableDb.exec(`
  CREATE TABLE IF NOT EXISTS alerts (
    id                TEXT PRIMARY KEY,
    anomaly_id        TEXT,
    topic             TEXT NOT NULL,
    type              TEXT NOT NULL,
    severity          TEXT NOT NULL,
    priority          TEXT NOT NULL,
    title             TEXT NOT NULL,
    description       TEXT,
    recommended_action TEXT,
    evidence_summary  TEXT,
    confidence        REAL,
    zscore            REAL,
    detected_at       TEXT NOT NULL,
    sent_at           TEXT,
    acknowledged_at   TEXT,
    acknowledged_by   TEXT,
    resolved_at       TEXT,
    resolution_note  TEXT,
    status            TEXT NOT NULL DEFAULT 'DETECTED',
    dedup_key         TEXT NOT NULL,
    cooldown_until    TEXT,
    related_investigation_id TEXT,
    metadata_json     TEXT,
    created_at        TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
  CREATE INDEX IF NOT EXISTS idx_alerts_topic ON alerts(topic);
  CREATE INDEX IF NOT EXISTS idx_alerts_priority ON alerts(priority);
  CREATE INDEX IF NOT EXISTS idx_alerts_dedup ON alerts(dedup_key);
  CREATE INDEX IF NOT EXISTS idx_alerts_detected ON alerts(detected_at DESC);
  CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(severity);
`);

// SCHEMA_V6 (audit_log table) — identical to chismoso/src/db.ts.
// Idempotent. Required so /api/audit-log works on a fresh install
// where the chismoso CLI hasn't been run yet (the writable singleton
// is what the Next.js audit log writer uses).
chismosoWritableDb.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id              TEXT PRIMARY KEY,
    timestamp       TEXT NOT NULL,
    actor           TEXT NOT NULL,
    action          TEXT NOT NULL,
    target_type     TEXT,
    target_id       TEXT,
    ip              TEXT,
    user_agent      TEXT,
    trace_id        TEXT,
    metadata_json   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor);
  CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
`);
