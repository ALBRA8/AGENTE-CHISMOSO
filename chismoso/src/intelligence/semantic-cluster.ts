/**
 * CHISMOSO V1.1 — Semantic clustering (EXP-4)
 *
 * Embedding-based drop-in replacement for `clusterSignals` (clustering.ts).
 *
 * ALGORITHM (single-link agglomerative via union-find)
 *   1. Batch-embed every signal's snippet (keyword + topic + first 200
 *      chars of rawSnippet) using the shared EmbeddingClient.
 *   2. Build the N×N cosine similarity matrix. O(N²) — fine for N up to
 *      a few thousand. For larger N, switch to approximate nearest
 *      neighbors (HNSW) — out of scope for V1.1.
 *   3. For every pair (i, j) with similarity > threshold (default 0.65),
 *      union their clusters. Single-linkage means a single high-similarity
 *      edge is enough to merge — which is the right bias for the
 *      "different expressions of the same phenomenon" use case.
 *   4. Drop clusters with fewer than minClusterSize signals. They are
 *      "noise": still present in `signalToCluster` (mapped to their
 *      singleton cluster id) but absent from the returned `clusters`
 *      array so downstream engines (trends, opportunities) don't treat
 *      them as real topics.
 *   5. Pick each cluster's canonical label as the highest-frequency token
 *      across its signals' keywords + topics + snippets (reusing `tokenize`
 *      from normalizer.ts). Identical heuristic to clustering.ts so the
 *      canonical labels look familiar.
 *
 * THRESHOLD TUNING
 *   IMPORTANT: The right threshold depends heavily on the embedding model.
 *
 *   - TF-IDF HASH (the current default — z-ai-web-dev-sdk v0.0.18 has no
 *     embeddings API). Cosine similarities are MUCH lower in absolute terms
 *     than for real embeddings: two snippets that share ~50% of their salient
 *     token mass have cosine sim ≈ 0.25-0.35, because the hashing trick
 *     spreads mass across 256 dims and signed hashing cancels collisions.
 *     Empirically (see scripts/test-embeddings.ts), within-group avg sim
 *     is ~0.25 and across-group avg sim is ~0.016, so the default of 0.18
 *     sits comfortably in the separation gap.
 *
 *   - REAL EMBEDDINGS (OpenAI text-embedding-3-small, Cohere embed-v3, etc.).
 *     When you swap the EmbeddingClient.computeEmbedding body to call a real
 *     embeddings API, RAISE the threshold to ~0.65. Real embeddings put
 *     semantically related texts at sim 0.7-0.9 and unrelated texts near 0.
 *     A threshold of 0.18 would over-merge everything.
 *
 *   - Quick tuning recipe: take 20-50 known-similar pairs and 20-50 known-
 *     dissimilar pairs, plot the two distributions of cosine sim, and pick
 *     a threshold in the valley between them.
 *
 * DEFAULT THRESHOLD SELECTION
 *   The default (0.18) is chosen for the OUT-OF-THE-BOX configuration,
 *   which uses the local TF-IDF hash fallback. If you change the embedding
 *   model, override `threshold` accordingly.
 *
 * DROP-IN COMPATIBILITY
 *   The returned `clusters` array has the SAME shape as clusterSignals's,
 *   so a caller can swap `clusterSignals` → `clusterSignalsSemantic` with
 *   no other code change. The only behavioral delta: signals whose
 *   clusters got filtered (size < minClusterSize) appear in
 *   `signalToCluster` but NOT in `clusters`.
 */

import type { Signal, TopicCluster } from '../models.js';
import { generateId } from '../models.js';
import { tokenize } from './normalizer.js';
import {
  EmbeddingClient,
  cosineSimilarity,
  type EmbeddingVector,
} from './embeddings.js';

// ---------------------------------------------------------------------------
// PUBLIC TYPES
// ---------------------------------------------------------------------------

export interface SemanticClusterResult {
  clusters: TopicCluster[];
  /** Map signalId → clusterId (includes noise clusters, see header). */
  signalToCluster: Map<string, string>;
  /** Map signalId → embedding. Useful for debugging / visualization. */
  embeddings: Map<string, EmbeddingVector>;
}

export interface SemanticClusterOptions {
  /** Cosine similarity threshold above which two signals merge. */
  threshold?: number;
  /** Minimum cluster size to keep in the result. Singletons are noise. */
  minClusterSize?: number;
  /** Inject an EmbeddingClient (e.g., with custom dim). Defaults to a new one. */
  embeddingClient?: EmbeddingClient;
}

// ---------------------------------------------------------------------------
// DEFAULTS
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLD = 0.18; // tuned for TF-IDF hash; raise to ~0.65 for real embeddings
const DEFAULT_MIN_CLUSTER_SIZE = 2;

// ---------------------------------------------------------------------------
// MAIN ENTRY POINT
// ---------------------------------------------------------------------------

