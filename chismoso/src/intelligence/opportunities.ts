/**
 * CHISMOSO V1.0 — Opportunity Engine (secciones 20, 21, 22)
 *
 * El Opportunity Engine convierte inteligencia en posibilidades accionables.
 *
 * Modelo:
 *   Opportunity = Trend + Problem + Demand + Timing + MarketFit + Monetization
 *                 - Competition - Uncertainty
 *
 * El score es TRANSPARENTE: el reporte explica por qué recibió ese score
 * con scoreBreakdown.
 *
 * Regla de oro (sección 22): NUNCA afirmar "esta oportunidad va a generar
 * mucho dinero". Afirmar: "la evidencia disponible sugiere una oportunidad
 * potencial de X, con confianza Y y estas limitaciones."
 */

import type { Evidence, Opportunity, Problem, Signal, Trend } from '../models.js';
import { generateId, nowISO } from '../models.js';
import { logger } from '../logger.js';

export interface OpportunityInput {
  trend?: Trend;
  problem?: Problem;
  signals: Signal[];
  evidence: Evidence[];
  geography: string;
  targetSegment?: string;
  /** Si viene, el LLM ya propuso un título y descripción. Si no, se deducen. */
  llmHint?: {
    title?: string;
    description?: string;
    suggestedSegment?: string;
    monetization?: number; // 0..100
    competition?: number; // 0..100
    timing?: number; // 0..100
    marketFit?: number; // 0..100
  };
}

export interface OpportunityResult {
  opportunity: Opportunity;
  /** Si true, la oportunidad es muy débil y probablemente no debería entregarse. */
  weak: boolean;
}

/**
 * Pesos documentados. Ajustables sin tocar lógica.
 */
export const OPPORTUNITY_WEIGHTS = {
  demand: 0.18,
  growth: 0.18,
  problemSeverity: 0.16,
  monetization: 0.14,
  timing: 0.12,
  marketFit: 0.12,
  competition: -0.05, // penaliza
  uncertainty: -0.09, // penaliza
} as const;

export function generateOpportunity(input: OpportunityInput): OpportunityResult {
  const { trend, problem, signals, evidence, geography } = input;

  if (!trend && !problem) {
    throw new Error('generateOpportunity requires at least one of trend or problem');
  }

  const demand = computeDemand(trend, signals);
  const growth = trend?.growth ? Math.round(trend.growth * 100) : computeGrowthFallback(signals);
  const problemSeverity = problem?.severity ?? Math.round(0.3 * 100);
  const monetization = input.llmHint?.monetization ?? estimateMonetization(signals, problem);
  const timing = input.llmHint?.timing ?? estimateTiming(trend, signals);
  const marketFit = input.llmHint?.marketFit ?? estimateMarketFit(signals);
  const competition = input.llmHint?.competition ?? estimateCompetition(signals);
  const uncertainty = computeUncertainty(trend, problem, signals);

  const score100 = computeScore({
    demand,
    growth,
    problemSeverity,
    monetization,
    timing,
    marketFit,
    competition,
    uncertainty,
  });

  const confidence = Math.min(0.95, (trend?.confidence ?? 0.4) * 0.6 + (problem?.confidence ?? 0.3) * 0.4);

  const title = input.llmHint?.title ?? deriveTitle(trend, problem);
  const description = input.llmHint?.description ?? deriveDescription(trend, problem, signals);
  const targetSegment = input.llmHint?.suggestedSegment ?? problem?.segmentsAffected?.[0] ?? 'unspecified';
  const suggestedNextAgent = 'AGENTE-LEADS';

  const opportunity: Opportunity = {
    id: generateId('opp'),
    title,
    description,
    problem: problem?.description ?? '(no explicit problem detected)',
    problemRef: problem?.id,
    targetSegment,
    geography,
    evidence: evidence.slice(0, 20),
    trendRef: trend?.id,
    trend,
    problemRef_obj: problem,
    demand,
    growth,
    problemSeverity,
    monetization,
    timing,
    marketFit,
    competition,
    uncertainty,
    score: score100,
    scoreBreakdown: {
      demand,
      growth,
      problemSeverity,
      monetization,
      timing,
      marketFit,
      competition,
      uncertainty,
    },
    confidence,
    suggestedNextAgent,
    createdAt: nowISO(),
  };

  const weak = score100 < 35 || confidence < 0.3;

  logger.info('Opportunity generated', {
    title,
    score: score100,
    confidence,
    weak,
    evidenceCount: evidence.length,
  });

  return { opportunity, weak };
}

// ---------------------------------------------------------------------------
// COMPONENT SCORERS (heurísticos, documentados)
// ---------------------------------------------------------------------------

function computeDemand(trend: Trend | undefined, signals: Signal[]): number {
  // Demand = combinación de volumen de señales + score del trend + cross-source.
  const vol = Math.min(100, signals.length * 8);
  const ts = trend?.score ?? 30;
  const cs = trend ? Math.round((trend.crossSourceConfirmation ?? 0) * 100) : 20;
  return clamp100(Math.round(0.4 * vol + 0.4 * ts + 0.2 * cs));
}

