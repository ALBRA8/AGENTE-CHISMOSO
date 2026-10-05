/**
 * CHISMOSO V1.0 — Provider Abstraction (sección 11 de la especificación)
 *
 * Provider
 * ├── canHandle()
 * ├── health()
 * ├── search()
 * ├── collect()
 * ├── normalize()
 * └── capabilities()
 *
 * Cada provider declara: name, type, capabilities, status, limits, authentication.
 *
 * El resto del sistema NUNCA debe depender directamente de APIs externas.
 * Si una API no está disponible, se marca UNAVAILABLE y el sistema continúa
 * con las fuentes disponibles (sección 10 — no simular).
 */

import type {
  ProviderCapabilities,
  ProviderHealth,
  SourceType,
} from '../models.js';

export interface ProviderQuery {
  query: string;
  num?: number;
  geography?: string;
  recencyDays?: number;
}

/**
 * RawItem es el formato bruto que un provider produce ANTES de normalización.
 * La capa de normalización convierte RawItem → Signal + Evidence.
 */
export interface RawItem {
  providerName: string;
  sourceType: SourceType;
  title?: string;
  snippet: string;
  url?: string;
  hostName?: string;
  date?: string;
  rawMetadata?: Record<string, unknown>;
}

export interface ProviderSearchResult {
  providerName: string;
  items: RawItem[];
  error?: string;
  errorCode?: string;
  durationMs: number;
  query: string;
}

/**
 * Interfaz que todo provider debe implementar.
 */
export interface IProvider {
  capabilities(): ProviderCapabilities;
  canHandle(query: ProviderQuery): boolean;
  health(): Promise<ProviderHealth>;
  search(query: ProviderQuery): Promise<ProviderSearchResult>;
}

/**
 * Helper para construir capabilities de manera consistente.
 */
export function makeCapabilities(
  name: string,
  type: SourceType,
  capabilities: string[],
  status: ProviderHealth,
  authentication: 'none' | 'env' | 'oauth' = 'none',
  limits: { requestsPerMinute?: number; maxResultsPerCall?: number } = {},
): ProviderCapabilities {
  return { name, type, capabilities, status, limits, authentication };
}

/**
 * Provider registry — mantiene la lista de providers disponibles y permite
 * que el orchestrator los descubra y seleccione.
 */
export class ProviderRegistry {
  private providers = new Map<string, IProvider>();

  register(provider: IProvider): void {
    this.providers.set(provider.capabilities().name, provider);
  }

  list(): IProvider[] {
    return Array.from(this.providers.values());
  }

  get(name: string): IProvider | undefined {
    return this.providers.get(name);
  }

  availableFor(query: ProviderQuery): IProvider[] {
    return this.list().filter((p) => p.canHandle(query));
  }

  async allHealth(): Promise<Record<string, ProviderHealth>> {
    const entries = await Promise.all(
      this.list().map(async (p) => [p.capabilities().name, await p.health()] as const),
    );
    return Object.fromEntries(entries);
  }
}
