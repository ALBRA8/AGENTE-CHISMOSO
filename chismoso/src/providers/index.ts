/**
 * CHISMOSO V1.0 — Providers barrel
 */

export * from './base.js';
export * from './web-search.js';
export * from './reddit.js';
export * from './web-content.js';
export * from './google-trends.js';

import { ProviderRegistry } from './base.js';
import { WebSearchProvider } from './web-search.js';
import { RedditProvider } from './reddit.js';
import { WebContentProvider } from './web-content.js';
import { GoogleTrendsProvider } from './google-trends.js';

/**
 * Crea un registry con todos los providers disponibles en V1.
 * El orchestrator debe recibir este registry para no depender de instancias concretas.
 */
export function createDefaultProviderRegistry(): ProviderRegistry {
  const reg = new ProviderRegistry();
  reg.register(new WebSearchProvider());
  reg.register(new RedditProvider());
  reg.register(new WebContentProvider());
  reg.register(new GoogleTrendsProvider()); // marcado UNAVAILABLE, no simula
  return reg;
}
