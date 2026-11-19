/**
 * CHISMOSO V1.0 — Topic Clustering (sección 18)
 *
 * Diferentes expresiones pueden representar el mismo fenómeno.
 * Ej: "reservas por WhatsApp", "agendar por WhatsApp", "WhatsApp restaurant booking"
 * pueden agruparse en un único topic canónico.
 *
 * Para V1 usamos clustering híbrido:
 *   - normalización de keywords (lowercase, sin acentos)
 *   - agrupación por co-ocurrencia de keywords en señales cercanas
 *   - opcionalmente, el LLM propone un canonical label cuando hay
 *     sub-clusters que comparten >50% de keywords
 *
 * NO introducimos embeddings / vector DB en V1 — la especificación dice
 * explícitamente no introducir infraestructura pesada sin necesidad.
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import type { Signal, TopicCluster } from '../models.js';
import { generateId, nowISO } from '../models.js';
import { normalizeText, tokenize } from './normalizer.js';
import { clusterSignalsSemantic } from './semantic-cluster.js';
import {
  ensureEmbeddingsSchema,
  loadAllEmbeddings,
  storeEmbeddings,
} from '../db-extensions/embeddings.sql.js';
import { EmbeddingClient } from './embeddings.js';
import { logger } from '../logger.js';

export interface ClusterResult {
  clusters: TopicCluster[];
  /** map signal.id → clusterId */
  signalToCluster: Map<string, string>;
}

/**
 * Agrupa señales por similitud de keywords.
 *
 * Heurística:
 *   1. Tokeniza cada signal en keywords normalizadas.
 *   2. Para cada signal, encuentra un cluster existente tal que el
 *      solape de tokens (intersección / unión) sea >= threshold.
 *   3. Si encuentra, asigna. Si no, crea un cluster nuevo.
 *   4. El canonical del cluster es el keyword más frecuente entre sus señales.
 */
