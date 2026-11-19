/**
 * CHISMOSO V1.0 — Relevance Scoring (FASE-3-QUALITY §3.1)
 *
 * Score signals 0-1 against the investigation objective + geography.
 * Signals below threshold (0.3 default) are marked `irrelevant` in
 * metadata and excluded from clustering/trend/opportunity analysis.
 *
 * Strategy (deterministic + documented, no LLM dependency):
 *   1. Tokenize the objective into keywords (reuse normalizer.tokenize).
 *   2. For each signal, compute lexical overlap between its
 *      (keyword + topic + rawSnippet) and the objective tokens.
 *   3. Geography match: if the signal mentions the target country (or
 *      comes from a `.co`-like local domain), bump the score. If the
 *      geography is `global`, skip this check.
 *   4. Date decay: signals older than 90 days lose relevance (§3.3).
 *
 * Output:
 *   - `scoreRelevance()` returns a 0..1 score.
 *   - `applyRelevance()` mutates the signal's metadata in place,
 *     attaching `{ relevance: { score, irrelevant, reason } }`.
 *   - `filterRelevant()` returns only the signals that pass the
 *      threshold, plus a count of discarded signals for telemetry.
 *
 * These functions are pure — they don't touch the DB. Persistence of
 * the discarded count is the orchestrator's job (recorded into the
 * investigation metadata).
 */

import type { Signal } from '../models.js';
import { tokenize, normalizeText } from './normalizer.js';
// `RELEVANCE_DECAY_DAYS` is owned by trends.ts (the original exporter).
// Re-import here instead of redeclaring to keep a single source of truth
// and avoid a duplicate-export error when both modules are barrel-exported
// via `intelligence/index.ts`.
import { RELEVANCE_DECAY_DAYS } from './trends.js';

/** Default relevance threshold (0..1). Signals below this are `irrelevant`. */
export const DEFAULT_RELEVANCE_THRESHOLD = 0.3;

export interface RelevanceContext {
  /** Original investigation objective (free-text). */
  objective: string;
  /** Country name or 'global'. e.g. 'Colombia', 'Perú', 'global'. */
  geography: string;
  /** Override threshold (default 0.3). */
  threshold?: number;
}

export interface RelevanceVerdict {
  score: number;
  irrelevant: boolean;
  reason: string;
}

/**
 * Geographic aliases → expected country TLD suffix + a few local domain
 * substrings. Used to give a small boost to signals from local domains.
 */
const GEO_DOMAIN_HINTS: Record<string, { tld: string; domains: string[]; aliases: string[] }> = {
  colombia: { tld: '.co', domains: ['eltiempo.com', 'elespectador.com', 'semana.com', 'portafolio.com.co', 'dinero.com', 'larepublica.co'], aliases: ['colombia', 'colombiano', 'colombiana', 'bogota', 'medellin', 'cali', 'barranquilla'] },
  peru: { tld: '.pe', domains: ['elcomercio.pe', 'larepublica.pe', 'rpp.pe', 'gestion.pe', 'andina.pe'], aliases: ['peru', 'peruano', 'peruana', 'lima', 'cusco', 'arequipa'] },
  mexico: { tld: '.mx', domains: ['eluniversal.com.mx', 'excelsior.com.mx', 'milenio.com', 'proceso.com.mx'], aliases: ['mexico', 'mexicano', 'mexicana', 'cdmx', 'guadalajara', 'monterrey'] },
  argentina: { tld: '.ar', domains: ['clarin.com', 'lanacion.com.ar', 'pagina12.com.ar', 'infobae.com'], aliases: ['argentina', 'argentino', 'argentina', 'buenos aires', 'cordoba', 'rosario'] },
  chile: { tld: '.cl', domains: ['emol.com', 'latercera.com', 'biobiochile.cl', 'chvnoticias.cl'], aliases: ['chile', 'chileno', 'chilena', 'santiago'] },
  espana: { tld: '.es', domains: ['elpais.com', 'elmundo.es', 'abc.es', '20minutos.es'], aliases: ['espana', 'espanol', 'espanola', 'madrid', 'barcelona', 'valencia'] },
  spain: { tld: '.es', domains: ['elpais.com', 'elmundo.es', 'abc.es', '20minutos.es'], aliases: ['spain', 'spanish', 'madrid', 'barcelona'] },
};

function resolveGeoKey(geography: string): string | undefined {
  const g = normalizeText(geography);
  if (!g || g === 'global') return undefined;
  if (GEO_DOMAIN_HINTS[g]) return g;
  // Try common Spanish aliases → canonical key.
  for (const key of Object.keys(GEO_DOMAIN_HINTS)) {
    const entry = GEO_DOMAIN_HINTS[key];
    if (entry.aliases.some((a) => normalizeText(a) === g)) return key;
  }
  return undefined;
}

/**
 * Score a single signal against the objective + geography.
 *
 * The score is a sum of:
 *   - lexicalOverlap: Jaccard between objective tokens and signal tokens
 *     (capped at 0.6).
 *   - geographyBoost: +0.15 if signal mentions the target country or
 *     comes from a local domain. +0.05 if it just contains the country
 *     name in title/snippet.
 *   - decayPenalty: -0.1..-0.4 for signals older than 90 days.
 *
 * Returned value is clamped to [0, 1].
 */
