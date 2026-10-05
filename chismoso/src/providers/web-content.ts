/**
 * CHISMOSO V1.0 — WebContentProvider
 *
 * Provider real que usa z-ai-web-dev-sdk → functions.invoke('page_reader', ...)
 * para extraer contenido profundo de URLs que otros providers ya encontraron.
 *
 * Es un provider "de profundización": no es su objetivo descubrir nuevas
 * URLs, sino enriquecer evidencia sobre URLs ya candidatas. Por eso su
 * `canHandle` acepta únicamente queries que vienen con `urls` en metadata.
 *
 * Cubre la categoría WEB_CONTENT de la especificación (sección 9) y da
 * confirmación cruzada (sección 16) al aportar evidencia secundaria.
 */

import ZAI from 'z-ai-web-dev-sdk';
import { makeCapabilities, type IProvider, type ProviderQuery, type ProviderSearchResult, type RawItem } from './base.js';
import { ErrorCode, classifyError } from '../errors.js';
import { logger } from '../logger.js';
import { ProviderHealth, SourceType } from '../models.js';

export interface WebContentQuery extends ProviderQuery {
  urls: string[];
}

export class WebContentProvider implements IProvider {
  private zaiPromise: Promise<ZAI> | null = null;
  private lastHealthCheck: { ts: number; status: ProviderHealth } = { ts: 0, status: ProviderHealth.OK };

  capabilities() {
    return makeCapabilities(
      'web_content',
      SourceType.WEB_CONTENT,
      ['collect', 'normalize', 'deepen'],
      ProviderHealth.OK,
      'none',
      { requestsPerMinute: 15, maxResultsPerCall: 5 },
    );
  }

  canHandle(q: ProviderQuery): boolean {
    // Solo puede manejar queries que traen URLs para profundizar.
    return Array.isArray((q as WebContentQuery).urls) && (q as WebContentQuery).urls.length > 0;
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
      logger.warn('WebContentProvider health check failed', { err: String(e) });
      this.lastHealthCheck = { ts: now, status: ProviderHealth.UNAVAILABLE };
      return ProviderHealth.UNAVAILABLE;
    }
  }

  async search(q: ProviderQuery): Promise<ProviderSearchResult> {
    const t0 = Date.now();
    const urls = (q as WebContentQuery).urls ?? [];
    const max = Math.min(urls.length, 5);
    try {
      const zai = await this.getZAI();
      const settled = await Promise.allSettled(
        urls.slice(0, max).map((u) => zai.functions.invoke('page_reader', { url: u })),
      );
      const items: RawItem[] = [];
      let lastErr: string | undefined;
      let lastCode = ErrorCode.OK;
      for (let i = 0; i < settled.length; i++) {
        const r = settled[i];
        if (r.status === 'fulfilled') {
          const res: any = r.value;
          const data = res?.data ?? {};
          const text = stripHtml(data.html ?? '').slice(0, 5000);
          items.push({
            providerName: 'web_content',
            sourceType: SourceType.WEB_CONTENT,
            title: data.title ?? '',
            snippet: text.slice(0, 1000),
            url: data.url ?? urls[i],
            hostName: safeHost(data.url ?? urls[i]),
            date: data.publishedTime ?? '',
            rawMetadata: { tokens: data.usage?.tokens ?? 0, fullText: text },
          });
        } else {
          const cerr = classifyError(r.reason, 'web_content');
          lastErr = cerr.message;
          lastCode = cerr.code === ErrorCode.UNKNOWN ? ErrorCode.PROVIDER_UNAVAILABLE : cerr.code;
          logger.warn('WebContentProvider item failed', { url: urls[i], err: cerr.message });
        }
      }
      logger.info('WebContentProvider returned', {
        query: q.query,
        count: items.length,
        durationMs: Date.now() - t0,
      });
      return {
        providerName: 'web_content',
        items,
        error: lastErr,
        errorCode: lastErr ? lastCode : undefined,
        durationMs: Date.now() - t0,
        query: q.query,
      };
    } catch (e) {
      const cerr = classifyError(e, 'web_content');
      logger.error('WebContentProvider error', { err: cerr.message, code: cerr.code });
      return {
        providerName: 'web_content',
        items: [],
        error: cerr.message,
        errorCode: cerr.code === ErrorCode.UNKNOWN ? ErrorCode.PROVIDER_UNAVAILABLE : cerr.code,
        durationMs: Date.now() - t0,
        query: q.query,
      };
    }
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
