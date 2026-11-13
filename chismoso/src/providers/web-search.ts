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
import ZAI from 'z-ai-web-dev-sdk';
import { makeCapabilities, type IProvider, type ProviderQuery, type ProviderSearchResult, type RawItem } from './base.js';
import { ErrorCode, classifyError } from '../errors.js';
import { logger } from '../logger.js';
import { ProviderHealth, SourceType } from '../models.js';

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
  private zaiPromise: Promise<ZAI> | null = null;
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

  private async getZAI(): Promise<ZAI> {
    if (!this.zaiPromise) {
      this.zaiPromise = ZAI.create();
    }
    return this.zaiPromise;
  }

  async health(): Promise<ProviderHealth> {
    // Cachea el estado de salud por 30s para no abusar del provider.
    const now = Date.now();
    if (now - this.lastHealthCheck.ts < 30_000) {
      return this.lastHealthCheck.status;
    }
    try {
      const zai = await this.getZAI();
      // Sanity check mínimo: si la instancia existe, consideramos OK.
      void zai;
      this.lastHealthCheck = { ts: now, status: ProviderHealth.OK };
      return ProviderHealth.OK;
    } catch (e) {
      logger.warn('WebSearchProvider health check failed', { err: String(e) });
      this.lastHealthCheck = { ts: now, status: ProviderHealth.UNAVAILABLE };
      return ProviderHealth.UNAVAILABLE;
    }
  }

  async search(q: ProviderQuery): Promise<ProviderSearchResult> {
    const t0 = Date.now();
    const num = Math.min(q.num ?? 10, 20);

    // 1. Try Serper (Google Search) if key configured
    const cfg = getSearchConfig();
    if (cfg.serperKey) {
      try {
        const res = await fetch('https://google.serper.dev/search', {
          method: 'POST',
          headers: {
            'X-API-KEY': cfg.serperKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ q: q.query, num }),
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) {
          const data: any = await res.json();
          const items: RawItem[] = (data.organic || []).map((r: any) => ({
            providerName: 'web_search',
            sourceType: SourceType.SEARCH_WEB,
            title: r.title ?? '',
            snippet: r.snippet ?? '',
            url: r.link ?? '',
            hostName: (() => { try { return new URL(r.link).hostname; } catch { return ''; } })(),
            date: r.date ?? '',
            rawMetadata: { rank: r.position ?? 0 },
          }));
          logger.info('WebSearchProvider (Serper) returned', { query: q.query, count: items.length });
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

    // 3. Fallback to ZAI SDK
    try {
      const zai = await this.getZAI();
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
