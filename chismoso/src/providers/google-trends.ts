/**
 * CHISMOSO V1.0 — GoogleTrendsProvider
 *
 * MARCADO COMO UNAVAILABLE (sección 10 de la especificación).
 *
 * NO existe una API oficial de Google Trends con credenciales disponibles
 * en este momento, y NO vamos a simular datos. El provider se registra
 * para que el resto del sistema sepa que la categoría existe, pero su
 * estado de salud es UNAVAILABLE y `search` retorna siempre vacío.
 *
 * Si en el futuro se configura una API real (p.ej. SerpAPI, Trends API
 * no oficial, OAuth), basta con implementar `search()` y cambiar
 * `capabilities().status` a OK. El resto del sistema no requiere cambios.
 *
 * La lógica anti-ficticia está explícita en `search()`.
 */

import { makeCapabilities, type IProvider, type ProviderQuery, type ProviderSearchResult } from './base.js';
import { ErrorCode } from '../errors.js';
import { ProviderHealth, SourceType } from '../models.js';
import { logger } from '../logger.js';

export class GoogleTrendsProvider implements IProvider {
  capabilities() {
    return makeCapabilities(
      'google_trends',
      SourceType.GOOGLE_TRENDS,
      ['trends', 'compare'],
      ProviderHealth.UNAVAILABLE,
      'oauth',
      { requestsPerMinute: 5, maxResultsPerCall: 10 },
    );
  }

  canHandle(): boolean {
    return true;
  }

  async health(): Promise<ProviderHealth> {
    return ProviderHealth.UNAVAILABLE;
  }

  async search(q: ProviderQuery): Promise<ProviderSearchResult> {
    logger.debug('GoogleTrendsProvider.search called but provider is UNAVAILABLE', { query: q.query });
    return {
      providerName: 'google_trends',
      items: [],
      error: 'GoogleTrendsProvider UNAVAILABLE — no credentials configured',
      errorCode: ErrorCode.PROVIDER_UNAVAILABLE,
      durationMs: 0,
      query: q.query,
    };
  }
}
