/**
 * CHISMOSO V1.0 — WebSearchProvider
 *
 * Provider real que usa z-ai-web-dev-sdk → functions.invoke('web_search', ...).
 *
 * Cubre la categoría SEARCH/WEB de la especificación (sección 9).
 *
 * NO simula. Si la SDK no responde, el error se propaga con ErrorCode apropiado.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadZAIInstance, MISSING_PROVIDER_HINT } from './zai-loader.js';
import { makeCapabilities, type IProvider, type ProviderQuery, type ProviderSearchResult, type RawItem } from './base.js';
import { ErrorCode, classifyError } from '../errors.js';
import { logger } from '../logger.js';
import { ProviderHealth, SourceType } from '../models.js';

/**
 * Minimal structural type for the lazily-loaded z-ai-web-dev-sdk instance
 * (see zai-loader.ts for the rationale behind `any`).
 */
type ZAIInstance = any;

// FASE-3-QUALITY §3.2 — Serper gl/hl params per geography.
//
// Serper.dev accepts `gl` (country code, lowercase ISO-3166-1 alpha-2) and
// `hl` (language code, e.g. "es" or "en"). When the investigation targets a
// specific country, we attach both so Google returns local results and
// preferentially local-language pages.
//
// We also append the country's Spanish name to the query string (e.g.
// "restaurantes colombia") because Serper's `gl` only biases results, it
// doesn't restrict them — adding the country name explicitly makes the
// geographic intent unambiguous to the search engine.
const GEO_SERPER_PARAMS: Record<string, { gl: string; hl: string; countryName: string }> = {
  colombia: { gl: 'co', hl: 'es', countryName: 'Colombia' },
  peru: { gl: 'pe', hl: 'es', countryName: 'Perú' },
  mexico: { gl: 'mx', hl: 'es', countryName: 'México' },
  argentina: { gl: 'ar', hl: 'es', countryName: 'Argentina' },
  chile: { gl: 'cl', hl: 'es', countryName: 'Chile' },
  espana: { gl: 'es', hl: 'es', countryName: 'España' },
  spain: { gl: 'es', hl: 'es', countryName: 'España' },
  'estados unidos': { gl: 'us', hl: 'en', countryName: 'United States' },
  usa: { gl: 'us', hl: 'en', countryName: 'United States' },
  brasil: { gl: 'br', hl: 'pt', countryName: 'Brasil' },
  brazil: { gl: 'br', hl: 'pt', countryName: 'Brasil' },
};

