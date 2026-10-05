/**
 * CHISMOSO V1.0 — RedditProvider
 *
 * Provider real que usa z-ai-web-dev-sdk → functions.invoke('web_search', ...),
 * pero con queries formateadas para limitar la búsqueda a dominios de comunidad
 * (reddit.com, quora.com, foros). Esto NO es un wrapper de la API oficial de
 * Reddit; es un patrón de búsqueda recortada a dominios conocidos.
 *
 * Cubre la categoría REDDIT/COMMUNITIES de la especificación (sección 9).
 *
 * NO simula datos. Devuelve lo que la búsqueda retorna.
 */

import ZAI from 'z-ai-web-dev-sdk';
import { makeCapabilities, type IProvider, type ProviderQuery, type ProviderSearchResult, type RawItem } from './base.js';
import { ErrorCode, classifyError } from '../errors.js';
import { logger } from '../logger.js';
import { ProviderHealth, SourceType } from '../models.js';

const COMMUNITY_DOMAINS = ['reddit.com', 'quora.com'];

/**
 * Construye queries con operadores `site:` que la mayoría de backends de
 * búsqueda respetan. Esto permite reutilizar web_search como si fuera una
 * búsqueda específica de comunidades.
 */
function buildCommunityQuery(query: string): string {
  // Si el usuario ya incluyó site:, no duplicamos.
  if (/\bsite:/i.test(query)) return query;
  return `(${COMMUNITY_DOMAINS.map((d) => `site:${d}`).join(' | ')}) ${query}`;
}

export class RedditProvider implements IProvider {
  private zaiPromise: Promise<ZAI> | null = null;
  private lastHealthCheck: { ts: number; status: ProviderHealth } = { ts: 0, status: ProviderHealth.OK };

  capabilities() {
    return makeCapabilities(
      'reddit_communities',
      SourceType.REDDIT_COMMUNITIES,
      ['search', 'collect', 'normalize'],
      ProviderHealth.OK,
      'none',
      { requestsPerMinute: 20, maxResultsPerCall: 20 },
    );
  }

  canHandle(): boolean {
    return true;
  }

  private async getZAI(): Promise<ZAI> {
    if (!this.zaiPromise) this.zaiPromise = ZAI.create();
    return this.zaiPromise;
  }

  async health(): Promise<ProviderHealth> {
    const now = Date.now();
    if (now - this.lastHealthCheck.ts < 30_000) return this.lastHealthCheck.status;
    try {
      const zai = await this.getZAI();
      void zai;
      this.lastHealthCheck = { ts: now, status: ProviderHealth.OK };
      return ProviderHealth.OK;
    } catch (e) {
      logger.warn('RedditProvider health check failed', { err: String(e) });
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
        query: buildCommunityQuery(q.query),
        num,
      };
      if (q.recencyDays && q.recencyDays > 0) args.recency_days = q.recencyDays;
      const results = (await zai.functions.invoke('web_search', args)) as any[];
      const items: RawItem[] = (Array.isArray(results) ? results : []).map((r) => ({
        providerName: 'reddit_communities',
        sourceType: SourceType.REDDIT_COMMUNITIES,
        title: r.name ?? '',
        snippet: r.snippet ?? '',
        url: r.url ?? '',
        hostName: r.host_name ?? '',
        date: r.date ?? '',
        rawMetadata: { rank: r.rank ?? 0 },
      }));
      logger.info('RedditProvider returned', {
        query: q.query,
        count: items.length,
        durationMs: Date.now() - t0,
      });
      return {
        providerName: 'reddit_communities',
        items,
        durationMs: Date.now() - t0,
        query: q.query,
      };
    } catch (e) {
      const cerr = classifyError(e, 'reddit_communities');
      logger.error('RedditProvider error', { err: cerr.message, code: cerr.code });
      return {
        providerName: 'reddit_communities',
        items: [],
        error: cerr.message,
        errorCode: cerr.code === ErrorCode.UNKNOWN ? ErrorCode.PROVIDER_UNAVAILABLE : cerr.code,
        durationMs: Date.now() - t0,
        query: q.query,
      };
    }
  }
}
