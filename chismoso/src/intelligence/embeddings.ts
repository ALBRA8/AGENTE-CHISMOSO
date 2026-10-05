/**
 * CHISMOSO V1.1 — Embeddings client (EXP-4)
 *
 * BACKGROUND / DECISION LOG
 * ---------------------------
 * The z-ai-web-dev-sdk v0.0.18 (verified by inspecting
 *   /home/z/.bun/install/global/node_modules/z-ai-web-dev-sdk/dist/index.d.ts)
 * exposes ONLY: chat.completions, audio.tts, audio.asr, images.generations,
 *   images.edit, images.search, video.generations, async.result, and
 *   functions.invoke (web_search, page_reader).
 *
 * It does NOT expose an `embeddings` API. We therefore fall back to a
 * LOCAL TF-IDF HASH EMBEDDING strategy (the "hashing trick" a.k.a.
 * feature hashing — Weinberger et al. 2009). This is:
 *   - deterministic (no model weights, no API calls)
 *   - free (no token cost, no network)
 *   - fast (sub-millisecond per snippet)
 *   - offline (works without API key)
 *
 * WHAT IT CAPTURES
 *   Each token in the text is mapped to one of `dim` (default 256) buckets
 *   via `sha256(token) % dim`. The bucket value accumulates the token's
 *   normalized term-frequency (tf / maxTf). To reduce the bias introduced by
 *   hash collisions we use SIGNED hashing: a second hash bit decides whether
 *   the contribution is +tf or -tf. In expectation, collisions cancel out
 *   (Weinberger et al.), so cosine similarity on these vectors approximates
 *   cosine similarity on a true one-hot token-presence vector weighted by tf.
 *
 * WHAT IT DOESN'T CAPTURE
 *   - Semantic similarity between DIFFERENT words ("reserva" vs "agendar").
 *   - Word order, syntax, negation.
 *   - Cross-lingual alignment beyond shared tokens.
 *   For CHISMOSO V1.1 this is still strictly better than the overlap
 *   coefficient in clustering.ts: two snippets that share 30% of tokens
 *   will get a similarity ≈ 0.3 here even when their token SETS have very
 *   different sizes (overlap coefficient divides by min(|a|,|b|), which
 *   over-weights tiny snippets). It also keeps a soft, continuous score
 *   instead of a binary "shared / not shared", so noise hurts less.
 *
 * WHEN A REAL EMBEDDING API BECOMES AVAILABLE
 *   Replace the body of `computeEmbedding` with a call to that API and keep
 *   the `EmbeddingClient` interface identical — every consumer
 *   (semantic-cluster, semantic-search, db-extensions) is interface-driven
 *   and will continue to work. The cache layer (Map<text, EmbeddingVector>)
 *   already exists; replace it with a DB-backed cache if latency/cost
 *   matters.
 */

import { createHash } from 'node:crypto';
import { tokenize } from './normalizer.js';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface EmbeddingVector {
  /** The dense vector data. Float32 for compactness + speed. */
  vector: Float32Array;
  /** Dimensionality (length of `vector`). */
  dim: number;
  /** Identifier of the model that produced this vector. */
  model: string;
}

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

const DEFAULT_DIM = 256;
const LOCAL_MODEL_TAG = 'tfidf-hash-v1';

// ---------------------------------------------------------------------------
// EMBEDDING CLIENT
// ---------------------------------------------------------------------------

export interface EmbeddingClientOptions {
  /** Vector dimensionality. Default 256. Higher = fewer collisions, more memory. */
  dim?: number;
  /**
   * If true, prefer the z-ai-web-dev-sdk embeddings API when it becomes
   * available. As of v0.0.18 it does NOT exist, so the client will emit a
   * one-time warning and fall back to the local TF-IDF hash strategy.
   * This flag exists so callers can opt-in without code changes once the
   * SDK exposes embeddings.
   */
  useSDK?: boolean;
  /** If true, do NOT cache embeddings in memory (default: cache is on). */
  noCache?: boolean;
}

export class EmbeddingClient {
  private readonly dim: number;
  private readonly cache: Map<string, EmbeddingVector> | null;
  private sdkWarningEmitted = false;

  constructor(private opts: EmbeddingClientOptions = {}) {
    this.dim = opts.dim ?? DEFAULT_DIM;
    this.cache = opts.noCache ? null : new Map<string, EmbeddingVector>();
  }

  /**
   * Compute (or fetch from cache) the embedding for a single text.
   */
  async embed(text: string): Promise<EmbeddingVector> {
    const key = text;
    if (this.cache) {
      const cached = this.cache.get(key);
      if (cached) return cached;
    }
    const v = this.computeEmbedding(text);
    if (this.cache) this.cache.set(key, v);
    return v;
  }

