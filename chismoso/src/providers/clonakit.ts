/**
 * CHISMOSO V1.0 — ClonaKit Provider (Task FRENTE-B-CHISMOSO-CLONAKIT)
 *
 * Makes ClonaKit an **official provider** in the CHISMOSO provider registry.
 *
 * ClonaKit is the source of the 57-framework → web-equivalent capability
 * mapping that CHISMOSO already ships in `src/intelligence/capability-mapping.ts`
 * (ported from ClonaKit's `herramientas/capacidades.mjs`). Before this task,
 * that mapping was only used to enrich fichas and to bump Opportunity
 * marketFit. With this provider, every signal CHISMOSO detects gets
 * "destripped" with:
 *
 *   - Stack tecnico detectado   (frameworks mencionados en la senal)
 *   - Validacion cruzada        (las capacidades mencionadas existen en el mapping?)
 *   - web_equivalent generado   (como se hace en la web)
 *   - Ficha tecnica inicial     (markdown snippet)
 *
 * This provider is **pure and local** — it does NOT hit the network. Its
 * `health()` is always OK because the mapping is a static in-memory table.
 * Its `search()` scans the mapping for frameworks whose `framework`,
 * `purpose`, or `web_equivalent` match the query string, and returns one
 * `RawItem` per match so the rest of the pipeline (normalizer -> signals ->
 * evidence) can ingest them like any other provider's output.
 *
 * In addition to the standard `IProvider` surface, this class exposes three
 * helper methods used by the tech-enricher (`src/intelligence/tech-enricher.ts`)
 * and by the `destripar_tecnologia` orchestrator tool:
 *
 *   - extractTechMentions(text)        -> string[]  (framework names found)
 *   - validateCapabilities(mentioned)  -> ValidatedCapability[]
 *   - buildFichaSnippet(mentioned)     -> string    (markdown)
 *
 * Boundary (see docs/CLONAKIT_INTEGRATION.md):
 *   - This provider reads ONLY from the local CAPABILITY_MAPPING.
 *   - It never calls out to ClonaKit's binary tools (REA, etc.).
 *   - It never reads source code or assets from any product.
 */

import {
  makeCapabilities,
  type IProvider,
  type ProviderQuery,
  type ProviderSearchResult,
  type RawItem,
} from './base.js';
import { ProviderHealth, SourceType } from '../models.js';
import { logger } from '../logger.js';
import {
  CAPABILITY_MAPPING,
  CAPABILITY_COUNT,
  detectTechMentions,
  lookupCapability,
  type CapabilityCategory,
  type CapabilityEntry,
} from '../intelligence/capability-mapping.js';

// ---------------------------------------------------------------------------
// PUBLIC TYPES
// ---------------------------------------------------------------------------

/**
 * Result of validating a single framework name against the ClonaKit mapping.
 *
 * - When `exists === true`, the entry was found and `web_equivalent` /
 *   `category` / `purpose` are populated from the mapping.
 * - When `exists === false`, the framework was mentioned but is NOT in the
 *   57-entry table. Callers can decide whether to log, surface as "unknown
 *   tech", or ignore.
 */
export interface ValidatedCapability {
  framework: string;
  exists: boolean;
  purpose?: string;
  web_equivalent?: string;
  category?: CapabilityCategory;
}

/**
 * A web-equivalent recommendation derived from a mentioned framework.
 *
 * `web_equivalent` is the raw string from the mapping (e.g.
 * "IndexedDB o localStorage"); callers that want discrete options should
 * split on " o ".
 */
export interface WebEquivalent {
  framework: string;
  web_equivalent: string;
  category: CapabilityCategory;
}

// ---------------------------------------------------------------------------
// PROVIDER
// ---------------------------------------------------------------------------

export class ClonaKitProvider implements IProvider {
  /**
   * Source type for ClonaKit-derived signals.
   *
   * We reuse `WEB_CONTENT` because (a) ClonaKit's output IS structured
   * content about frameworks, and (b) adding a new `SourceType` enum value
   * would require touching `inferSignalType` and the DB schema. The
   * `source` field on each Signal stays `'clonakit'` so callers can
   * distinguish ClonaKit-originated signals from `web_content` ones.
   */
  private static readonly SOURCE_TYPE: SourceType = SourceType.WEB_CONTENT;

  capabilities() {
    return makeCapabilities(
      'clonakit',
      ClonaKitProvider.SOURCE_TYPE,
      ['search', 'extract', 'validate', 'ficha'],
      ProviderHealth.OK,
      'none',
      // No rate limits — it's a static in-memory lookup.
      { requestsPerMinute: Number.MAX_SAFE_INTEGER, maxResultsPerCall: CAPABILITY_COUNT },
    );
  }