export function scoreRelevance(signal: Signal, ctx: RelevanceContext): number {
  const objTokens = new Set(tokenize(ctx.objective));
  if (objTokens.size === 0) {
    // No objective tokens → can't meaningfully score. Default to neutral
    // (relevant unless geography clearly excludes it).
    return 0.5;
  }

  const sigText = `${signal.keyword} ${signal.topic} ${(signal.rawSnippet ?? '').slice(0, 400)}`;
  const sigTokens = new Set(tokenize(sigText));
  if (sigTokens.size === 0) return 0;

  // Jaccard-ish overlap (intersection / min(|A|, |B|)) — overlap
  // coefficient is more permissive when signal has few tokens.
  let intersection = 0;
  for (const t of sigTokens) if (objTokens.has(t)) intersection++;
  const minSize = Math.min(objTokens.size, sigTokens.size);
  const lexicalOverlap = minSize === 0 ? 0 : Math.min(0.7, (intersection / minSize) * 0.95);

  // Geography boost.
  let geoBoost = 0;
  const geoKey = resolveGeoKey(ctx.geography);
  if (geoKey) {
    const hint = GEO_DOMAIN_HINTS[geoKey];
    const sigTextNorm = normalizeText(sigText);
    const url = signal.url ?? '';
    if (hint.domains.some((d) => url.includes(d))) geoBoost += 0.15;
    if (url.endsWith(hint.tld) || url.includes(`${hint.tld}/`)) geoBoost += 0.05;
    if (hint.aliases.some((a) => sigTextNorm.includes(normalizeText(a)))) geoBoost += 0.05;
  }

  // Date decay — penalize signals whose observedAt is older than
  // RELEVANCE_DECAY_DAYS. Use observedAt (publication date) when
  // available; fall back to timestamp (capture time) otherwise.
  //
  // The decay is intentionally a SMALL penalty (max 0.25 at 1 year)
  // so a high-overlap signal still passes the relevance threshold
  // even when it's somewhat stale. The penalty is enough to demote
  // marginally-relevant old signals, but not enough to zero out a
  // clearly-relevant one.
  const when = signal.observedAt ?? signal.timestamp;
  let decay = 0;
  const t = Date.parse(when);
  if (!Number.isNaN(t)) {
    const ageDays = (Date.now() - t) / (24 * 3600 * 1000);
    if (ageDays > RELEVANCE_DECAY_DAYS) {
      // Linear decay from 0.05 (just past threshold) up to 0.25 at 1 year.
      decay = Math.min(0.25, 0.05 + ((ageDays - RELEVANCE_DECAY_DAYS) / 365) * 0.2);
    }
  }

  const score = lexicalOverlap + geoBoost - decay;
  return Math.max(0, Math.min(1, score));
}

/**
 * Decide whether a signal is relevant given the threshold.
 */
export function verdictFor(signal: Signal, ctx: RelevanceContext): RelevanceVerdict {
  const threshold = ctx.threshold ?? DEFAULT_RELEVANCE_THRESHOLD;
  const score = scoreRelevance(signal, ctx);
  if (score < threshold) {
    return {
      score,
      irrelevant: true,
      reason: `score ${score.toFixed(2)} < threshold ${threshold.toFixed(2)}`,
    };
  }
  return { score, irrelevant: false, reason: `score ${score.toFixed(2)} >= threshold ${threshold.toFixed(2)}` };
}

/**
 * Attach the relevance verdict to `signal.metadata.relevance` in place.
 * Returns the same signal reference for fluent chaining.
 */
export function applyRelevance(signal: Signal, ctx: RelevanceContext): Signal {
  const verdict = verdictFor(signal, ctx);
  signal.metadata = {
    ...(signal.metadata ?? {}),
    relevance: {
      score: Math.round(verdict.score * 100) / 100,
      irrelevant: verdict.irrelevant,
      reason: verdict.reason,
      objective: ctx.objective.slice(0, 120),
      geography: ctx.geography,
    },
  };
  return signal;
}

/**
 * Filter a list of signals down to the relevant ones (those whose
 * relevance score >= threshold). Each kept signal has its verdict
 * recorded in metadata. The discarded count is returned for telemetry.
 *
 * Signals already marked `irrelevant` in metadata (e.g. by a previous
 * pass) are honored and excluded.
 */
export interface RelevanceFilterResult {
  relevant: Signal[];
  discarded: number;
  total: number;
  threshold: number;
}

export function filterRelevant(signals: Signal[], ctx: RelevanceContext): RelevanceFilterResult {
  const threshold = ctx.threshold ?? DEFAULT_RELEVANCE_THRESHOLD;
  let discarded = 0;
  const relevant: Signal[] = [];
  for (const s of signals) {
    applyRelevance(s, ctx);
    const meta = s.metadata?.relevance as { irrelevant?: boolean } | undefined;
    if (meta?.irrelevant === true) {
      discarded++;
    } else {
      relevant.push(s);
    }
  }
  return {
    relevant,
    discarded,
    total: signals.length,
    threshold,
  };
}
