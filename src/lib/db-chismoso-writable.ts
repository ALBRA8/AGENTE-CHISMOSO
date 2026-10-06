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

// Ensure WAL + foreign_keys match the chismoso CLI's setup so concurrent
// writes from this writer and reads from the readonly singleton behave
// correctly.
chismosoWritableDb.pragma('journal_mode = WAL');
chismosoWritableDb.pragma('foreign_keys = ON');

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
    resolution_note   TEXT,
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
