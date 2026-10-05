/**
 * CHISMOSO V1.0 — Trend Detection Engine (sección 15)
 *
 * Determina si un cluster de señales constituye:
 *   NOISE | WEAK_SIGNAL | EMERGING_TREND | STRONG_TREND |
 *   ESTABLISHED_TREND | DECLINING_TREND
 *
 * No depende exclusivamente del LLM. Usa métricas deterministas:
 *   growth, velocity, persistence, cross_source_confirmation, recency
 *
 * Trend Score (heurístico, documentado):
 *   = Growth + Persistence + CrossSource + Recency + Velocity - Noise
 *
 * Los pesos están en TREND_WEIGHTS y son ajustables sin tocar lógica.
 */

import type { Evidence, Signal, Trend, TrendState } from '../models.js';
import { generateId, nowISO, TrendState as TS } from '../models.js';
import { crossSourceConfidence, countDistinctSources, countDistinctSourceTypes } from './cross-source.js';
import { logger } from '../logger.js';

export const TREND_WEIGHTS = {
  growth: 0.25,
  persistence: 0.2,
  crossSource: 0.25,
  recency: 0.15,
  velocity: 0.15,
} as const;

export interface TrendInput {
  topic: string;
  canonical: string;
  signals: Signal[];
  evidence: Evidence[];
  historicalSignals?: Signal[]; // señales previamente observadas para el mismo topic
}

export interface TrendResult {
  trend: Trend;
}

/**
 * Detecta y puntúa un trend a partir de un cluster de señales.
 *
 * El campo `historicalSignals` (si está disponible) permite calcular
 * crecimiento y persistencia temporal. Si no hay historial (primera
 * observación del topic), se asume emerging/weak según volumen actual.
 */
export function detectTrend(input: TrendInput): TrendResult {
  const { signals, evidence, historicalSignals = [], canonical } = input;
  const now = nowISO();

  const sourcesCount = countDistinctSources(signals);
  const sourceTypesCount = countDistinctSourceTypes(signals);
  const crossSource = crossSourceConfidence(signals);

  // Growth: proporción de señales nuevas vs históricas en la última ventana.
  // Si no hay históricos, growth = 1 (todo es nuevo), pero esto baja la
  // confianza del estado (emerging vs established).
  let growth = 1.0;
  let persistence = 0;
  let velocity = 0;
  if (historicalSignals.length > 0) {
    const recent = signals.length;
    const past = historicalSignals.length;
    growth = past === 0 ? 1.0 : Math.min(2.0, recent / Math.max(1, past));
    persistence = Math.min(1.0, past / 10);
    velocity = Math.min(1.0, recent / Math.max(1, recent + past));
  } else {
    // Sin historial: la persistencia es baja. Sólo crece si hay volumen actual.
    persistence = Math.min(0.4, signals.length / 20);
    velocity = Math.min(0.6, signals.length / 10);
  }

  // Recency: cuán recientes son las señales (últimas 30 días = 1.0).
  const cutoffRecent = Date.now() - 30 * 24 * 3600 * 1000;
  const recentCount = signals.filter((s) => new Date(s.timestamp).getTime() >= cutoffRecent).length;
  const recency = signals.length === 0 ? 0 : recentCount / signals.length;

  // Noise: penaliza señales con snippets muy cortos o duplicados.
  const noise = signals.length === 0
    ? 1
    : signals.filter((s) => (s.rawSnippet?.length ?? 0) < 30).length / signals.length;

  const score = clamp(
    TREND_WEIGHTS.growth * growth +
      TREND_WEIGHTS.persistence * persistence +
      TREND_WEIGHTS.crossSource * crossSource +
      TREND_WEIGHTS.recency * recency +
      TREND_WEIGHTS.velocity * velocity -
      0.15 * noise,
    0,
    1,
  );

  const score100 = Math.round(score * 100);

  const state: TrendState = classifyState({
    sourcesCount,
    sourceTypesCount,
    signalsCount: signals.length,
    score,
    persistence,
    growth,
  });

  const trend: Trend = {
    id: generateId('trend'),
    topic: input.topic,
    description: describe(canonical, state, sourcesCount, sourceTypesCount, signals.length),
    state,
    confidence: crossSource,
    sourcesCount,
    signalsCount: signals.length,
    evidence: evidence.slice(0, 30),
    signals: signals.slice(0, 30),
    firstSeen: signals.length > 0 ? signals.map((s) => s.timestamp).sort()[0] : now,
    lastSeen: signals.length > 0 ? signals.map((s) => s.timestamp).sort().reverse()[0] : now,
    observationCount: 1 + (historicalSignals.length > 0 ? 1 : 0),
    growth: round2(growth),
    velocity: round2(velocity),
    persistence: round2(persistence),
    crossSourceConfirmation: round2(crossSource),
    score: score100,
    scoreBreakdown: {
      growth: Math.round(growth * 100),
      persistence: Math.round(persistence * 100),
      crossSource: Math.round(crossSource * 100),
      recency: Math.round(recency * 100),
      velocity: Math.round(velocity * 100),
      noise: Math.round(noise * 100),
    },
    createdAt: now,
    updatedAt: now,
  };

  logger.info('Trend detected', {
    topic: input.topic,
    state,
    score: score100,
    sources: sourcesCount,
    sourceTypes: sourceTypesCount,
    signals: signals.length,
  });

  return { trend };
}

function classifyState(opts: {
  sourcesCount: number;
  sourceTypesCount: number;
  signalsCount: number;
  score: number;
  persistence: number;
  growth: number;
}): TrendState {
  const { sourcesCount, sourceTypesCount, signalsCount, score, persistence, growth } = opts;

  if (signalsCount < 3) return TS.NOISE;
  if (score < 0.25) return TS.NOISE;
  if (score < 0.45) return TS.WEAK_SIGNAL;
  if (persistence > 0.6 && score > 0.7 && growth < 0.8) return TS.ESTABLISHED_TREND;
  if (growth > 1.2 && persistence > 0.4 && score < 0.6) return TS.DECLINING_TREND; // crecía pero ahora score moderado
  if (sourcesCount >= 3 && sourceTypesCount >= 2 && score > 0.7) return TS.STRONG_TREND;
  if (sourcesCount >= 2 && score > 0.5) return TS.EMERGING_TREND;
  return TS.WEAK_SIGNAL;
}

function describe(canonical: string, state: TrendState, sources: number, types: number, signals: number): string {
  return `${canonical} — ${state.toLowerCase().replace(/_/g, ' ')} — ${signals} signals across ${sources} sources (${types} source types)`;
}

function clamp(x: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, x));
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