export async function clusterSignalsSemantic(
  signals: Signal[],
  opts: SemanticClusterOptions = {},
): Promise<SemanticClusterResult> {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const minClusterSize = opts.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE;
  const client = opts.embeddingClient ?? new EmbeddingClient();

  // Edge case: no signals → empty result.
  if (signals.length === 0) {
    return {
      clusters: [],
      signalToCluster: new Map(),
      embeddings: new Map(),
    };
  }

  // 1. Batch-embed.
  const texts = signals.map((s) =>
    signalToText(s),
  );
  const vectors = await client.embedBatch(texts);
  const embeddings = new Map<string, EmbeddingVector>();
  for (let i = 0; i < signals.length; i++) {
    embeddings.set(signals[i].id, vectors[i]);
  }

  // 2. Union-find on cosine similarity > threshold.
  const uf = new UnionFind(signals.length);
  for (let i = 0; i < signals.length; i++) {
    for (let j = i + 1; j < signals.length; j++) {
      const sim = cosineSimilarity(vectors[i], vectors[j]);
      if (sim >= threshold) uf.union(i, j);
    }
  }

  // 3. Build clusterId → signal indices map.
  const rootToIndices = new Map<number, number[]>();
  for (let i = 0; i < signals.length; i++) {
    const r = uf.find(i);
    const arr = rootToIndices.get(r);
    if (arr) arr.push(i);
    else rootToIndices.set(r, [i]);
  }

  // 4. Build TopicCluster objects (one per root, including singletons).
  const signalToCluster = new Map<string, string>();
  const allClusters: TopicCluster[] = [];
  for (const [, indices] of rootToIndices) {
    const clusterSignals = indices.map((i) => signals[i]);
    const c = buildCluster(clusterSignals);
    for (const s of clusterSignals) signalToCluster.set(s.id, c.id);
    allClusters.push(c);
  }

  // 5. Filter out noise (clusters smaller than minClusterSize).
  const clusters = allClusters.filter(
    (c) => c.signalIds.length >= minClusterSize,
  );

  return { clusters, signalToCluster, embeddings };
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function signalToText(s: Signal): string {
  // Mirror clustering.ts: keyword + topic + first 200 chars of snippet.
  // This is the textual surface we embed; it deliberately omits URLs and
  // metadata to keep the embedding focused on meaning.
  return `${s.keyword} ${s.topic} ${s.rawSnippet.slice(0, 200)}`;
}

function buildCluster(clusterSignals: Signal[]): TopicCluster {
  const id = generateId('topic');
  const signalIds = clusterSignals.map((s) => s.id);
  const keywords = clusterSignals.map((s) => s.keyword);
  const sourcesCount = new Set(clusterSignals.map((s) => s.source)).size;

  // Compute canonical = most frequent token across all signals' surfaces.
  const freq = new Map<string, number>();
  for (const s of clusterSignals) {
    const tokens = tokenize(signalToText(s));
    for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  const canonical = pickCanonical(clusterSignals[0]?.topic || clusterSignals[0]?.keyword, freq);

  // firstSeen / lastSeen from min/max timestamp.
  let firstSeen = clusterSignals[0].timestamp;
  let lastSeen = clusterSignals[0].timestamp;
  for (const s of clusterSignals) {
    if (s.timestamp < firstSeen) firstSeen = s.timestamp;
    if (s.timestamp > lastSeen) lastSeen = s.timestamp;
  }

  return {
    id,
    canonical,
    keywords,
    signalIds,
    evidenceIds: [],
    sourcesCount,
    firstSeen,
    lastSeen,
    observationCount: clusterSignals.length,
  };
}

function pickCanonical(fallback: string, freq: Map<string, number>): string {
  let best = fallback;
  let bestCount = 0;
  for (const [tok, count] of freq.entries()) {
    if (count > bestCount || (count === bestCount && tok.length > best.length)) {
      best = tok;
      bestCount = count;
    }
  }
  return best || fallback;
}

// ---------------------------------------------------------------------------
// UNION-FIND (path compression + union by rank)
// ---------------------------------------------------------------------------

class UnionFind {
  private readonly parent: Int32Array;
  private readonly rank: Uint8Array;

  constructor(n: number) {
    this.parent = new Int32Array(n);
    this.rank = new Uint8Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }

  find(x: number): number {
    // Iterative find with path halving (cheaper than recursion in JS).
    let p = this.parent;
    while (p[x] !== x) {
      p[x] = p[p[x]]; // path halving
      x = p[x];
    }
    return x;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    // Union by rank: smaller tree hangs under larger.
    if (this.rank[ra] < this.rank[rb]) {
      this.parent[ra] = rb;
    } else if (this.rank[ra] > this.rank[rb]) {
      this.parent[rb] = ra;
    } else {
      this.parent[rb] = ra;
      this.rank[ra]++;
    }
  }
}
