/**
 * CHISMOSO V1.0 — Cross-source confirmation (sección 16)
 *
 * Una señal encontrada en una única fuente debe tener menor confianza.
 * Si las señales apuntan hacia el mismo fenómeno en fuentes independientes:
 *   1 fuente:   confidence = low    (0.0–0.4)
 *   2 fuentes:  confidence = medium  (0.4–0.7)
 *   3+ fuentes: confidence = high    (0.7–0.95)
 *
 * Las fórmulas son heurísticas documentadas, no pretenden ser científicas.
 */

import type { Signal, SourceType } from '../models.js';

/**
 * Calcula cuántas fuentes distintas (providerName distintos) aportan
 * señales a un cluster/topic.
 */
export function countDistinctSources(signals: Signal[]): number {
  return new Set(signals.map((s) => s.source)).size;
}

/**
 * Calcula cuántos sourceTypes distintos están representados.
 * Útil porque si reddit_communities y web_search coinciden, eso es
 * confirmación de dos ecosistemas diferentes (comunidad + web indexable).
 */
export function countDistinctSourceTypes(signals: Signal[]): number {
  return new Set(signals.map((s) => s.sourceType)).size;
}

/**
 * Confidence boost por cross-source confirmation.
 * - No aumenta linealmente con el número de señales (evita amplificar ruido).
 * - Recompensa la diversidad de sourceType más que el volumen de providers
 *   del mismo tipo.
 */
export function crossSourceConfidence(signals: Signal[]): number {
  if (signals.length === 0) return 0;
  const base = Math.min(0.5, signals.length * 0.07); // volumen moderado
  const types = countDistinctSourceTypes(signals);
  const typeBoost = types >= 3 ? 0.35 : types === 2 ? 0.22 : types === 1 ? 0.05 : 0;
  return Math.min(0.95, base + typeBoost);
}

/**
 * Devuelve una lista de SourceTypes presentes en un set de señales.
 */
export function sourcesPresent(signals: Signal[]): SourceType[] {
  return Array.from(new Set(signals.map((s) => s.sourceType)));
}