export function clusterSignals(signals: Signal[], threshold = 0.34): ClusterResult {
  const clusters: TopicCluster[] = [];
  const signalToCluster = new Map<string, string>();
  const clusterTokens = new Map<string, Map<string, number>>(); // clusterId → tokenFreq

  for (const s of signals) {
    const tokens = new Set(tokenize(`${s.keyword} ${s.topic} ${s.rawSnippet.slice(0, 200)}`));
    if (tokens.size === 0) {
      // No hay tokens para comparar — agrúpalo solo.
      const id = generateId('topic');
      const c: TopicCluster = {
        id,
        canonical: s.topic || s.keyword,
        keywords: [s.keyword],
        signalIds: [s.id],
        evidenceIds: [],
        sourcesCount: 1,
        firstSeen: s.timestamp,
        lastSeen: s.timestamp,
        observationCount: 1,
      };
      clusters.push(c);
      signalToCluster.set(s.id, id);
      clusterTokens.set(id, new Map());
      continue;
    }
    let bestCluster: TopicCluster | null = null;
    let bestScore = 0;
    for (const c of clusters) {
      const existing = clusterTokens.get(c.id)!;
      if (existing.size === 0) continue;
      let intersection = 0;
      for (const t of tokens) if (existing.has(t)) intersection++;
      // Overlap coefficient: intersection / min(|a|, |b|) — más permisivo
      // que Jaccard cuando los sets tienen tamaños muy distintos.
      const minSize = Math.min(tokens.size, existing.size);
      const score = minSize === 0 ? 0 : intersection / minSize;
      if (score > bestScore) {
        bestScore = score;
        bestCluster = c;
      }
    }
    if (bestCluster && bestScore >= threshold) {
      bestCluster.signalIds.push(s.id);
      bestCluster.keywords.push(s.keyword);
      bestCluster.sourcesCount = new Set(
        bestCluster.signalIds.map((sid) => signals.find((x) => x.id === sid)?.source).filter(Boolean) as string[],
      ).size;
      bestCluster.lastSeen = s.timestamp > bestCluster.lastSeen ? s.timestamp : bestCluster.lastSeen;
      bestCluster.firstSeen = s.timestamp < bestCluster.firstSeen ? s.timestamp : bestCluster.firstSeen;
      bestCluster.observationCount++;
      signalToCluster.set(s.id, bestCluster.id);
      const freq = clusterTokens.get(bestCluster.id)!;
      for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
    } else {
      const id = generateId('topic');
      const freq = new Map<string, number>();
      for (const t of tokens) freq.set(t, 1);
      const c: TopicCluster = {
        id,
        canonical: pickCanonical(s.topic || s.keyword, freq),
        keywords: [s.keyword],
        signalIds: [s.id],
        evidenceIds: [],
        sourcesCount: 1,
        firstSeen: s.timestamp,
        lastSeen: s.timestamp,
        observationCount: 1,
      };
      clusters.push(c);
      clusterTokens.set(id, freq);
      signalToCluster.set(s.id, id);
    }
  }

  // Refresca canonical basándose en el token más frecuente de cada cluster.
  for (const c of clusters) {
    const freq = clusterTokens.get(c.id)!;
    c.canonical = pickCanonical(c.canonical, freq);
  }

  // FASE-3-QUALITY §3.4 — no duplicate trend names.
  //
  // After canonical refresh, two clusters may end up with the same single
  // keyword (e.g. both clusters' most frequent token is "restaurantes").
  // We rename duplicates by appending a discriminator: the second
  // occurrence becomes "<topic>-2", the third "<topic>-3", etc. If the
  // underlying cluster has a meaningful secondary token we use that to
  // build a descriptive phrase (e.g. "restaurantes bogota" instead of
  // "restaurantes-2"); the discriminator is the fallback when no second
  // token is available.
  //
  // Also, we replace any single-word canonical with a short phrase when
  // possible (e.g. "restaurantes" → "crecimiento en restaurantes" when
  // we have enough signal context) so trends are descriptive phrases, not
  // single words.
  dedupCanonicalNames(clusters, clusterTokens);

  return { clusters, signalToCluster };
}

/**
 * FASE-3-QUALITY §3.4 — ensure no two clusters share the same canonical
 * name. Renames duplicates by:
 *   1. Trying to derive a descriptive phrase from the cluster's
 *      secondary tokens (e.g. "restaurantes" + "bogota" →
 *      "restaurantes bogota").
 *   2. ALWAYS appending a numeric discriminator (`-2`, `-3`, ...) when
 *      the derived phrase collides with an existing name, so duplicates
 *      are unambiguously renamed even when two clusters share the same
 *      top tokens (e.g. both clusters' top-2 tokens are "restaurantes"
 *      and "bogota" — the second one becomes "restaurantes bogota-2").
 *
 * Mutates `clusters` in place.
 */
function dedupCanonicalNames(
  clusters: TopicCluster[],
  clusterTokens: Map<string, Map<string, number>>,
): void {
  const seen = new Set<string>(); // canonical lowercase → existence
  for (const c of clusters) {
    const original = c.canonical;
    const norm = original.toLowerCase().trim();
    if (!seen.has(norm)) {
      // First occurrence — but if it's a single word, try to expand it
      // into a descriptive phrase using the cluster's secondary tokens.
      const expanded = expandToPhrase(original, clusterTokens.get(c.id));
      const expandedNorm = expanded.toLowerCase().trim();
      if (seen.has(expandedNorm)) {
        // The expansion collided with an existing name — fall through to
        // the duplicate path.
        const altName = deriveAlternativeName(original, clusterTokens.get(c.id), 2, seen);
        c.canonical = altName;
        seen.add(altName.toLowerCase().trim());
      } else {
        c.canonical = expanded;
        seen.add(expandedNorm);
      }
      continue;
    }
    // Duplicate — derive an alternative name that doesn't collide with
    // anything in `seen`.
    const altName = deriveAlternativeName(original, clusterTokens.get(c.id), 2, seen);
    c.canonical = altName;
    seen.add(altName.toLowerCase().trim());
  }
}

