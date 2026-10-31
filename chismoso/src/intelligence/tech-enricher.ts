/**
 * CHISMOSO V1.0 — Tech Enricher (Task FRENTE-B-CHISMOSO-CLONAKIT)
 *
 * Hooks the ClonaKit provider into the signal pipeline so every signal
 * CHISMOSO detects gets "destripped" with:
 *
 *   - techStack        — frameworks mencionados en la senal, validados
 *                        contra el mapping de ClonaKit (57 entries).
 *   - webEquivalents   — equivalentes web para cada framework conocido.
 *   - fichaSnippet     — ficha tecnica inicial en markdown.
 *
 * The enrichment is **idempotent and side-effect-free**: it reads
 * `signal.rawSnippet` and the static CAPABILITY_MAPPING, and returns a new
 * signal object that preserves every original field. It never reaches the
 * network, never throws on unknown frameworks (they get listed under
 * "no validados" in the ficha snippet), and never modifies the input.
 *
 * When no tech mentions are found, the function returns the signal
 * unchanged (same reference, not a copy) so callers can cheaply detect
 * "nothing changed" via reference equality.
 *
 * The enrichment is ALSO persisted into `signal.metadata.clonakit_enrichment`
 * so the data survives a DB round-trip (the SignalRepository stores only
 * the canonical Signal fields, but `metadata` is JSON-stringified as a
 * blob — see src/repositories.ts).
 *
 * Opt-in / opt-out:
 *   - Default ON (the task spec says `clonakit_enrichment: true` default).
 *   - Callers can disable by passing `{ clonakit_enrichment: false }` in
 *     the NormalizeContext (see normalizer.ts) or by setting
 *     `CHISMOSO_CLONAKIT_ENRICHMENT=false` in the environment (see
 *     config/index.ts).
 */

import type { Signal } from '../models.js';
import {
  clonakitProvider,
  type ValidatedCapability,
  type WebEquivalent,
} from '../providers/clonakit.js';

// ---------------------------------------------------------------------------
// PUBLIC TYPES
// ---------------------------------------------------------------------------

/**
 * A signal enriched with ClonaKit tech intelligence.
 *
 * The three new fields are optional because `enrichSignalWithTech` returns
 * the signal unchanged when no tech mentions are found.
 *
 * These fields are NOT persisted as top-level Signal columns — they live
 * in `signal.metadata.clonakit_enrichment` for persistence. The top-level
 * fields exist for in-memory consumers (the destripar_tecnologia tool,
 * the dashboard, MCP clients) that want structured access without
 * re-running the enrichment.
 */
export type EnrichedSignal = Signal & {
  /** Each mentioned framework, validated against the ClonaKit mapping. */
  techStack?: ValidatedCapability[];
  /** Web-equivalent recommendations for the known frameworks. */
  webEquivalents?: WebEquivalent[];
  /** Markdown "ficha tecnica inicial" snippet. Empty string when no mentions. */
  fichaSnippet?: string;
};

// ---------------------------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------------------------

/**
 * Enrich a single signal with ClonaKit tech intelligence.
 *
 * Steps:
 *   1. extractTechMentions(signal.rawSnippet) —> string[] of framework names
 *   2. If empty, return signal unchanged (same reference).
 *   3. validateCapabilities(mentioned) —> ValidatedCapability[]
 *   4. buildFichaSnippet(mentioned) —> markdown string
 *   5. Build webEquivalents from the validated known capabilities.
 *   6. Return a new signal object with techStack, webEquivalents,
 *      fichaSnippet attached, AND a `metadata.clonakit_enrichment` blob
 *      for persistence.
 *
 * The original signal is NOT mutated. We spread it into a new object so
 * callers that hold the old reference still see the un-enriched version
 * (useful for tests and for the "no tech mentions" fast path).
 */
export function enrichSignalWithTech(signal: Signal): EnrichedSignal {
  if (!signal) return signal;
  const snippet = signal.rawSnippet ?? '';
  if (!snippet.trim()) return signal;

  const mentioned = clonakitProvider.extractTechMentions(snippet);
  if (mentioned.length === 0) return signal;

  const techStack = clonakitProvider.validateCapabilities(mentioned);
  const fichaSnippet = clonakitProvider.buildFichaSnippet(mentioned);
  const webEquivalents = buildWebEquivalents(techStack);

  // Persist the enrichment into metadata so it survives a DB round-trip.
  // We do NOT overwrite the existing `detected_tech` array (set by the
  // normalizer's basic enrichment) — `clonakit_enrichment` is the richer
  // payload that includes validation + ficha snippet.
  const metadata = {
    ...(signal.metadata ?? {}),
    clonakit_enrichment: {
      techStack,
      webEquivalents,
      fichaSnippet,
      mentionedCount: mentioned.length,
      knownCount: techStack.filter((t) => t.exists).length,
      unknownCount: techStack.filter((t) => !t.exists).length,
    },
  };

  return {
    ...signal,
    metadata,
    techStack,
    webEquivalents,
    fichaSnippet,
  };
}

/**
 * Batch helper — enrich an array of signals.
 *
 * Returns a NEW array (the input is not mutated). Signals with no tech
 * mentions are passed through by reference (the enricher returns the same
 * object), so the output array shares references with the input for
 * unchanged signals. This makes the function cheap to call on large
 * batches even when most signals have no tech mentions.
 *
 * @param signals  the batch to enrich
 * @param enabled  when false, returns the input array unchanged (no copy).
 *                  When true/undefined, enriches each signal.
 */
export function enrichSignalsWithTech(
  signals: Signal[],
  enabled: boolean = true,
): EnrichedSignal[] {
  if (!enabled) return signals;
  if (!signals || signals.length === 0) return signals;
  return signals.map((s) => enrichSignalWithTech(s));
}

// ---------------------------------------------------------------------------
// INTERNAL HELPERS
// ---------------------------------------------------------------------------

/**
 * Build the `webEquivalents` array from validated capabilities.
 *
 * Only `exists: true` entries contribute. Each entry becomes one
 * `WebEquivalent` (the raw `web_equivalent` string from the mapping —
 * callers that want discrete options split on " o ").
 */
function buildWebEquivalents(techStack: ValidatedCapability[]): WebEquivalent[] {
  const out: WebEquivalent[] = [];
  for (const v of techStack) {
    if (!v.exists) continue;
    if (!v.web_equivalent || !v.category) continue;
    out.push({
      framework: v.framework,
      web_equivalent: v.web_equivalent,
      category: v.category,
    });
  }
  return out;
}
