/**
 * CHISMOSO V1.1 — Embeddings storage extension (EXP-4)
 *
 * Adds a `signal_embeddings` table to the existing SQLite database managed
 * by ChismosoDB (src/db.ts). We do NOT touch db.ts or repositories.ts
 * (other agents own those) — this module opens the same DB file via a
 * SEPARATE better-sqlite3 connection and manages its own table.
 *
 * The table is keyed by signal_id (PK) and stores the Float32Array as a
 * raw BLOB (`Buffer.from(float32.buffer)`). Storing binary instead of JSON
 * keeps the table ~4x smaller and ~10x faster to scan for similarity
 * search. The dim and model columns let us re-validate vectors on load
 * (mismatched model → re-embed).
 *
 * BINARY LAYOUT (read path)
 *   BLOB → Node Buffer (may have byteOffset != 0)
 *        → copy underlying ArrayBuffer slice to a fresh ArrayBuffer
 *          (so we can construct a Float32Array view without aliasing)
 *        → new Float32Array(arrayBuffer)
 *
 * CONCURRENCY
 *   better-sqlite3 in WAL mode supports concurrent readers + a single
 *   writer. The semantic search endpoint opens readonly and the writer
 *   (orchestrator, when it adopts embeddings) opens readwrite. No locking
 *   issues for V1.1.
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { nowISO } from '../models.js';
import type { EmbeddingVector } from '../intelligence/embeddings.js';

// ---------------------------------------------------------------------------
// SCHEMA
// ---------------------------------------------------------------------------

export const EMBEDDINGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS signal_embeddings (
  signal_id     TEXT PRIMARY KEY,
  embedding_blob BLOB NOT NULL,
  dim            INTEGER NOT NULL,
  model          TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signal_embeddings_model
  ON signal_embeddings(model);
`;

// ---------------------------------------------------------------------------
// SCHEMA ENSURANCE
// ---------------------------------------------------------------------------

/**
 * Idempotently creates the `signal_embeddings` table on the given DB.
 * Safe to call on every connection (uses IF NOT EXISTS). Requires readwrite
 * access. For readonly connections, check `embeddingsTableExists()` first.
 */
export function ensureEmbeddingsSchema(db: BetterSqlite3Database): void {
  db.exec(EMBEDDINGS_SCHEMA);
}

/**
 * Returns true iff the `signal_embeddings` table exists in the given DB.
 * Use this on readonly connections before attempting a SELECT.
 */
export function embeddingsTableExists(db: BetterSqlite3Database): boolean {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'signal_embeddings' LIMIT 1",
    )
    .get() as { name?: string } | undefined;
  return !!row && row.name === 'signal_embeddings';
}

// ---------------------------------------------------------------------------
// WRITE PATH
// ---------------------------------------------------------------------------

interface StoreRow {
  signal_id: string;
  embedding_blob: Buffer;
  dim: number;
  model: string;
  created_at: string;
}

/**
 * Upserts a single embedding for a signal. Replaces if the signal_id
 * already exists. Requires readwrite access.
 */
export function storeEmbedding(
  db: BetterSqlite3Database,
  signalId: string,
  emb: EmbeddingVector,
): void {
  const buf = float32ToBuffer(emb.vector);
  const row: StoreRow = {
    signal_id: signalId,
    embedding_blob: buf,
    dim: emb.dim,
    model: emb.model,
    created_at: nowISO(),
  };
  db.prepare(`
    INSERT OR REPLACE INTO signal_embeddings
      (signal_id, embedding_blob, dim, model, created_at)
    VALUES
      (@signal_id, @embedding_blob, @dim, @model, @created_at)
  `).run(row);
}

/**
 * Bulk-insert embeddings. Single transaction for atomicity + speed.
 */
