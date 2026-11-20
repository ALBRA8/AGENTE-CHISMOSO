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
 *
 * RONDA-2 Point 5 — descriptive phrase naming.
 *
 * Cluster canonicals MUST be descriptive phrases (2+ words), never a
 * single keyword. We produce the phrase either via the LLM (when an
 * `LLMClient` is supplied to `clusterSignalsAuto`) or via a deterministic
 * fallback that picks the top 2-3 most-frequent tokens from the cluster's
 * frequency map. See `nameClustersDescriptively` for the details.
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import type { Signal, TopicCluster } from '../models.js';
import { generateId } from '../models.js';
import { normalizeText, tokenize } from './normalizer.js';
import { clusterSignalsSemantic } from './semantic-cluster.js';
import {
  ensureEmbeddingsSchema,
  loadAllEmbeddings,
  storeEmbeddings,
} from '../db-extensions/embeddings.sql.js';
import { EmbeddingClient } from './embeddings.js';
import { logger } from '../logger.js';
import type { LLMClient, ChatMessage, LLMResponse } from '../orchestrator/llm.js';

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
  // After canonical refresh, two clusters may end up with the same
  // most-frequent token (e.g. both clusters' top token is "restaurantes").
  // We rename duplicates by appending a discriminator: the second
  // occurrence becomes "<topic>-2", the third "<topic>-3", etc. If the
  // underlying cluster has a meaningful secondary token we use that to
  // build a descriptive phrase (e.g. "restaurantes bogota" instead of
  // "restaurantes-2"); the discriminator is the fallback when no second
  // token is available.
  //
  // RONDA-2 Point 5 — every canonical is expanded into a descriptive
  // phrase of 2+ tokens. A single-token canonical is never acceptable
  // as a trend name (it tells the user nothing about the cluster).
  dedupCanonicalNames(clusters, clusterTokens);

  return { clusters, signalToCluster };
}

// ---------------------------------------------------------------------------
// RONDA-2 Point 5 — descriptive phrase naming
// ---------------------------------------------------------------------------

/**
 * The LLM prompt used to name a cluster. Asks for a 5-8 word descriptive
 * phrase that summarises what the cluster's signals have in common.
 *
 * The prompt is in Spanish because most CHISMOSO investigations target
 * LATAM markets, and the canonical names flow directly into the
 * user-facing report. The LLM is free to respond in either Spanish or
 * English depending on the input language.
 */
const CLUSTER_NAME_SYSTEM_PROMPT = `You are CHISMOSO's cluster naming assistant.
You receive a list of signal snippets that all belong to the same topic cluster.
Produce a short, descriptive phrase that summarises what these signals have in common.

Rules:
  - Output ONLY the phrase, no quotes, no preamble, no explanation.
  - The phrase MUST be between 5 and 8 words.
  - Use the same language as the majority of the signals (Spanish signals → Spanish phrase).
  - Do NOT include generic words like "trend", "tendencia", "topic", "cluster".
  - Capture the SPECIFIC phenomenon (e.g. "automatización de reservas por WhatsApp en restaurantes"
    is good; "tendencia de restaurantes" is bad).`;

/**
 * Build the user-side prompt for naming a single cluster. Includes up to
 * 8 sample snippets (truncated to 200 chars each) so the LLM has enough
 * context without paying for every signal in a large cluster.
 */
function buildClusterNameUserPrompt(cluster: TopicCluster, signals: Signal[]): string {
  const clusterSignals = cluster.signalIds
    .map((sid) => signals.find((s) => s.id === sid))
    .filter(Boolean) as Signal[];
  const samples = clusterSignals.slice(0, 8);
  const lines = samples.map((s, i) => `  [${i + 1}] ${s.rawSnippet.slice(0, 200)}`);
  return `Cluster (id=${cluster.id}, ${clusterSignals.length} signals):\n${lines.join('\n')}\n\nProduce the 5-8 word descriptive phrase now.`;
}

/**
 * Validate that an LLM-produced name is a usable descriptive phrase.
 * Returns the cleaned phrase when valid, or `null` when the LLM
 * output is unusable (caller falls back to the deterministic path).
 *
 * Validation rules:
 *   - Strip surrounding quotes / whitespace.
 *   - Strip any trailing period.
 *   - Tokenise by whitespace; require 5-8 tokens of length >= 2.
 *   - Reject if the cleaned phrase is the empty string.
 */
function cleanLlmName(raw: string): string | null {
  if (!raw) return null;
  let s = raw.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!s) return null;
  // Strip trailing period (LLMs sometimes end a phrase with `.`).
  if (s.endsWith('.')) s = s.slice(0, -1).trim();
  if (!s) return null;
  const tokens = s.split(/\s+/).filter((t) => t.length >= 2);
  // Accept 5-8 words per the prompt; allow 4 as a tolerance margin for
  // compact phrases (the LLM sometimes produces "restaurantes adoptan IA
  // para reservas" = 5 tokens which is fine).
  if (tokens.length < 4 || tokens.length > 10) return null;
  return tokens.join(' ');
}

