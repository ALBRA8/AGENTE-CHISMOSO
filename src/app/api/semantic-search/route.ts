import { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

const DB_PATH = '/home/z/my-project/chismoso/data/chismoso.db';
const EMBEDDING_DIM = 256;
const EMBEDDING_MODEL = 'tfidf-hash-v1';
const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 50;

// ---------------------------------------------------------------------------
// TYPES (mirror chismoso/src/intelligence/semantic-search.ts)
// ---------------------------------------------------------------------------

interface SemanticSearchResult {
  signalId: string;
  /** Cosine similarity, in [-1, 1]. Negative tail squashed to 0. */
  score: number;
  snippet: string;
  url?: string;
}

interface EmbeddingRow {
  signal_id: string;
  embedding_blob: Buffer;
  dim: number;
  model: string;
}

interface SignalMetaRow {
  id: string;
  raw_snippet: string | null;
  url: string | null;
}

// ---------------------------------------------------------------------------
// HANDLER
// ---------------------------------------------------------------------------

/**
 * POST /api/semantic-search
 *
 * Body: { "query": string, "topK"?: number }
 *   - query: free-text natural-language query (ES or EN).
 *   - topK: number of results to return (1..50, default 10).
 *
 * Response 200: { "results": SemanticSearchResult[] }
 *   - signalId: string
 *   - score: number (0..1, cosine similarity, higher = more similar)
 *   - snippet: string (raw_snippet from signals table)
 *   - url?: string (if the signal had one)
 *
 * Response 400: { "error": "missing_query" | "topK_out_of_range" | ... }
 * Response 500: { "error": "search_failed", "message": string, "results": [] }
 *
 * NOTES
 *   - Reads the CHISMOSO SQLite DB (the same one written by the orchestrator).
 *   - Returns 200 with `results: []` when no embeddings have been stored
 *     yet (the `signal_embeddings` table doesn't exist) — this is the
 *     pre-warmup state, not an error.
 *   - The TF-IDF hash embedding is inlined here so the route handler is
 *     self-contained (no cross-project TS imports). It is byte-identical
 *     to chismoso/src/intelligence/embeddings.ts::EmbeddingClient.computeEmbedding,
 *     so embeddings written by the orchestrator are directly searchable.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Parse + validate body.
  let body: { query?: unknown; topK?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid_json', message: 'Body must be valid JSON.' },
      { status: 400 },
    );
  }
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) {
    return NextResponse.json(
      { error: 'missing_query', message: 'Body must include a non-empty "query" string.' },
      { status: 400 },
    );
  }
  let topK = DEFAULT_TOP_K;
  if (body.topK !== undefined) {
    if (typeof body.topK !== 'number' || !Number.isFinite(body.topK) || body.topK < 1) {
      return NextResponse.json(
        { error: 'topK_out_of_range', message: 'topK must be a positive finite number.' },
        { status: 400 },
      );
    }
    topK = Math.min(Math.floor(body.topK), MAX_TOP_K);
  }

  // 2. Open DB readonly. If the embeddings table doesn't exist yet, return
  //    empty results — this is a legitimate "no embeddings have been
  //    generated yet" state, not an error.
  let db: Database.Database | null = null;
  try {
    db = new Database(DB_PATH, { readonly: true });
    const tableRow = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'signal_embeddings' LIMIT 1",
      )
      .get() as { name?: string } | undefined;
    if (!tableRow || tableRow.name !== 'signal_embeddings') {
      return NextResponse.json({ results: [] });
    }

    // 3. Load all stored embeddings.
    const rows = db
      .prepare(
        'SELECT signal_id, embedding_blob, dim, model FROM signal_embeddings',
      )
      .all() as EmbeddingRow[];

    if (rows.length === 0) {
      return NextResponse.json({ results: [] });
    }

    // 4. Embed the query using the same TF-IDF hash algorithm as the writer.
    const queryEmb = embedTFIDFHash(query);

    // 5. Score every stored embedding whose model matches.
    type Scored = { signalId: string; score: number };
    const scored: Scored[] = [];
    for (const row of rows) {
      if (row.model !== EMBEDDING_MODEL) continue; // incomparable vectors
      if (row.dim !== EMBEDDING_DIM) continue;
      const storedEmb = parseEmbeddingBlob(row.embedding_blob, row.dim);
      if (!storedEmb) continue;
      const score = cosineSimilarity(queryEmb, storedEmb);
      if (!Number.isFinite(score)) continue;
      scored.push({ signalId: row.signal_id, score });
    }

    if (scored.length === 0) {
      return NextResponse.json({ results: [] });
    }

    // 6. Sort desc, take topK.
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, topK);

    // 7. Hydrate snippet + url from signals table (single IN query).
    const meta = loadSignalMetadata(
      db,
      top.map((s) => s.signalId),
    );

    // 8. Assemble results. Skip any signal whose metadata is missing
    //    (orphan embedding — signal was deleted).
    const results: SemanticSearchResult[] = [];
    for (const s of top) {
      const m = meta.get(s.signalId);
      if (!m) continue;
      results.push({
        signalId: s.signalId,
        // Negative cosine (rare for TF-IDF hash embeddings) is squashed to 0
        // so callers can treat score as a similarity in [0, 1].
        score: Math.max(0, s.score),
        snippet: m.snippet,
        url: m.url,
      });
    }

    return NextResponse.json({ results });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: 'search_failed', message, results: [] },
      { status: 500 },
    );
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// TF-IDF HASH EMBEDDING (mirror of chismoso/src/intelligence/embeddings.ts)
// ---------------------------------------------------------------------------
// Duplicated here so the route handler is self-contained and does NOT need
// to import chismoso source (which has a different tsconfig + ESM .js imports).
// If you change the algorithm in chismoso, change it here too — they MUST
// produce identical vectors for the same input.

const STOPWORDS = new Set<string>([
  // EN
  'the','a','an','of','to','in','on','for','and','or','with','is','are','be','by','that','this','it','as','at','from','you','your','i','we','our','they','them','he','she','his','her',
  // ES
  'el','la','los','las','un','una','unos','unas','de','del','al','a','en','para','por','con','y','o','que','se','su','sus','es','son','ser','como','mas','muy','cuando','donde','si','no',
]);

function normalizeText(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(s: string): string[] {
  const t = normalizeText(s);
  if (!t) return [];
  return t.split(' ').filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function embedTFIDFHash(text: string): Float32Array {
  const vec = new Float32Array(EMBEDDING_DIM);
  const tokens = tokenize(text);
  if (tokens.length === 0) return vec;

  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  let maxTf = 0;
  for (const c of tf.values()) if (c > maxTf) maxTf = c;
  if (maxTf === 0) maxTf = 1;

  for (const [tok, count] of tf.entries()) {
    const h = sha256UInt32(tok);
    const bucket = h % EMBEDDING_DIM;
    const sign = (h >>> 31) === 1 ? -1 : 1;
    vec[bucket] += (count / maxTf) * sign;
  }

  // L2-normalize so cosine sim == dot product.
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  const inv = 1 / norm;
  for (let i = 0; i < vec.length; i++) vec[i] = vec[i] * inv;

  return vec;
}

function sha256UInt32(input: string): number {
  const buf = createHash('sha256').update(input, 'utf8').digest();
  return ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

function parseEmbeddingBlob(buf: Buffer, expectedDim: number): Float32Array | null {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return null;
  if (buf.length % 4 !== 0) return null;
  const dim = buf.length / 4;
  if (dim !== expectedDim) return null;
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}

function loadSignalMetadata(
  db: Database.Database,
  signalIds: string[],
): Map<string, { snippet: string; url?: string }> {
  const out = new Map<string, { snippet: string; url?: string }>();
  if (signalIds.length === 0) return out;
  const placeholders = signalIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id, raw_snippet, url FROM signals WHERE id IN (${placeholders})`)
    .all(...signalIds) as SignalMetaRow[];
  for (const r of rows) {
    out.set(r.id, {
      snippet: r.raw_snippet ?? '',
      url: r.url ?? undefined,
    });
  }
  return out;
}
