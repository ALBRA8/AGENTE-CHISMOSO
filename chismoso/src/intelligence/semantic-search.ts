/**
 * CHISMOSO V1.1 — Semantic search (EXP-4)
 *
 * Given a free-text query, return the top-K most semantically similar
 * signals stored in the DB. This is the read-side counterpart to the
 * embeddings.sql.ts storage layer.
 *
 * FLOW
 *   1. Load every stored embedding from `signal_embeddings` (one SELECT,
 *      one BLOB per row).
 *   2. Load signal metadata (raw_snippet, url) for those signal_ids from
 *      the `signals` table (one SELECT IN (...)).
 *   3. Embed the query using the same EmbeddingClient used at write time
 *      (default local TF-IDF hash; same model → comparable vectors).
 *   4. Compute cosine similarity between the query embedding and every
 *      stored embedding. O(N) per query — fine for N up to ~10k.
 *   5. Sort desc, take top-K, return.
 *
 * SCORE SEMANTICS
 *   `score` is the raw cosine similarity, in [-1, 1] but in practice
 *   non-negative for our TF-IDF hash embeddings (since tf is non-negative
 *   and signed hashing cancels in expectation). The REST API squashes the
 *   negative tail to 0.
 *
 * ROBUSTNESS
 *   - If `signal_embeddings` doesn't exist (no embeddings written yet),
 *     returns []. The route handler relies on this.
 *   - If an embedding's signal_id no longer exists in `signals` (deletion,
 *     schema drift), it is silently skipped — the caller only sees signals
 *     that still exist.
 *   - If `model` mismatches between the query embedding and a stored
 *     embedding, that row is skipped with a stderr warning (different
 *     models produce incomparable vectors).
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { EmbeddingClient, cosineSimilarity } from './embeddings.js';
import { loadAllEmbeddings } from '../db-extensions/embeddings.sql.js';

// ---------------------------------------------------------------------------
// PUBLIC TYPES
// ---------------------------------------------------------------------------

export interface SemanticSearchResult {
  signalId: string;
  /** Cosine similarity in [-1, 1]. Typically non-negative for our embeddings. */
  score: number;
  snippet: string;
  url?: string;
}

export interface SemanticSearchOptions {
  /** Number of results to return. Default 10. Capped at 50. */
  topK?: number;
  /** DB connection. Readonly is fine. */
  db: BetterSqlite3Database;
  /** Inject an EmbeddingClient (e.g., to use the same dim as at write time). */
  embeddingClient?: EmbeddingClient;
  /** Optional minimum score. Results below this are filtered out. Default 0. */
  minScore?: number;
}

// ---------------------------------------------------------------------------
// DEFAULTS
// ---------------------------------------------------------------------------

const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 50;
const DEFAULT_MIN_SCORE = 0;

// ---------------------------------------------------------------------------
// MAIN ENTRY POINT
// ---------------------------------------------------------------------------

export async function semanticSearch(
  query: string,
  opts: SemanticSearchOptions,
): Promise<SemanticSearchResult[]> {
  const topK = Math.min(Math.max(opts.topK ?? DEFAULT_TOP_K, 1), MAX_TOP_K);
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const client = opts.embeddingClient ?? new EmbeddingClient();
  const db = opts.db;

  // 1. Load every stored embedding. Returns [] if the table doesn't exist.
  const stored = loadAllEmbeddings(db);
  if (stored.length === 0) return [];

  // 2. Load signal metadata for all signal_ids in one query.
  const signalMeta = loadSignalMetadata(
    db,
    stored.map((s) => s.signalId),
  );

  // 3. Embed the query.
  const queryEmb = await client.embed(query);

  // 4. Score each stored embedding, filtering out:
  //    - model mismatch (incomparable vectors)
  //    - missing signal metadata (orphan embedding, signal was deleted)
  //    - score below minScore
  const scored: SemanticSearchResult[] = [];
  for (const { signalId, embedding } of stored) {
    if (embedding.model !== queryEmb.model) {
      // The stored embedding was produced by a different model. Skip it.
      // (If this floods the logs, run pruneOrphanEmbeddings or re-embed.)
      continue;
    }
    const meta = signalMeta.get(signalId);
    if (!meta) continue; // orphan — signal deleted, skip silently
    const score = cosineSimilarity(queryEmb, embedding);
    if (score < minScore) continue;
    scored.push({
      signalId,
      score,
      snippet: meta.snippet,
      url: meta.url,
    });
  }

  // 5. Sort desc by score, take topK.
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

interface SignalMetaRow {
  id: string;
  raw_snippet: string | null;
  url: string | null;
}

function loadSignalMetadata(
  db: BetterSqlite3Database,
  signalIds: string[],
): Map<string, { snippet: string; url?: string }> {
  const out = new Map<string, { snippet: string; url?: string }>();
  if (signalIds.length === 0) return out;

  // Chunk in batches of 500 to stay well below SQLite's default 999-param
  // limit. We prepare a fresh statement per chunk because the IN (...)
  // arity varies per chunk size — better-sqlite3 caches the prepared SQL
  // internally so this is cheap.
  const CHUNK = 500;
  for (let i = 0; i < signalIds.length; i += CHUNK) {
    const chunk = signalIds.slice(i, i + CHUNK);
    const stmt = db.prepare(
      `SELECT id, raw_snippet, url FROM signals WHERE id IN (${placeholders(chunk.length)})`,
    );
    const rows = stmt.all(...chunk) as SignalMetaRow[];
    for (const r of rows) {
      out.set(r.id, {
        snippet: r.raw_snippet ?? '',
        url: r.url ?? undefined,
      });
    }
  }
  return out;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}