/**
 * Deterministic fallback: build a descriptive phrase from the cluster's
 * top 2-3 most-frequent tokens. Always produces at least a 2-token
 * phrase, even when the cluster has only one frequent token (in that
 * edge case we append the cluster's first signal keyword).
 */
function buildPhraseFallback(
  canonical: string,
  freq: Map<string, number> | undefined,
  fallbackKeyword: string,
): string {
  // If the canonical is already a multi-word phrase (e.g. the first
  // signal's topic), keep it.
  if (canonical && canonical.includes(' ')) return canonical;

  const canonNorm = canonical.toLowerCase().trim();
  const candidates: Array<{ tok: string; count: number }> = [];
  if (freq) {
    for (const [tok, count] of freq.entries()) {
      if (tok.length < 4) continue;
      if (tok.toLowerCase() === canonNorm) continue;
      candidates.push({ tok, count });
    }
    candidates.sort((a, b) => b.count - a.count);
  }

  // Take up to 2 secondary tokens to form a phrase alongside the
  // canonical keyword.
  const parts = candidates.slice(0, 2).map((c) => c.tok);
  if (parts.length >= 2) {
    return `${canonical} ${parts.join(' ')}`;
  }
  if (parts.length === 1) {
    return `${canonical} ${parts[0]}`;
  }
  // Edge case: no secondary tokens at all (extremely rare — the
  // cluster's signals only produced one tokenisable keyword). Append
  // the first signal's keyword (which is usually multi-character) to
  // guarantee at least a 2-token phrase.
  const extra = fallbackKeyword && fallbackKeyword.trim() ? fallbackKeyword.trim() : 'topic';
  if (extra.toLowerCase() === canonNorm) {
    return `${canonical} trend`;
  }
  return `${canonical} ${extra}`;
}

/**
 * RONDA-2 Point 5 — name each cluster with a descriptive phrase.
 *
 * For every cluster in `clusters`:
 *   1. If `opts.llm` is provided, ask the LLM to summarise the cluster's
 *      signals in 5-8 words. If the LLM returns a valid phrase (4-10
 *      tokens, no preamble/quotes), use it as the canonical.
 *   2. Otherwise (or when the LLM call fails / returns unusable output),
 *      use the deterministic fallback: the top 2-3 most-frequent tokens
 *      from the cluster's frequency map, joined with the canonical
 *      keyword.
 *
 * The function MUTATES the clusters in place (replaces `canonical`).
 *
 * Uniqueness is preserved: if two LLM responses collide, the second one
 * gets a `-2` discriminator appended (same scheme as the sync path).
 *
 * Failures in the LLM call are NON-FATAL — we log a warning and fall
 * back to the deterministic phrase for that cluster. The caller
 * (orchestrator / react) never sees a half-named cluster.
 */