export function storeEmbeddings(
  db: BetterSqlite3Database,
  entries: Array<{ signalId: string; embedding: EmbeddingVector }>,
): number {
  if (entries.length === 0) return 0;
  const now = nowISO();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO signal_embeddings
      (signal_id, embedding_blob, dim, model, created_at)
    VALUES
      (@signal_id, @embedding_blob, @dim, @model, @created_at)
  `);
  const tx = db.transaction(() => {
    for (const e of entries) {
      stmt.run({
        signal_id: e.signalId,
        embedding_blob: float32ToBuffer(e.embedding.vector),
        dim: e.embedding.dim,
        model: e.embedding.model,
        created_at: now,
      });
    }
    return entries.length;
  });
  return tx();
}

// ---------------------------------------------------------------------------
// READ PATH
// ---------------------------------------------------------------------------

interface LoadRow {
  signal_id: string;
  embedding_blob: Buffer;
  dim: number;
  model: string;
  created_at: string;
}

/**
 * Loads a single signal's embedding. Returns null if the signal has no
 * stored embedding (or if the table doesn't exist on a readonly conn).
 */
export function loadEmbedding(
  db: BetterSqlite3Database,
  signalId: string,
): EmbeddingVector | null {
  if (!embeddingsTableExists(db)) return null;
  const row = db
    .prepare(
      'SELECT signal_id, embedding_blob, dim, model FROM signal_embeddings WHERE signal_id = ?',
    )
    .get(signalId) as LoadRow | undefined;
  if (!row) return null;
  return parseEmbeddingRow(row);
}

/**
 * Loads ALL signal embeddings. Returns an empty array if the table
 * doesn't exist (e.g., on a fresh DB or a readonly conn where nobody
 * has ever written embeddings).
 */
export function loadAllEmbeddings(
  db: BetterSqlite3Database,
): Array<{ signalId: string; embedding: EmbeddingVector }> {
  if (!embeddingsTableExists(db)) return [];
  const rows = db
    .prepare(
      'SELECT signal_id, embedding_blob, dim, model FROM signal_embeddings',
    )
    .all() as LoadRow[];
  const out: Array<{ signalId: string; embedding: EmbeddingVector }> = [];
  for (const row of rows) {
    const emb = parseEmbeddingRow(row);
    if (emb) out.push({ signalId: row.signal_id, embedding: emb });
  }
  return out;
}

/**
 * Deletes embeddings whose signal_id no longer exists in `signals`.
 * Useful maintenance hook. Returns the number of orphan rows deleted.
 * Not strictly required for V1.1 but documented for future use.
 */
export function pruneOrphanEmbeddings(db: BetterSqlite3Database): number {
  if (!embeddingsTableExists(db)) return 0;
  const r = db
    .prepare(
      `DELETE FROM signal_embeddings
       WHERE signal_id NOT IN (SELECT id FROM signals)`,
    )
    .run();
  return r.changes;
}

// ---------------------------------------------------------------------------
// SERIALIZATION HELPERS
// ---------------------------------------------------------------------------

/**
 * Converts a Float32Array to a Node Buffer suitable for BLOB storage.
 * Makes a fresh copy so the buffer is self-contained (byteOffset == 0,
 * no aliasing to the input's underlying ArrayBuffer).
 */
function float32ToBuffer(v: Float32Array): Buffer {
  // Buffer.from(arrayBuffer) creates a view; we want a standalone copy.
  const buf = Buffer.alloc(v.byteLength);
  new Float32Array(buf.buffer, buf.byteOffset, v.length).set(v);
  return buf;
}

/**
 * Parses a BLOB row into an EmbeddingVector. Returns null on corruption
 * (wrong byte length, mismatched dim, etc.) so the caller can skip.
 */
function parseEmbeddingRow(row: LoadRow): EmbeddingVector | null {
  const buf = row.embedding_blob;
  if (!Buffer.isBuffer(buf) || buf.length === 0) return null;
  // buf.byteOffset may be non-zero if Buffer is a slice of a larger pool.
  // Slice the underlying ArrayBuffer to get a standalone copy.
  const byteLen = buf.length;
  if (byteLen % 4 !== 0) return null;
  const dim = byteLen / 4;
  if (dim !== row.dim) {
    // Stored dim metadata disagrees with actual blob size — corrupt row.
    return null;
  }
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + byteLen);
  const vector = new Float32Array(ab);
  return { vector, dim, model: row.model };
}