/**
 * FASE-3-QUALITY §3.4 — expand a single-word canonical into a short
 * descriptive phrase. Picks the top-2 most frequent tokens from the
 * cluster's frequency map and joins them with the canonical.
 *
 * If the canonical is already a multi-word phrase (contains a space) or
 * no secondary token is available, returns the canonical unchanged.
 */
function expandToPhrase(canonical: string, freq?: Map<string, number>): string {
  if (!canonical) return canonical;
  if (canonical.includes(' ')) return canonical;
  if (!freq || freq.size === 0) return canonical;
  // Find the most frequent token that is NOT the canonical itself.
  const canonNorm = canonical.toLowerCase();
  const candidates: Array<{ tok: string; count: number }> = [];
  for (const [tok, count] of freq.entries()) {
    if (tok.toLowerCase() === canonNorm) continue;
    if (tok.length < 4) continue;
    candidates.push({ tok, count });
  }
  if (candidates.length === 0) return canonical;
  candidates.sort((a, b) => b.count - a.count);
  // Take up to 2 secondary tokens to form a phrase.
  const parts = candidates.slice(0, 2).map((c) => c.tok);
  return `${canonical} ${parts.join(' ')}`;
}

/**
 * Derive an alternative canonical name for a duplicate. Strategy:
 *   - If the cluster has secondary tokens, use the top-2 to build a
 *     descriptive phrase (preferred — more meaningful).
 *   - ALWAYS append the numeric discriminator `-N` to guarantee
 *     uniqueness even when two clusters share the same top-2 tokens.
 *   - The `seen` set is consulted to find the smallest N that produces
 *     a globally-unique name.
 */
function deriveAlternativeName(
  canonical: string,
  freq: Map<string, number> | undefined,
  startN: number,
  seen: Set<string>,
): string {
  const canonNorm = canonical.toLowerCase().trim();
  let phrase = canonical;
  if (freq && freq.size > 0) {
    const candidates: Array<{ tok: string; count: number }> = [];
    for (const [tok, count] of freq.entries()) {
      if (tok.toLowerCase() === canonNorm) continue;
      // Also skip tokens that already appear in the canonical phrase
      // (so we don't append "restaurantes" to "restaurantes bogota").
      if (canonNorm.includes(tok.toLowerCase())) continue;
      if (tok.length < 4) continue;
      candidates.push({ tok, count });
    }
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.count - a.count);
      const parts = candidates.slice(0, 2).map((c) => c.tok);
      phrase = `${canonical} ${parts.join(' ')}`;
    }
  }
  // Always append -N to guarantee uniqueness.
  let n = startN;
  let candidate = `${phrase}-${n}`;
  while (seen.has(candidate.toLowerCase().trim())) {
    n++;
    candidate = `${phrase}-${n}`;
  }
  return candidate;
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
  return normalizeText(best).split(' ')[0] || fallback;
}

// ---------------------------------------------------------------------------
// AUTO STRATEGY (V1.1)
// ---------------------------------------------------------------------------

/**
 * Picks the best clustering strategy based on what's available at runtime:
 *   - If signals.length >= MIN_SIGNALS_FOR_SEMANTIC (8)
 *     AND opts.db is provided
 *     AND opts.embeddingClient is provided
 *     → semantic clustering (`clusterSignalsSemantic`)
 *   - Otherwise → token-based clustering (`clusterSignals`)
 *
 * On the semantic path, also ensures every signal in `signals` has a row in
 * `signal_embeddings`. Missing embeddings are computed in a single batch
 * and persisted (idempotent — re-running with the same DB is a no-op).
 *
 * Returns the same shape as `clusterSignals`, plus a `strategy` field so
 * callers (orchestrator, react) can log which path was taken.
 *
 * Failures in the embedding layer are NON-FATAL: if `storeEmbeddings` throws
 * (e.g., readonly DB, schema mismatch), we still proceed with semantic
 * clustering using in-memory embeddings for the current run. The signal
 * that something went wrong is the `strategy` field — when persistence
 * fails, `strategy` stays `'semantic'` but a warning is logged and the
 * `reason` notes the failure.
 */