export async function nameClustersDescriptively(
  clusters: TopicCluster[],
  signals: Signal[],
  opts: { llm?: LLMClient; clusterTokens?: Map<string, Map<string, number>> } = {},
): Promise<{ named: number; llmUsed: number; fallbackUsed: number }> {
  const seen = new Set<string>();
  let llmUsed = 0;
  let fallbackUsed = 0;

  // Pre-seed `seen` with the current canonicals so the LLM doesn't
  // accidentally collide with a name we've already kept.
  for (const c of clusters) {
    seen.add(c.canonical.toLowerCase().trim());
  }

  for (const c of clusters) {
    const freq = opts.clusterTokens?.get(c.id);
    // Pick the first signal's keyword as the fallback "extra" token.
    const firstSignal = signals.find((s) => s.id === c.signalIds[0]);
    const fallbackKeyword = firstSignal?.keyword ?? '';

    let nextCanonical: string | null = null;

    if (opts.llm) {
      try {
        const messages: ChatMessage[] = [
          { role: 'system', content: CLUSTER_NAME_SYSTEM_PROMPT },
          { role: 'user', content: buildClusterNameUserPrompt(c, signals) },
        ];
        const resp: LLMResponse = await opts.llm.chat(messages);
        nextCanonical = cleanLlmName(resp.content);
        if (nextCanonical) {
          llmUsed++;
        } else {
          logger.warn('cluster name LLM returned unusable phrase, falling back', {
            clusterId: c.id,
            rawContentLen: resp.content.length,
          });
        }
      } catch (e: any) {
        logger.warn('cluster name LLM call failed, falling back', {
          clusterId: c.id,
          err: e?.message ?? String(e),
        });
      }
    }

    if (!nextCanonical) {
      nextCanonical = buildPhraseFallback(c.canonical, freq, fallbackKeyword);
      fallbackUsed++;
    }

    // Uniqueness pass — append -N discriminator on collision.
    const norm = nextCanonical.toLowerCase().trim();
    if (seen.has(norm) && norm !== c.canonical.toLowerCase().trim()) {
      let n = 2;
      let candidate = `${nextCanonical}-${n}`;
      while (seen.has(candidate.toLowerCase().trim())) {
        n++;
        candidate = `${nextCanonical}-${n}`;
      }
      nextCanonical = candidate;
    }
    seen.add(nextCanonical.toLowerCase().trim());

    c.canonical = nextCanonical;
  }

  return { named: clusters.length, llmUsed, fallbackUsed };
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
      // First occurrence — expand the canonical into a descriptive
      // phrase using the cluster's secondary tokens.
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
 * FASE-3-QUALITY §3.4 — expand a canonical into a short descriptive
 * phrase. Picks the top-2 most frequent tokens from the cluster's
 * frequency map and joins them with the canonical.
 *
 * If the canonical is already a multi-word phrase (contains a space), it
 * is returned unchanged — we trust the upstream caller's phrase.
 *
 * RONDA-2 Point 5 — when no secondary token is available, we no longer
 * return the bare canonical. We append the cluster's most frequent
 * short token (length >= 3) so every trend name is at least a 2-token
 * phrase. The deterministic fallback in `nameClustersDescriptively`
 * (called by `clusterSignalsAuto`) is the authoritative source of the
 * final phrase; this sync-time expansion is a best-effort for callers
 * that use `clusterSignals` directly.
 */
function expandToPhrase(canonical: string, freq?: Map<string, number>): string {
  if (!canonical) return canonical;
  if (canonical.includes(' ')) return canonical;
  if (!freq || freq.size === 0) {
    // No frequency data — append a generic qualifier so the name is
    // never a bare keyword. The LLM / fallback in `clusterSignalsAuto`
    // will replace this with a real phrase when invoked.
    return `${canonical} trend`;
  }
  // Find the most frequent token that is NOT the canonical itself.
  const canonNorm = canonical.toLowerCase();
  const candidates: Array<{ tok: string; count: number }> = [];
  for (const [tok, count] of freq.entries()) {
    if (tok.toLowerCase() === canonNorm) continue;
    if (tok.length < 4) continue;
    candidates.push({ tok, count });
  }
  if (candidates.length === 0) {
    // No 4+ char secondary token — relax to 3-char tokens.
    for (const [tok, count] of freq.entries()) {
      if (tok.toLowerCase() === canonNorm) continue;
      if (tok.length < 3) continue;
      candidates.push({ tok, count });
    }
  }
  if (candidates.length === 0) return `${canonical} trend`;
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
    } else {
      phrase = `${canonical} trend`;
    }
  } else {
    phrase = `${canonical} trend`;
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
 *
 * RONDA-2 Point 5 — after clustering (either path), the canonical names
 * are upgraded to descriptive phrases via `nameClustersDescriptively`.
 * When `opts.llm` is provided, the LLM is asked to summarise each
 * cluster in 5-8 words; otherwise the deterministic fallback picks the
 * top 2-3 most-frequent tokens as the phrase. Either way, no trend name
 * leaves this function as a bare keyword.
 */
export const MIN_SIGNALS_FOR_SEMANTIC = 8;

export interface ClusterAutoOptions {
  db?: BetterSqlite3Database;
  embeddingClient?: EmbeddingClient;
  /** RONDA-2 Point 5 — optional LLM client for descriptive cluster naming. */
  llm?: LLMClient;
  /**
   * RONDA-2 Point 5 — optional objective text. Passed to the LLM as
   * context so cluster names align with the investigation's intent.
   */
  objective?: string;
}

export interface ClusterAutoResult extends ClusterResult {
  strategy: 'semantic' | 'token';
  reason: string;
  /** RONDA-2 Point 5 — naming telemetry: how many clusters got LLM names vs fallback. */
  naming: { named: number; llmUsed: number; fallbackUsed: number };
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
    // RONDA-2 Point 5 — upgrade canonicals to descriptive phrases.
    // On the token path we have the per-cluster frequency map available
    // via a small reconstruction (we don't have it from clusterSignals's
    // return value, so the LLM / fallback builds it from the signals).
    const naming = await nameClustersDescriptively(result.clusters, signals, {
      llm: opts.llm,
    });
    return { ...result, strategy: 'token', reason, naming };
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
    // RONDA-2 Point 5 — upgrade canonicals to descriptive phrases. The
    // semantic path doesn't expose the per-cluster frequency map, so the
    // LLM (if provided) does the naming; the deterministic fallback
    // rebuilds the frequency map from the cluster's signals on the fly.
    const naming = await nameClustersDescriptively(sem.clusters, signals, {
      llm: opts.llm,
    });
    return {
      clusters: sem.clusters,
      signalToCluster: sem.signalToCluster,
      strategy: 'semantic',
      reason,
      naming,
    };
  } catch (e: any) {
    logger.warn('clusterSignalsAuto: semantic clustering failed, falling back to token', {
      err: e?.message ?? String(e),
    });
    const result = clusterSignals(signals);
    const naming = await nameClustersDescriptively(result.clusters, signals, {
      llm: opts.llm,
    });
    return {
      ...result,
      strategy: 'token',
      reason: `semantic clustering failed: ${e?.message ?? String(e)}`,
      naming,
    };
  }
}