  canHandle(): boolean {
    // ClonaKit can answer any textual query — it will simply return 0
    // matches for queries that don't intersect any framework name/purpose.
    return true;
  }

  async health(): Promise<ProviderHealth> {
    // The mapping is loaded at module init. If the module loaded, we're healthy.
    return ProviderHealth.OK;
  }

  /**
   * Search the CAPABILITY_MAPPING for frameworks whose `framework`,
   * `purpose`, or `web_equivalent` contain the query string
   * (case-insensitive substring match).
   *
   * Returns one `RawItem` per match. Each item's `snippet` is crafted so
   * that `detectTechMentions()` will re-find the framework name when the
   * normalizer runs — i.e. the framework name appears as a standalone
   * word. This keeps the round-trip consistent: searching for "video"
   * returns AVFoundation, and the resulting signal will have
   * `metadata.detected_tech = [{ framework: 'AVFoundation', ... }]`.
   */
  async search(q: ProviderQuery): Promise<ProviderSearchResult> {
    const t0 = Date.now();
    const query = (q?.query ?? '').trim().toLowerCase();
    if (!query) {
      return {
        providerName: 'clonakit',
        items: [],
        durationMs: 0,
        query: q?.query ?? '',
      };
    }

    const items: RawItem[] = [];
    for (const entry of Object.values(CAPABILITY_MAPPING)) {
      const haystack = [
        entry.framework,
        entry.purpose,
        entry.web_equivalent,
        entry.category,
      ].join(' \u0001 ').toLowerCase();
      if (haystack.includes(query)) {
        items.push(this.entryToRawItem(entry));
      }
    }

    // Respect an explicit `num` cap; default to all matches (the table is
    // only 57 entries — even a "video" query returns <15).
    const cap = q.num && q.num > 0 ? q.num : items.length;
    const capped = items.slice(0, cap);

    logger.debug('ClonaKitProvider search', {
      query: q.query,
      matches: capped.length,
      durationMs: Date.now() - t0,
    });

    return {
      providerName: 'clonakit',
      items: capped,
      durationMs: Date.now() - t0,
      query: q.query,
    };
  }

  // -------------------------------------------------------------------------
  // TECH-ENRICHER HELPERS — used by tech-enricher.ts + destripar_tecnologia
  // -------------------------------------------------------------------------

  /**
   * Scan a text snippet for mentions of known ClonaKit frameworks.
   * Returns the canonical (PascalCase) framework names found.
   *
   * Delegates to `detectTechMentions()` in capability-mapping.ts (which
   * uses word-boundary matching to avoid false positives like "Network"
   * inside "networking") and projects the result to just the names.
   *
   * @example extractTechMentions('This app uses AVFoundation and CoreData')
   *            // -> ['AVFoundation', 'CoreData']
   */
  extractTechMentions(text: string): string[] {
    if (!text) return [];
    const mentions = detectTechMentions(text);
    return mentions.map((m) => m.entry.framework);
  }

  /**
   * For each framework name in `mentioned`, look it up in the ClonaKit
   * mapping and return a `ValidatedCapability`.
   *
   * - Names that resolve get `{ exists: true, purpose, web_equivalent, category }`.
   * - Names that don't resolve get `{ exists: false }`.
   *
   * Lookup is case-insensitive (so "avfoundation" and "AVFoundation" both
   * resolve to the same entry). The result preserves the order of the
   * input and deduplicates case-insensitively.
   *
   * @example validateCapabilities(['AVFoundation', 'React', 'coredata'])
   *            // -> [{ framework:'AVFoundation', exists:true, ... },
   *            //    { framework:'React',       exists:false       },
   *            //    { framework:'coredata',    exists:true, ...   }]
   */
  validateCapabilities(mentioned: string[]): ValidatedCapability[] {
    if (!mentioned || mentioned.length === 0) return [];
    const seen = new Set<string>();
    const out: ValidatedCapability[] = [];
    for (const raw of mentioned) {
      const framework = String(raw ?? '').trim();
      if (!framework) continue;
      const key = framework.toLowerCase();
      if (seen.has(key)) continue; // dedup case-insensitively
      seen.add(key);
      const entry: CapabilityEntry | undefined = lookupCapability(framework);
      if (entry) {
        out.push({
          framework: entry.framework,
          exists: true,
          purpose: entry.purpose,
          web_equivalent: entry.web_equivalent,
          category: entry.category,
        });
      } else {
        out.push({ framework, exists: false });
      }
    }
    return out;
  }

