/**
 * Singleton SQLite connection to the CHISMOSO database.
 *
 * LAZY INITIALIZATION — the Database is NOT opened at module load time.
 * Instead, it opens on first access via the `getDb()` function.
 * This prevents the better-sqlite3 + Node 24 + Turbopack HMR crash
 * where the Statement destructor fires after the V8 environment has
 * been torn down during hot module replacement.
 *
 * Usage:
 *   import { getDb } from '@/lib/db-chismoso';
 *   const db = getDb();  // opens on first call, returns singleton after
 *   db.prepare('SELECT ...').all();
 *
 * The old `chismosoDb` export is kept as a getter proxy for backward
 * compat with existing API routes that do `chismosoDb.prepare(...)`.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const DB_PATH =
  process.env.CHISMOSO_DB_PATH ?? path.resolve(process.cwd(), 'chismoso', 'data', 'chismoso.db');

// Ensure parent dir exists.
mkdirSync(path.dirname(DB_PATH), { recursive: true });

// Use global to survive Next.js HMR in dev.
const globalForDb = globalThis as unknown as {
  __chismosoDb?: Database.Database;
  __chismosoDbPath?: string;
};

/**
 * Opens the database connection on first call, returns the singleton
 * on subsequent calls. Safe to call multiple times.
 */
export function getDb(): Database.Database {
  if (globalForDb.__chismosoDb) {
    // If the path changed (e.g. env var override), close and reopen.
    if (globalForDb.__chismosoDbPath !== DB_PATH) {
      try { globalForDb.__chismosoDb.close(); } catch { /* ignore */ }
      globalForDb.__chismosoDb = undefined;
    }
  }
  if (!globalForDb.__chismosoDb) {
    globalForDb.__chismosoDb = new Database(DB_PATH, { readonly: true });
    globalForDb.__chismosoDbPath = DB_PATH;

    // Ensure indexes exist (idempotent).
    try {
      globalForDb.__chismosoDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_signals_timestamp ON signals(timestamp);
        CREATE INDEX IF NOT EXISTS idx_signals_topic_timestamp ON signals(topic, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_trends_created_at ON trends(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_problems_created_at ON problems(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_opportunities_score ON opportunities(score DESC);
        CREATE INDEX IF NOT EXISTS idx_evidence_topic_collected ON evidence(topic, collected_at DESC);
        CREATE INDEX IF NOT EXISTS idx_provider_runs_investigation ON provider_runs(investigation_id);
      `);
    } catch {
      // Table might not exist yet — ignore, the CLI will create it.
    }
  }
  return globalForDb.__chismosoDb;
}

/**
 * Backward-compatible export. Uses a Proxy so existing code that does
 * `chismosoDb.prepare(...)` still works — the actual Database is opened
 * lazily on first method access.
 */
export const chismosoDb = new Proxy({} as Database.Database, {
  get(_target, prop) {
    const db = getDb();
    const value = (db as any)[prop];
    return typeof value === 'function' ? value.bind(db) : value;
  },
});
