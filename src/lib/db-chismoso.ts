/**
 * Singleton SQLite connection to the CHISMOSO database.
 *
 * Why a singleton?
 * ---
 * Every `new Database(path)` call in better-sqlite3 costs ~10–50ms: it has
 * to open the file, read the header, run pragma checks, and prepare the
 * statement cache. The /api/anomalies, /api/alerts, /api/topics and
 * /api/topics/[topic] routes were each opening a fresh connection per
 * request — easily doubling the wall time of cheap queries.
 *
 * This module exposes a single readonly Database instance that survives
 * across requests AND across Next.js dev HMR (via the globalThis cache).
 *
 * Idempotent indexes
 * ---
 * The reader also ensures the performance indexes from SCHEMA_V2 exist.
 * This is necessary because the chismoso CLI may have created the DB file
 * with an older SCHEMA_V1 before SCHEMA_V2 was shipped. Creating an index
 * that already exists is a no-op (`IF NOT EXISTS`), so this is safe to run
 * on every cold start of the Next.js process.
 *
 * The matching `SCHEMA_V2` constant lives in `chismoso/src/db.ts` and is
 * applied by the CLI when it opens the DB for writes. The two are kept in
 * sync deliberately.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

// Ruta portátil: el default ya no apunta a una ruta del sandbox; el compose
// y el CLI fijan CHISMOSO_DB_PATH (/data/chismoso.db en la imagen OCI).
const DB_PATH =
  process.env.CHISMOSO_DB_PATH ?? path.resolve('chismoso/data/chismoso.db');

// Use global to survive Next.js HMR in dev (a fresh module graph would
// otherwise re-instantiate the Database and leak file descriptors).
const globalForDb = globalThis as unknown as {
  __chismosoDb?: Database.Database;
};

/**
 * Apertura PEREZOSA: la conexión se crea en el primer USO, nunca en la
 * evaluación del módulo. `next build` (collecting page data) evalúa este
 * módulo sin que exista la BD — abrir en modo readonly un archivo inexistente
 * rompía el build (y bajo Bun, crasheaba los workers con un panic NAPI).
 */
function openChismosoDb(): Database.Database {
  const existing = globalForDb.__chismosoDb;
  if (existing) return existing;
  // Ensure parent dir exists — the mesh DB helper originally skipped this,
  // which caused /api/mesh/config to 500 when chismoso had not yet been run.
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH, { readonly: true });

  // Ensure indexes exist (idempotent — same as SCHEMA_V2 in chismoso/src/db.ts).
  // Sobre una conexión readonly esto solo funciona si los índices ya existen
  // (no-op sin escritura); si el CLI aún no creó la BD/índices, degradamos
  // honesto: el escritor los creará en su primera escritura.
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_signals_timestamp ON signals(timestamp);
      CREATE INDEX IF NOT EXISTS idx_signals_topic_timestamp ON signals(topic, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_trends_created_at ON trends(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_problems_created_at ON problems(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_opportunities_score ON opportunities(score DESC);
      CREATE INDEX IF NOT EXISTS idx_evidence_topic_collected ON evidence(topic, collected_at DESC);
      CREATE INDEX IF NOT EXISTS idx_provider_runs_investigation ON provider_runs(investigation_id);
    `);
  } catch {
    // BD readonly sin índices aún — las queries funcionan sin ellos (más lentas).
  }
  globalForDb.__chismosoDb = db;
  return db;
}

export const chismosoDb: Database.Database = new Proxy({} as Database.Database, {
  get(_target, prop) {
    const db = openChismosoDb();
    const value = (db as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === 'function'
      ? (value as (...args: unknown[]) => unknown).bind(db)
      : value;
  },
});
