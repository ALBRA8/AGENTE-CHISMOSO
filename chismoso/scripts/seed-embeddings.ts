/**
 * CHISMOSO V1.1 — Seed signal_embeddings into the real DB (EXP-4 utility)
 *
 * One-shot maintenance script: reads all signals currently stored in the
 * CHISMOSO SQLite DB, embeds each one's snippet with the canonical
 * EmbeddingClient, and persists the result into the `signal_embeddings`
 * table (creating it if necessary).
 *
 * After running this, the `/api/semantic-search` REST endpoint will return
 * real results instead of the empty `[]` it returns in the pre-warmup
 * state (no embeddings stored yet).
 *
 * Run:
 *   cd /home/z/my-project/chismoso
 *   npx tsx scripts/seed-embeddings.ts
 *
 * Re-runnable: uses INSERT OR REPLACE so embeddings for changed signals
 * are refreshed each time.
 */

import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { EmbeddingClient } from '../src/intelligence/embeddings.js';
import type { EmbeddingVector } from '../src/intelligence/embeddings.js';
import {
  ensureEmbeddingsSchema,
  storeEmbeddings,
} from '../src/db-extensions/embeddings.sql.js';

const DB_PATH = process.env.CHISMOSO_DB_PATH || '/home/z/my-project/chismoso/data/chismoso.db';

interface SignalRow {
  id: string;
  raw_snippet: string | null;
}

async function main(): Promise<number> {
  console.log(`[seed-embeddings] Opening DB: ${DB_PATH}`);
  const db: DB = new Database(DB_PATH);
  ensureEmbeddingsSchema(db);

  const rows = db
    .prepare('SELECT id, raw_snippet FROM signals ORDER BY id')
    .all() as SignalRow[];
  console.log(`[seed-embeddings] Found ${rows.length} signals in DB.`);

  if (rows.length === 0) {
    console.log('[seed-embeddings] No signals to embed. Nothing to do.');
    db.close();
    return 0;
  }

  const client = new EmbeddingClient();
  const entries: Array<{ signalId: string; embedding: EmbeddingVector }> = [];

  console.log('[seed-embeddings] Embedding (batch)…');
  // Reuse the snippet that the embedding model expects: id + raw_snippet.
  // (We don't have keyword + topic available cheaply here, so we embed
  // just the snippet. The clustering path embeds keyword + topic + snippet;
  // for SEARCH this is fine because the query is a free-text snippet too.)
  const texts = rows.map((r) => r.raw_snippet ?? r.id);
  const vectors = await client.embedBatch(texts);
  for (let i = 0; i < rows.length; i++) {
    entries.push({ signalId: rows[i].id, embedding: vectors[i] });
  }

  console.log(`[seed-embeddings] Storing ${entries.length} embeddings…`);
  const n = storeEmbeddings(db, entries);
  console.log(`[seed-embeddings] Done. Stored ${n} embeddings.`);

  db.close();
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('[seed-embeddings] FAILED:', e);
  process.exit(1);
});
