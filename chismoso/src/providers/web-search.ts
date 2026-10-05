/**
 * CHISMOSO V1.0 — WebSearchProvider
 *
 * Provider real que usa z-ai-web-dev-sdk → functions.invoke('web_search', ...).
 *
 * Cubre la categoría SEARCH/WEB de la especificación (sección 9).
 *
 * NO simula. Si la SDK no responde, el error se propaga con ErrorCode apropiado.
 */

import ZAI from 'z-ai-web-dev-sdk';
import { makeCapabilities, type IProvider, type ProviderQuery, type ProviderSearchResult, type RawItem } from './base.js';
import { ErrorCode, classifyError } from '../errors.js';
import { logger } from '../logger.js';
import { ProviderHealth, SourceType } from '../models.js';

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