  /**
   * Compute embeddings for many texts in one call. The current implementation
   * is purely local CPU so this is just a parallel map — but the signature is
   * async so a future SDK-backed implementation can do true batching.
   */
  async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private computeEmbedding(text: string): EmbeddingVector {
    if (this.opts.useSDK && !this.sdkWarningEmitted) {
      // We can't import logger here without creating a circular dep with
      // orchestrator/llm. Use stderr directly — this is a one-shot warning.
      process.stderr.write(
        '[chismoso.embeddings] useSDK=true requested but z-ai-web-dev-sdk v0.0.18 ' +
          'has no embeddings API; falling back to local TF-IDF hash embedding.\n',
      );
      this.sdkWarningEmitted = true;
    }

    const tokens = tokenize(text);
    const vec = new Float32Array(this.dim);

    if (tokens.length === 0) {
      return { vector: vec, dim: this.dim, model: LOCAL_MODEL_TAG };
    }

    // Term frequency for this text.
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    let maxTf = 0;
    for (const c of tf.values()) if (c > maxTf) maxTf = c;
    if (maxTf === 0) maxTf = 1;

    // Accumulate contributions. Use signed hashing: a separate hash bit
    // determines sign, so collisions cancel in expectation.
    for (const [tok, count] of tf.entries()) {
      const h = sha256UInt32(tok);
      const bucket = h % this.dim;
      const sign = (h >>> 31) === 1 ? -1 : 1; // top bit of the 32-bit hash
      const value = (count / maxTf) * sign;
      vec[bucket] += value;
    }

    // L2-normalize so cosine similarity == dot product.
    l2NormalizeInPlace(vec);

    return { vector: vec, dim: this.dim, model: LOCAL_MODEL_TAG };
  }
}

// ---------------------------------------------------------------------------
// SIMILARITY / DISTANCE UTILITIES
// ---------------------------------------------------------------------------

/**
 * Cosine similarity between two embedding vectors.
 * Returns a value in [-1, 1]. Returns 0 if either vector is zero-length
 * (which happens for empty-text embeddings) to avoid NaN.
 *
 * Assumes both vectors are L2-normalized (the EmbeddingClient normalizes
 * automatically). For non-normalized inputs the result is still mathematically
 * a cosine similarity — it's just `dot(a,b) / (|a| * |b|)`.
 */
export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
  if (a.dim !== b.dim) {
    throw new Error(
      `cosineSimilarity: dimension mismatch (a=${a.dim}, b=${b.dim}). ` +
        `Embeddings from different models are not directly comparable.`,
    );
  }
  const va = a.vector;
  const vb = b.vector;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.dim; i++) {
    const x = va[i];
    const y = vb[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * Euclidean distance between two embedding vectors. Lower = more similar.
 * Useful for clustering diagnostics; cosine is the primary metric for V1.1.
 */
export function euclideanDistance(a: EmbeddingVector, b: EmbeddingVector): number {
  if (a.dim !== b.dim) {
    throw new Error(
      `euclideanDistance: dimension mismatch (a=${a.dim}, b=${b.dim}).`,
    );
  }
  let sum = 0;
  for (let i = 0; i < a.dim; i++) {
    const d = a.vector[i] - b.vector[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

// ---------------------------------------------------------------------------
// INTERNAL HELPERS
// ---------------------------------------------------------------------------

function sha256UInt32(input: string): number {
  // sha256 → 32 bytes → take first 4 bytes as a big-endian uint32.
  // sha256 is overkill here (we only need 32 bits) but it's available in
  // node:crypto without extra deps and has good distribution. For a 256-dim
  // vector, even a 16-bit hash would suffice — using sha256 leaves room to
  // bump dim later without rehashing.
  const buf = createHash('sha256').update(input, 'utf8').digest();
  return (
    (buf[0] << 24) |
    (buf[1] << 16) |
    (buf[2] << 8) |
    buf[3]
  ) >>> 0;
}

function l2NormalizeInPlace(v: Float32Array): void {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return;
  const inv = 1 / norm;
  for (let i = 0; i < v.length; i++) v[i] = v[i] * inv;
}

// ---------------------------------------------------------------------------
// DEFAULT EXPORT SINGLETON (convenience)
// ---------------------------------------------------------------------------

/**
 * A shared default EmbeddingClient. Process-wide cache. Use this for
 * ad-hoc embeds (e.g., embedding a search query). For bulk clustering
 * where you want a fresh cache per run, instantiate `new EmbeddingClient()`.
 */
export const defaultEmbeddingClient = new EmbeddingClient();