export const MIN_SIGNALS_FOR_SEMANTIC = 8;

export interface ClusterAutoOptions {
  db?: BetterSqlite3Database;
  embeddingClient?: EmbeddingClient;
}

export interface ClusterAutoResult extends ClusterResult {
  strategy: 'semantic' | 'token';
  reason: string;
}

export async function clusterSignalsAuto(
  signals: Signal[],
  opts: ClusterAutoOptions = {},
): Promise<ClusterAutoResult> {
  const canUseSemantic =
    signals.length >= MIN_SIGNALS_FOR_SEMANTIC &&
    !!opts.db &&
    !!opts.embeddingClient;

  if (!canUseSemantic) {
    const result = clusterSignals(signals);
    const reason = signals.length < MIN_SIGNALS_FOR_SEMANTIC
      ? `too few signals (${signals.length} < ${MIN_SIGNALS_FOR_SEMANTIC})`
      : 'no db/embedding client provided';
    return { ...result, strategy: 'token', reason };
  }

  // Semantic path. 1) Ensure schema + embeddings persisted.
  const db = opts.db!;
  const client = opts.embeddingClient!;
  let persistenceOk = true;
  let persistedCount = 0;
  try {
    ensureEmbeddingsSchema(db);
    const existing = new Set(
      loadAllEmbeddings(db).map((e) => e.signalId),
    );
    const toEmbed = signals.filter((s) => !existing.has(s.id));
    if (toEmbed.length > 0) {
      // Mirror clusterSignalsSemantic's text format (keyword + topic +
      // first 200 chars of snippet). This way the EmbeddingClient cache
      // (per-instance) hits when clusterSignalsSemantic re-embeds for
      // in-memory clustering — avoiding duplicate CPU work.
      const texts = toEmbed.map(
        (s) => `${s.keyword} ${s.topic} ${s.rawSnippet.slice(0, 200)}`,
      );
      const vectors = await client.embedBatch(texts);
      persistedCount = storeEmbeddings(
        db,
        toEmbed.map((s, i) => ({ signalId: s.id, embedding: vectors[i] })),
      );
      logger.info('clusterSignalsAuto: persisted embeddings', {
        count: persistedCount,
        total: toEmbed.length,
      });
    }
  } catch (e: any) {
    persistenceOk = false;
    logger.warn('clusterSignalsAuto: embedding persistence failed', {
      err: e?.message ?? String(e),
    });
    // Don't bail — we can still cluster this run using in-memory embeddings.
  }

  // 2) Run semantic clustering (it re-embeds in-memory; that's fine — the
  //    EmbeddingClient cache makes it cheap, and semantic-cluster's own
  //    threshold was tuned for the TF-IDF-hash model).
  const reason = persistenceOk
    ? `semantic (persisted ${persistedCount} new embedding(s))`
    : 'semantic (persistence failed — in-memory only)';
  try {
    const sem = await clusterSignalsSemantic(signals, { embeddingClient: client });
    return {
      clusters: sem.clusters,
      signalToCluster: sem.signalToCluster,
      strategy: 'semantic',
      reason,
    };
  } catch (e: any) {
    logger.warn('clusterSignalsAuto: semantic clustering failed, falling back to token', {
      err: e?.message ?? String(e),
    });
    const result = clusterSignals(signals);
    return {
      ...result,
      strategy: 'token',
      reason: `semantic clustering failed: ${e?.message ?? String(e)}`,
    };
  }
}