  /**
   * Build a markdown "ficha tecnica inicial" summarising the tech stack
   * detected in a signal.
   *
   * Unknown frameworks (not in the mapping) are listed under a separate
   * "No validados contra ClonaKit" section so the operator can see them
   * and decide whether to extend the mapping.
   *
   * Returns an empty string when `mentioned` is empty.
   */
  buildFichaSnippet(mentioned: string[]): string {
    if (!mentioned || mentioned.length === 0) return '';
    const validated = this.validateCapabilities(mentioned);
    const known = validated.filter((v) => v.exists);
    const unknown = validated.filter((v) => !v.exists);

    const lines: string[] = [];
    lines.push('### Ficha tecnica inicial (ClonaKit)');
    lines.push('');

    if (known.length > 0) {
      lines.push('**Stack tecnico detectado y validado:**');
      lines.push('');
      lines.push('| Framework | Proposito | Equivalente web | Categoria |');
      lines.push('|-----------|-----------|-----------------|-----------|');
      for (const v of known) {
        lines.push(
          `| ${v.framework} | ${escapeMd(v.purpose ?? '')} | ${escapeMd(v.web_equivalent ?? '')} | ${v.category ?? '-'} |`,
        );
      }
      lines.push('');
    }

    if (unknown.length > 0) {
      lines.push('**Mencionados pero no validados contra el mapping de ClonaKit:**');
      lines.push('');
      for (const u of unknown) {
        lines.push(`- \`${u.framework}\``);
      }
      lines.push('');
    }

    if (known.length > 0) {
      const equivalents = collectWebEquivalents(known);
      if (equivalents.length > 0) {
        lines.push('**Equivalentes web recomendados:**');
        lines.push('');
        for (const we of equivalents) {
          lines.push(`- ${we}`);
        }
        lines.push('');
      }
    }

    lines.push(
      `> Generado automaticamente por el provider \`clonakit\` a partir de ` +
      `${mentioned.length} mencion(es) de framework(s). ` +
      `Mapping de referencia: ${CAPABILITY_COUNT} frameworks.`,
    );

    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // INTERNAL HELPERS
  // -------------------------------------------------------------------------

  /**
   * Convert a CapabilityEntry into a RawItem that the normalizer can ingest.
   *
   * The `snippet` is constructed so that `detectTechMentions()` will find
   * the framework name (it appears as a standalone word at the start of
   * the snippet, surrounded by spaces / punctuation).
   */
  private entryToRawItem(entry: CapabilityEntry): RawItem {
    const snippet =
      `${entry.framework} — ${entry.purpose}. ` +
      `Equivalente web: ${entry.web_equivalent}. ` +
      `(Categoria: ${entry.category})`;
    return {
      providerName: 'clonakit',
      sourceType: ClonaKitProvider.SOURCE_TYPE,
      title: entry.framework,
      snippet,
      url: undefined,
      hostName: undefined,
      date: undefined,
      rawMetadata: {
        framework: entry.framework,
        purpose: entry.purpose,
        web_equivalent: entry.web_equivalent,
        category: entry.category,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// MODULE-LEVEL SINGLETON
// ---------------------------------------------------------------------------

/**
 * Module-level singleton — the ClonaKit provider is stateless, so a single
 * instance is safe to share. The tech-enricher and the destripar_tecnologia
 * tool import this directly to avoid going through the ProviderRegistry
 * (which would require a ToolContext in code paths that don't have one).
 */
export const clonakitProvider = new ClonaKitProvider();

// ---------------------------------------------------------------------------
// INTERNAL HELPERS (module-private)
// ---------------------------------------------------------------------------

/**
 * Collect discrete web-equivalent recommendations from a list of validated
 * capabilities. Splits compound answers on " o " and skips placeholder
 * "no disponible / no aplica" responses. Returns the unique set, capped
 * at 8 entries (enough for a ficha snippet, not so many it overwhelms).
 */
function collectWebEquivalents(known: ValidatedCapability[]): string[] {
  const unique = new Set<string>();
  for (const v of known) {
    if (!v.web_equivalent) continue;
    for (const part of v.web_equivalent.split(' o ')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      if (/^no (disponible|aplica)/i.test(trimmed)) continue;
      unique.add(trimmed);
    }
  }
  return Array.from(unique).slice(0, 8);
}

/**
 * Escape pipe characters in markdown table cells so a purpose containing
 * "|" doesn't break the table layout. We don't escape other markdown
 * special chars because the purposes/equivalents in the mapping are plain
 * Spanish text without bold/italic markers.
 */
function escapeMd(s: string): string {
  return s.replace(/\|/g, '\\|');
}