function normalizeGeo(geography?: string): string {
  return (geography ?? '').toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function serperParamsFor(geography?: string): { gl?: string; hl?: string; countryName?: string } {
  const g = normalizeGeo(geography);
  if (!g || g === 'global') return {};
  if (GEO_SERPER_PARAMS[g]) return GEO_SERPER_PARAMS[g];
  // Fall back: try matching on the first word (handles "Perú", "Colombia,").
  const first = g.split(/\s+/)[0];
  if (first && GEO_SERPER_PARAMS[first]) return GEO_SERPER_PARAMS[first];
  return {};
}

/**
 * Builds the Serper query string for a given geography. If the geography
 * has a known country name (e.g. "Colombia") and the user's query doesn't
 * already mention it, we append it so the search engine gets the
 * geographic intent unambiguously.
 */
function enrichQueryWithGeo(query: string, geography?: string): string {
  const { countryName } = serperParamsFor(geography);
  if (!countryName) return query;
  const q = query.trim();
  // Case-insensitive check on the normalised query.
  const qNorm = q.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const cNorm = countryName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (qNorm.includes(cNorm)) return q;
  return `${q} ${countryName}`;
}

/**
 * FASE-3-QUALITY §3.2 — small relevance boost for local TLDs.
 *
 * The Serper API returns results in `position` order (1..N). When the
 * geography has a known TLD (e.g. ".co" for Colombia), we promote results
 * whose `link` ends in that TLD by lowering their nominal `position` so
 * they appear earlier in our rank-ordered metadata. The effect is small
 * (a +5 raw confidence bump in the normalizer) — this is a *boost*, not
 * a hard filter.
 */
function localTldBoostFor(geography?: string): string | undefined {
  const g = normalizeGeo(geography);
  if (!g || g === 'global') return undefined;
  if (GEO_SERPER_PARAMS[g]) {
    const gl = GEO_SERPER_PARAMS[g].gl;
    return `.${gl}`;
  }
  return undefined;
}

function getSearchConfig(): { serperKey?: string; tavilyKey?: string; braveKey?: string } {
  const serperKey = process.env.SERPER_API_KEY;
  const tavilyKey = process.env.TAVILY_API_KEY;
  const braveKey = process.env.BRAVE_API_KEY;
  if (serperKey || tavilyKey || braveKey) {
    return { serperKey, tavilyKey, braveKey };
  }
  try {
    const candidates = [
      path.resolve(process.cwd(), '.signals-settings.json'),
      path.resolve(process.cwd(), '..', '.signals-settings.json'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        const data = JSON.parse(fs.readFileSync(c, 'utf-8'));
        return {
          serperKey: data.serper_api_key,
          tavilyKey: data.tavily_api_key,
          braveKey: data.brave_api_key,
        };
      }
    }
  } catch {}
  return {};
}

export class WebSearchProvider implements IProvider {
  private zaiPromise: Promise<ZAIInstance | null> | null = null;
  private lastHealthCheck: { ts: number; status: ProviderHealth } = {
    ts: 0,
    status: ProviderHealth.OK,
  };

  capabilities() {
    return makeCapabilities(
      'web_search',
      SourceType.SEARCH_WEB,
      ['search', 'collect', 'normalize'],
      ProviderHealth.OK,
      'none',
      { requestsPerMinute: 30, maxResultsPerCall: 20 },
    );
  }

  canHandle(): boolean {
    return true; // acepta cualquier query textual
  }

  /**
   * Lazily resolve the z-ai-web-dev-sdk instance. Returns `null` when the
   * SDK is not installed — `search()` falls back to external Serper /
   * Tavily / Brave providers and surfaces a clear config error if none
   * are configured.
   */
  private async getZAI(): Promise<ZAIInstance | null> {
    if (!this.zaiPromise) {
      this.zaiPromise = loadZAIInstance();
    }
    return this.zaiPromise;
  }

  async health(): Promise<ProviderHealth> {
    // Cachea el estado de salud por 30s para no abusar del provider.
    const now = Date.now();
    if (now - this.lastHealthCheck.ts < 30_000) {
      return this.lastHealthCheck.status;
    }
    // External providers take precedence — if any of them is configured,
    // the provider is considered healthy even when the SDK is missing.
    const cfg = getSearchConfig();
    if (cfg.serperKey || cfg.tavilyKey || cfg.braveKey) {
      this.lastHealthCheck = { ts: now, status: ProviderHealth.OK };
      return ProviderHealth.OK;
    }
    try {
      const zai = await this.getZAI();
      // Sanity check mínimo: si la instancia existe, consideramos OK.
      void zai;
      this.lastHealthCheck = { ts: now, status: zai ? ProviderHealth.OK : ProviderHealth.UNAVAILABLE };
      return zai ? ProviderHealth.OK : ProviderHealth.UNAVAILABLE;
    } catch (e) {
      logger.warn('WebSearchProvider health check failed', { err: String(e) });
      this.lastHealthCheck = { ts: now, status: ProviderHealth.UNAVAILABLE };
      return ProviderHealth.UNAVAILABLE;
    }
  }

  async search(q: ProviderQuery): Promise<ProviderSearchResult> {
    const t0 = Date.now();
    const num = Math.min(q.num ?? 10, 20);

    // FASE-3-QUALITY §3.2 — enrich the query with the target country name
    // when a geography is supplied (e.g. "restaurantes" + "Colombia" →
    // "restaurantes Colombia"). The `gl`/`hl` Serper params are attached
    // below when calling the Serper API.
    const enrichedQuery = enrichQueryWithGeo(q.query, q.geography);
    const serperParams = serperParamsFor(q.geography);
    const tldBoost = localTldBoostFor(q.geography);

    // 1. Try Serper (Google Search) if key configured
    const cfg = getSearchConfig();
    if (cfg.serperKey) {
      try {
        const serperBody: Record<string, unknown> = { q: enrichedQuery, num };
        if (serperParams.gl) serperBody.gl = serperParams.gl;
        if (serperParams.hl) serperBody.hl = serperParams.hl;
        const res = await fetch('https://google.serper.dev/search', {
          method: 'POST',
          headers: {
            'X-API-KEY': cfg.serperKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(serperBody),
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) {
          const data: any = await res.json();
          // FASE-3-QUALITY §3.2 — small boost for local TLDs: lower the
          // stored `position` of results whose hostname ends in the local
          // TLD (e.g. ".co" for Colombia). This bumps them in any
          // downstream rank-based scoring without removing non-local
          // results (we still keep them, just ranked after local ones).
          const organic: any[] = data.organic || [];
          // Compute a sort-stable rank: local-TLD results get -1000 offset
          // (so they sort before non-local ones), preserving original order
          // within each group via `position`.
          const decorated = organic.map((r: any) => {
            const host = (() => { try { return new URL(r.link ?? '').hostname; } catch { return ''; } })();
            const isLocal = !!(tldBoost && host.endsWith(tldBoost));
            return { r, isLocal, host, pos: r.position ?? 0 };
          });
          decorated.sort((a, b) => {
            if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
            return a.pos - b.pos;
          });
          const items: RawItem[] = decorated.map(({ r, isLocal, host }, idx) => ({
            providerName: 'web_search',
            sourceType: SourceType.SEARCH_WEB,
            title: r.title ?? '',
            snippet: r.snippet ?? '',
            url: r.link ?? '',
            hostName: host,
            date: r.date ?? '',
            rawMetadata: {
              rank: idx + 1,
              serperPosition: r.position ?? 0,
              localTldBoost: isLocal,
              gl: serperParams.gl ?? null,
              hl: serperParams.hl ?? null,
            },
          }));
          logger.info('WebSearchProvider (Serper) returned', {
            query: enrichedQuery,
            gl: serperParams.gl,
            hl: serperParams.hl,
            count: items.length,
            localTldHits: decorated.filter((d) => d.isLocal).length,
          });
          return { providerName: 'web_search', items, durationMs: Date.now() - t0, query: q.query };
        }
      } catch (err: any) {
        logger.warn('WebSearchProvider Serper call failed, falling back', { err: err?.message });
      }
    }

    // 2. Try Tavily if key configured
    if (cfg.tavilyKey) {
      try {
        const res = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: cfg.tavilyKey, query: q.query, max_results: num }),
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) {
          const data: any = await res.json();
          const items: RawItem[] = (data.results || []).map((r: any, idx: number) => ({
            providerName: 'web_search',
            sourceType: SourceType.SEARCH_WEB,
            title: r.title ?? '',
            snippet: r.content ?? '',
            url: r.url ?? '',
            hostName: (() => { try { return new URL(r.url).hostname; } catch { return ''; } })(),
            date: '',
            rawMetadata: { rank: idx + 1 },
          }));
          logger.info('WebSearchProvider (Tavily) returned', { query: q.query, count: items.length });
          return { providerName: 'web_search', items, durationMs: Date.now() - t0, query: q.query };
        }
      } catch (err: any) {
        logger.warn('WebSearchProvider Tavily call failed, falling back', { err: err?.message });
      }
    }

    // 3. Fallback to ZAI SDK (only loaded if installed).
    const zai = await this.getZAI();
    if (!zai) {
      // No external keys + SDK not installed — surface the canonical
      // configuration hint so the operator knows exactly what to set.
      const cerr = classifyError(new Error(MISSING_PROVIDER_HINT), 'web_search');
      logger.error('WebSearchProvider error', { err: cerr.message, code: cerr.code });
      return {
        providerName: 'web_search',
        items: [],
        error: cerr.message,
        errorCode: ErrorCode.PROVIDER_UNAVAILABLE,
        durationMs: Date.now() - t0,
        query: q.query,
      };
    }
    try {
      const args: { query: string; num: number; recency_days?: number } = {
        query: q.query,
        num,
      };
      if (q.recencyDays && q.recencyDays > 0) {
        args.recency_days = q.recencyDays;
      }
      const results = (await zai.functions.invoke('web_search', args)) as any[];
      const items: RawItem[] = (Array.isArray(results) ? results : []).map((r) => ({
        providerName: 'web_search',
        sourceType: SourceType.SEARCH_WEB,
        title: r.name ?? '',
        snippet: r.snippet ?? '',
        url: r.url ?? '',
        hostName: r.host_name ?? '',
        date: r.date ?? '',
        rawMetadata: { rank: r.rank ?? 0, favicon: r.favicon ?? '' },
      }));
      logger.info('WebSearchProvider returned', {
        query: q.query,
        count: items.length,
        durationMs: Date.now() - t0,
      });
      return {
        providerName: 'web_search',
        items,
        durationMs: Date.now() - t0,
        query: q.query,
      };
    } catch (e) {
      const cerr = classifyError(e, 'web_search');
      logger.error('WebSearchProvider error', { err: cerr.message, code: cerr.code });
      return {
        providerName: 'web_search',
        items: [],
        error: cerr.message,
        errorCode: cerr.code === ErrorCode.UNKNOWN ? ErrorCode.PROVIDER_UNAVAILABLE : cerr.code,
        durationMs: Date.now() - t0,
        query: q.query,
      };
    }
  }
}