function computeGrowthFallback(signals: Signal[]): number {
  // Sin trend explícito: si hay >=5 señales recientes, asumimos growth moderado.
  const recent = signals.filter((s) => Date.now() - new Date(s.timestamp).getTime() < 30 * 86400 * 1000).length;
  return clamp100(Math.min(100, recent * 12));
}

function estimateMonetization(signals: Signal[], problem: Problem | undefined): number {
  // Heurística: si hay un problema con severidad alta, la monetización tiende a ser alta
  // porque hay disposición a pagar. Si hay keywords de pago/price, sube.
  let m = problem ? Math.round(problem.severity * 0.6) : 40;
  const text = signals.map((s) => s.rawSnippet ?? '').join(' ').toLowerCase();
  if (/\b(pay|paid|price|pricing|cost|fee|subscription|saas|ventas?|plan)\b/.test(text)) m += 15;
  if (/\b(free|open source|gratis)\b/.test(text)) m -= 10;
  return clamp100(m);
}

function estimateTiming(trend: Trend | undefined, signals: Signal[]): number {
  // Timing: recencia + estado del trend (emergente/strong = mejor que established/declining).
  let t = 50;
  if (trend) {
    if (trend.state === 'EMERGING_TREND' || trend.state === 'STRONG_TREND') t += 25;
    if (trend.state === 'ESTABLISHED_TREND') t -= 10;
    if (trend.state === 'DECLINING_TREND') t -= 30;
    if (trend.state === 'WEAK_SIGNAL' || trend.state === 'NOISE') t -= 20;
  }
  const recent = signals.filter((s) => Date.now() - new Date(s.timestamp).getTime() < 14 * 86400 * 1000).length;
  t += Math.min(20, recent * 4);
  return clamp100(t);
}

function estimateMarketFit(signals: Signal[]): number {
  // Heurística: si muchas señales provienen de comunidades (usuarios reales
  // quejándose/preguntando), el market fit es mejor que si todo viene de
  // press releases.
  const community = signals.filter((s) => s.sourceType === 'REDDIT_COMMUNITIES').length;
  const total = signals.length || 1;
  return clamp100(40 + Math.round((community / total) * 50));
}

function estimateCompetition(signals: Signal[]): number {
  // Heurística: si hay menciones de "alternative", "competitor", "vs",
  // el mercado tiene más competencia visible.
  const text = signals.map((s) => s.rawSnippet ?? '').join(' ').toLowerCase();
  const matches = (text.match(/\b(alternative|competitor|vs\.?|comparison|better than|review of)\b/g) ?? []).length;
  return clamp100(30 + matches * 8);
}

function computeUncertainty(trend: Trend | undefined, problem: Problem | undefined, signals: Signal[]): number {
  // Uncertainty = 100 - confidence media (entre trend y problem) - volumen confiable.
  const c = Math.max(trend?.confidence ?? 0, problem?.confidence ?? 0);
  let u = 100 - Math.round(c * 100);
  if (signals.length < 5) u += 15;
  if (signals.length > 20) u -= 10;
  return clamp100(u);
}

function computeScore(s: {
  demand: number;
  growth: number;
  problemSeverity: number;
  monetization: number;
  timing: number;
  marketFit: number;
  competition: number;
  uncertainty: number;
}): number {
  const raw =
    OPPORTUNITY_WEIGHTS.demand * s.demand +
    OPPORTUNITY_WEIGHTS.growth * s.growth +
    OPPORTUNITY_WEIGHTS.problemSeverity * s.problemSeverity +
    OPPORTUNITY_WEIGHTS.monetization * s.monetization +
    OPPORTUNITY_WEIGHTS.timing * s.timing +
    OPPORTUNITY_WEIGHTS.marketFit * s.marketFit +
    OPPORTUNITY_WEIGHTS.competition * s.competition +
    OPPORTUNITY_WEIGHTS.uncertainty * s.uncertainty;
  // Normaliza a escala 0..100 asumiendo suma de pesos absolutos = 1.04
  return clamp100(Math.round(raw / 1.04));
}

// ---------------------------------------------------------------------------
// TITLE / DESCRIPTION DERIVATION
// ---------------------------------------------------------------------------

function deriveTitle(trend: Trend | undefined, problem: Problem | undefined): string {
  if (problem && trend) {
    return `Opportunity around "${trend.topic}": ${truncate(problem.description, 80)}`;
  }
  if (problem) {
    return `Opportunity to solve: ${truncate(problem.description, 100)}`;
  }
  if (trend) {
    return `Opportunity around emerging trend: ${trend.topic}`;
  }
  return 'Opportunity (insufficient context)';
}

function deriveDescription(trend: Trend | undefined, problem: Problem | undefined, signals: Signal[]): string {
  const parts: string[] = [];
  if (trend) {
    parts.push(
      `Trend state: ${trend.state.toLowerCase().replace(/_/g, ' ')} with score ${trend.score}/100 across ${trend.sourcesCount} sources.`,
    );
  }
  if (problem) {
    parts.push(`Problem severity: ${problem.severity}/100, frequency: ${problem.frequency}/100.`);
  }
  parts.push(`Evidence base: ${signals.length} normalized signals.`);
  return parts.join(' ');
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function clamp100(x: number): number {
  return Math.max(0, Math.min(100, x));
}
