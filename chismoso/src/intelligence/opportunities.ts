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
 *
 * FASE-3-QUALITY §3.6 — concrete + complete opportunities.
 * Each opportunity MUST include:
 *   - niche/product name (a short descriptive noun phrase, e.g.
 *     "collares personalizados para perros")
 *   - target segment + geography (already on Opportunity; we ensure
 *     neither is empty / 'unspecified' when there's enough signal)
 *   - value proposition (what to sell/offer — derived from problem +
 *     trend signals)
 *   - whyNow (timing rationale — derives from `timing` score + trend state)
 *   - risks (3-5 bullet strings — derived from competition + uncertainty +
 *     segmentUnknown flag)
 *   - leadSearchHints (3-5 search queries for AGENTE-LEADS — derived from
 *     niche + segment + geography + problem keywords)
 *
 * These new fields are persisted into `opportunity.metadata` so they
 * survive a DB round-trip and are available to the mesh webhook payload
 * via `toOpportunityV1()`.
 */

import type { Evidence, Opportunity, Problem, Signal, Trend } from '../models.js';
import { generateId, nowISO } from '../models.js';
import { logger } from '../logger.js';
import { detectTechMentions } from './capability-mapping.js';
import { OpportunityV1Schema, type OpportunityV1 } from '../schema/opportunity-v1.js';

export interface OpportunityInput {
  trend?: Trend;
  problem?: Problem;
  signals: Signal[];
  evidence: Evidence[];
  geography: string;
  /** Original investigation objective — used to derive a niche label. */
  objective?: string;
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
    niche?: string;
    valueProposition?: string;
    whyNow?: string;
    risks?: string[];
    leadSearchHints?: string[];
  };
}

export interface OpportunityResult {
  opportunity: Opportunity;
  /** Si true, la oportunidad es muy débil y probablemente no debería entregarse. */
  weak: boolean;
  /**
   * The OpportunityV1-validated payload (mesh webhook contract). `null`
   * when validation failed — the orchestrator drops these opportunities
   * and logs the schema error so operators can see which opportunities
   * were rejected for contract violations.
   */
  v1: OpportunityV1 | null;
  /** When `v1` is null, the validation error message (for logging). */
  v1Error?: string;
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
  const { trend, problem, signals, evidence, geography, objective } = input;

  if (!trend && !problem) {
    throw new Error('generateOpportunity requires at least one of trend or problem');
  }

  const demand = computeDemand(trend, signals);
  const growth = trend?.growth ? Math.round(trend.growth * 100) : computeGrowthFallback(signals);
  const problemSeverity = problem?.severity ?? Math.round(0.3 * 100);
  const monetization = input.llmHint?.monetization ?? estimateMonetization(signals, problem);
  const timing = input.llmHint?.timing ?? estimateTiming(trend, signals);
  let marketFit = input.llmHint?.marketFit ?? estimateMarketFit(signals);
  const competition = input.llmHint?.competition ?? estimateCompetition(signals);
  const uncertainty = computeUncertainty(trend, problem, signals);

  // IMP-CLONA-3 — capability-mapping enrichment: aggregate the web equivalents
  // mentioned across all signal snippets. Signals that name a concrete native
  // framework (e.g. "uses CoreData", "built with SwiftUI") are actionable —
  // we know what to build on the web. That bumps marketFit slightly because
  // the opportunity is concrete rather than abstract.
  const techRecommendations = computeTechRecommendations(signals);
  if (techRecommendations.length > 0) {
    marketFit = clamp100(marketFit + 5);
  }

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

  // FASE-3-QUALITY §3.6 — concrete + complete opportunity fields.
  const niche = input.llmHint?.niche ?? deriveNiche(trend, problem, signals, objective);
  const targetSegment = deriveTargetSegment(input, problem);
  const valueProposition = input.llmHint?.valueProposition ?? deriveValueProposition(problem, trend, signals, niche);
  const whyNow = input.llmHint?.whyNow ?? deriveWhyNow(trend, signals, timing);
  const risks = input.llmHint?.risks ?? deriveRisks(problem, competition, uncertainty, signals);
  const leadSearchHints = input.llmHint?.leadSearchHints ?? deriveLeadSearchHints(niche, targetSegment, geography, problem, signals);

  const title = input.llmHint?.title ?? deriveCompleteTitle(niche, targetSegment, geography);
  const description = input.llmHint?.description ?? deriveCompleteDescription({
    niche,
    valueProposition,
    whyNow,
    targetSegment,
    geography,
    signals,
    trend,
    problem,
  });
  const suggestedNextAgent = 'AGENTE-LEADS';

  // FASE-3-QUALITY §3.7 — build the V1 contract payload. The Opportunity
  // record itself is unchanged (for backward compat with the DB schema and
  // dashboard consumers); the V1 payload is the strict contract that the
  // mesh webhook sends to AGENTE-LEADS.
  const v1Payload: OpportunityV1 = {
    schemaVersion: 'opportunity.v1',
    id: generateId('opp'), // temp id; orchestrator reassigns the canonical id below
    niche,
    targetSegment,
    geography,
    problem: problem?.description ?? '(no explicit problem detected)',
    valueProposition,
    whyNow,
    risks,
    score: score100,
    confidence,
    evidence: evidence.slice(0, 20).map((e) => ({
      source: e.source,
      url: e.url,
      snippet: (e.extractedFact ?? e.rawValue ?? '').slice(0, 500),
      truthLevel: e.evidenceType,
    })),
    suggestedNextAgent: 'AGENTE-LEADS',
    leadSearchHints,
  };

  // Use the V1 id as the canonical Opportunity id so callers and the mesh
  // stay in sync.
  const opportunityId = v1Payload.id;

  const opportunity: Opportunity = {
    id: opportunityId,
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
    tech_recommendations: techRecommendations,
    metadata: {
      niche,
      valueProposition,
      whyNow,
      risks,
      leadSearchHints,
      objective: objective?.slice(0, 200),
    },
  };

  // Validate against the V1 schema. If validation fails, we still return
  // the opportunity (so the orchestrator can log it) but `v1` is null and
  // `v1Error` carries the parse error. The orchestrator drops opportunities
  // with `v1 === null`.
  let v1: OpportunityV1 | null = null;
  let v1Error: string | undefined;
  try {
    v1 = OpportunityV1Schema.parse({
      ...v1Payload,
      id: opportunityId,
    });
  } catch (e: any) {
    v1Error = e?.message ?? String(e);
    logger.warn('Opportunity V1 schema validation failed', {
      opportunityId,
      niche,
      err: v1Error,
    });
  }

  const weak = score100 < 35 || confidence < 0.3;

  logger.info('Opportunity generated', {
    title,
    niche,
    targetSegment,
    geography,
    score: score100,
    confidence,
    weak,
    v1Valid: v1 !== null,
    evidenceCount: evidence.length,
    techRecommendations: techRecommendations.length,
    leadSearchHints: leadSearchHints.length,
  });

  return { opportunity, weak, v1, v1Error };
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

/**
 * IMP-CLONA-3 — Capability-mapping enrichment.
 *
 * Aggregates the web equivalents of every native framework mentioned across
 * the signal snippets, returns the unique set (capped at 5). Strings like
 * "IndexedDB o localStorage" are split on " o " so the consumer gets discrete
 * recommendations instead of compound ones.
 *
 * Returns an empty array when no tech mentions are found — callers should
 * treat that as "no concrete web recommendation surfaced from signals".
 */
function computeTechRecommendations(signals: Signal[]): string[] {
  const allSnippets = signals.map((s) => s.rawSnippet ?? '').join(' ');
  if (!allSnippets.trim()) return [];

  const techMentions = detectTechMentions(allSnippets);
  if (techMentions.length === 0) return [];

  const unique = new Set<string>();
  for (const t of techMentions) {
    for (const part of t.entry.web_equivalent.split(' o ')) {
      const trimmed = part.trim();
      // Skip placeholder answers ("No disponible en web", "No aplica en web")
      // — they don't help a builder pick a web technology.
      if (/^no (disponible|aplica)/i.test(trimmed)) continue;
      if (trimmed) unique.add(trimmed);
    }
  }
  return Array.from(unique).slice(0, 5);
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
// TITLE / DESCRIPTION DERIVATION (FASE-3-QUALITY §3.6)
// ---------------------------------------------------------------------------

/**
 * Derive the niche label — a short noun phrase that names the product/
 * service category the opportunity belongs to.
 *
 * Strategy (in order of preference):
 *   1. If the trend has a multi-word canonical, use it (it's already a
 *      descriptive phrase thanks to the clustering §3.4 dedup pass).
 *   2. Else, derive from the problem's segments + the most frequent
 *      non-stopword in the signal snippets (e.g. "restaurantes bogota").
 *   3. Else, fall back to the objective's main noun (if available) +
 *      "para <segment>".
 *
 * The returned string is always a concrete noun phrase, never the
 * literal string "unknown" or "Opportunity".
 */
function deriveNiche(
  trend: Trend | undefined,
  problem: Problem | undefined,
  signals: Signal[],
  objective?: string,
): string {
  // 1. Trend canonical (multi-word preferred).
  if (trend) {
    const t = trend.topic.trim();
    if (t && t.includes(' ')) return t.toLowerCase();
    if (t && t.length > 3 && t !== 'unknown') return t.toLowerCase();
  }
  // 2. Top signal keyword + a secondary token from the snippet.
  const sig = signals[0];
  if (sig) {
    const kw = sig.keyword?.trim();
    if (kw && kw !== 'unknown') {
      const secondary = topSecondaryToken(signals, kw);
      if (secondary) return `${kw.toLowerCase()} ${secondary}`;
      return kw.toLowerCase();
    }
  }
  // 3. Objective-derived.
  if (objective) {
    const objTokens = objective.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    if (objTokens.length > 0) {
      const seg = problem?.segmentsAffected?.[0];
      return seg ? `${objTokens.slice(0, 3).join(' ')} para ${seg}` : objTokens.slice(0, 3).join(' ');
    }
  }
  // Last resort — never return 'unknown' (it would make the V1 schema
  // validation pass but produce a useless opportunity).
  return problem?.topic?.toLowerCase() ?? 'oportunidad sin nombre';
}

/**
 * Derive the target segment. Order of preference:
 *   1. LLM hint (suggestedSegment).
 *   2. Problem.segmentsAffected[0] (when the problem engine inferred it).
 *   3. Heuristic scan of signal snippets for known segment keywords.
 *   4. 'segmento desconocido' — propagates uncertainty rather than
 *      inventing a fake segment.
 */
function deriveTargetSegment(input: OpportunityInput, problem: Problem | undefined): string {
  if (input.llmHint?.suggestedSegment && input.llmHint.suggestedSegment.trim()) {
    return input.llmHint.suggestedSegment.trim();
  }
  if (input.targetSegment && input.targetSegment.trim() && input.targetSegment !== 'unspecified') {
    return input.targetSegment.trim();
  }
  if (problem?.segmentsAffected && problem.segmentsAffected.length > 0) {
    return problem.segmentsAffected[0];
  }
  const seg = scanForSegment(input.signals);
  if (seg) return seg;
  return 'segmento desconocido';
}

/**
 * Scan signal snippets for known segment keywords (Spanish + English).
 */
function scanForSegment(signals: Signal[]): string | undefined {
  const PATTERNS: Array<{ re: RegExp; label: string }> = [
    { re: /\brestaurante[s]?\b/i, label: 'restaurantes' },
    { re: /\bpyme[s]?\b/i, label: 'PYMEs' },
    { re: /\bcomercio[s]?\b/i, label: 'comercios' },
    { re: /\btienda[s]?\b/i, label: 'tiendas' },
    { re: /\bcafeteria[s]?\b/i, label: 'cafeterías' },
    { re: /\bhotel(es)?\b/i, label: 'hoteles' },
    { re: /\bstartup[s]?\b/i, label: 'startups' },
    { re: /\bfreelancer[s]?\b/i, label: 'freelancers' },
    { re: /\bdueño[s]? de mascota[s]?\b/i, label: 'dueños de mascotas' },
    { re: /\bmascota[s]?\b/i, label: 'dueños de mascotas' },
    { re: /\bperro[s]?\b/i, label: 'dueños de mascotas' },
    { re: /\bcreator[s]?\b|\bcreador(?:es)?\b/i, label: 'creadores de contenido' },
    { re: /\binfluencer[s]?\b/i, label: 'influencers' },
    { re: /\bempresa[s]?\b/i, label: 'empresas' },
  ];
  for (const s of signals) {
    const text = s.rawSnippet ?? '';
    for (const p of PATTERNS) {
      if (p.re.test(text)) return p.label;
    }
  }
  return undefined;
}

/**
 * Top secondary token — the most frequent non-stopword in the signal
 * snippets that is NOT the primary keyword. Used to make the niche
 * label more descriptive (e.g. "collares" + "perros" → "collares perros").
 */
function topSecondaryToken(signals: Signal[], primary: string): string | undefined {
  const primaryNorm = primary.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const STOP = new Set([
    'the','a','an','of','to','in','on','for','and','or','with','is','are','be','by',
    'el','la','los','las','un','una','de','del','al','en','para','por','con','y','o',
    'que','se','su','sus','es','son','ser','como','mas','muy',
  ]);
  const freq = new Map<string, number>();
  for (const s of signals) {
    const text = (s.rawSnippet ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const tokens = text.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w) && w !== primaryNorm);
    for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [tok, count] of freq.entries()) {
    if (count > bestCount) {
      best = tok;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Value proposition — a single sentence describing WHAT to sell/offer.
 *
 * Structure:
 *   "Ofrecer <product/service> para <segment> en <geography> que
 *    resuelve <pain phrase from problem>."
 *
 * The pain phrase comes from the problem description's "QUÉ:" clause
 * (FASE-3-QUALITY §3.5), so the value prop is grounded in the evidence
 * rather than a generic template.
 */
function deriveValueProposition(
  problem: Problem | undefined,
  trend: Trend | undefined,
  signals: Signal[],
  niche: string,
): string {
  const painPhrase = extractPainFromProblem(problem);
  const trendState = trend?.state?.toLowerCase().replace(/_/g, ' ') ?? 'sin tendencia clara';
  return `Ofrecer ${niche} que resuelve "${painPhrase}". Tendencia subyacente: ${trendState} con ${signals.length} señales de evidencia.`;
}

/**
 * Extract the pain phrase from a Problem description's "QUÉ:" clause.
 * Falls back to the full problem description when the structure isn't
 * the FASE-3-QUALITY §3.5 format (e.g. problems persisted before the
 * fix, or problems created by tests).
 */
function extractPainFromProblem(problem: Problem | undefined): string {
  if (!problem) return 'fricción no diagnosticada';
  const m = problem.description.match(/QUÉ:\s*(.+?)(?:\.\s*Evidencia:|$)/s);
  if (m && m[1]) return m[1].trim();
  return problem.description.slice(0, 200);
}

/**
 * Why-now — timing rationale. Explains WHY this is the right moment to
 * pursue the opportunity, grounded in the trend state + signal recency.
 */
function deriveWhyNow(trend: Trend | undefined, signals: Signal[], timingScore: number): string {
  const parts: string[] = [];
  if (trend) {
    const state = trend.state.toLowerCase().replace(/_/g, ' ');
    parts.push(`Tendencia ${state} (score ${trend.score}/100, growth ${Math.round((trend.growth ?? 0) * 100)}%).`);
    if (trend.direction === 'up') parts.push('Dirección al alza.');
    if (trend.direction === 'flat') parts.push('Dirección estable — ventana de entrada abierta.');
  } else {
    parts.push('Sin trend explícito — la señal proviene del problema detectado.');
  }
  const recentCount = signals.filter((s) => {
    const when = s.observedAt ?? s.timestamp;
    return Date.now() - Date.parse(when) < 30 * 86400 * 1000;
  }).length;
  parts.push(`${recentCount} de ${signals.length} señales publicadas en los últimos 30 días.`);
  parts.push(`Score de timing: ${timingScore}/100.`);
  return parts.join(' ');
}

/**
 * Derive 3-5 risks. Sources:
 *   - High competition → "mercado con competencia visible"
 *   - High uncertainty → "incertidumbre sobre la demanda real"
 *   - Segment unknown → "segmento no inferido desde la evidencia"
 *   - Low evidence volume → "evidencia limitada (<5 señales)"
 *   - Low confidence → "confianza del trend/problem por debajo de 0.5"
 */
function deriveRisks(
  problem: Problem | undefined,
  competition: number,
  uncertainty: number,
  signals: Signal[],
): string[] {
  const risks: string[] = [];
  if (competition > 60) risks.push(`Mercado con competencia visible (score ${competition}/100).`);
  if (uncertainty > 60) risks.push(`Incertidumbre alta sobre la demanda real (score ${uncertainty}/100).`);
  if (problem && (problem.segmentsAffected.length === 0)) {
    risks.push('Segmento objetivo no inferido desde la evidencia — validar manualmente.');
  }
  if (signals.length < 5) {
    risks.push(`Evidencia limitada (${signals.length} señales — recomendado >=5).`);
  }
  if (problem && problem.confidence < 0.5) {
    risks.push(`Confianza del problema por debajo de 0.5 (${problem.confidence.toFixed(2)}).`);
  }
  // Always at least 3 risks so the V1 schema (.array().min(3)) passes.
  if (risks.length < 3) {
    risks.push('Cambios regulatorios locales no evaluados.');
  }
  if (risks.length < 3) {
    risks.push('Estacionalidad de la demanda no analizada.');
  }
  if (risks.length < 3) {
    risks.push('Validación con clientes potenciales pendiente.');
  }
  return risks.slice(0, 5);
}

/**
 * Derive 3-5 lead-search hints — concrete search queries AGENTE-LEADS
 * can run to find prospective customers / content / competitors in the
 * niche + segment + geography.
 */
function deriveLeadSearchHints(
  niche: string,
  segment: string,
  geography: string,
  problem: Problem | undefined,
  signals: Signal[],
): string[] {
  const geo = geography && geography !== 'global' ? ` ${geography}` : '';
  const seg = segment !== 'segmento desconocido' ? ` para ${segment}` : '';
  const hints = new Set<string>();
  // 1. Direct niche query with geo.
  hints.add(`${niche}${geo}`.trim());
  // 2. Segment-targeted query.
  if (seg) hints.add(`${niche}${seg}${geo}`.trim());
  // 3. Pain-keyword query (uses the problem's pain phrase).
  if (problem) {
    const pain = extractPainFromProblem(problem).slice(0, 60);
    hints.add(`"${pain}"${geo}`.trim());
  }
  // 4. Forum/community query (Reddit-style) — finds real complaints.
  hints.add(`reddit ${niche}${geo}`.trim());
  // 5. Competitor / pricing query.
  hints.add(`${niche} precio competitors${geo}`.trim());
  // Always at least 3 hints so the V1 schema (.min(3)) passes.
  const out = Array.from(hints).filter((h) => h.length > 0);
  while (out.length < 3) {
    out.push(`${niche} ${signals.length || 1}${geo}`.trim());
  }
  return out.slice(0, 5);
}

/**
 * Concrete complete title — names the niche + segment + geography so
 * the title alone is informative (not just "Opportunity around X").
 */
function deriveCompleteTitle(niche: string, segment: string, geography: string): string {
  const geo = geography && geography !== 'global' ? ` en ${geography}` : '';
  const seg = segment !== 'segmento desconocido' ? ` para ${segment}` : '';
  return `Oportunidad: ${niche}${seg}${geo}`;
}

function deriveCompleteDescription(input: {
  niche: string;
  valueProposition: string;
  whyNow: string;
  targetSegment: string;
  geography: string;
  signals: Signal[];
  trend?: Trend;
  problem?: Problem;
}): string {
  const parts: string[] = [];
  parts.push(`Nicho: ${input.niche}.`);
  parts.push(`Segmento objetivo: ${input.targetSegment}.`);
  if (input.geography && input.geography !== 'global') parts.push(`Geografía: ${input.geography}.`);
  parts.push(`Propuesta de valor: ${input.valueProposition}`);
  parts.push(`Por qué ahora: ${input.whyNow}`);
  if (input.problem) parts.push(`Problema: severidad ${input.problem.severity}/100, frecuencia ${input.problem.frequency}/100.`);
  if (input.trend) parts.push(`Tendencia: ${input.trend.state.toLowerCase().replace(/_/g, ' ')} con score ${input.trend.score}/100.`);
  parts.push(`Base de evidencia: ${input.signals.length} señales normalizadas.`);
  return parts.join(' ');
}

/**
 * Backward-compat: callers that don't yet use the V1 contract can still
 * get a (now concrete) title. Returns the complete title.
 */
function deriveTitle(trend: Trend | undefined, problem: Problem | undefined): string {
  if (problem && trend) {
    return `Oportunidad: ${trend.topic.toLowerCase()} — ${problem.topic.toLowerCase()}`;
  }
  if (problem) {
    return `Oportunidad de resolver: ${problem.topic.toLowerCase()}`;
  }
  if (trend) {
    return `Oportunidad alrededor de: ${trend.topic.toLowerCase()}`;
  }
  return 'Oportunidad (contexto insuficiente)';
}

/**
 * Backward-compat: returns a structured description when callers don't
 * use the V1 contract.
 */
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

// ---------------------------------------------------------------------------
// V1 CONTRACT CONVERSION (FASE-3-QUALITY §3.7)
// ---------------------------------------------------------------------------

/**
 * Reconstruct an OpportunityV1 payload from a persisted Opportunity.
 *
 * Used by `mesh/auto-publish.ts` when the orchestrator doesn't pass the
 * in-memory V1 object (e.g. when re-publishing opportunities loaded from
 * the DB on a subsequent run). Reads the structured fields from
 * `opportunity.metadata` (set by `generateOpportunity`) — when those
 * fields are missing (rows persisted before FASE-3-QUALITY), we
 * recompute them from the opportunity + its evidence.
 *
 * Always validates against `OpportunityV1Schema` before returning. When
 * validation fails, returns `null` and sets `error` on the result.
 */
export interface OpportunityV1Conversion {
  v1: OpportunityV1 | null;
  error?: string;
}

export function toOpportunityV1(opp: Opportunity): OpportunityV1Conversion {
  const meta = (opp.metadata ?? {}) as {
    niche?: string;
    valueProposition?: string;
    whyNow?: string;
    risks?: string[];
    leadSearchHints?: string[];
    objective?: string;
  };
  const niche = meta.niche ?? deriveNicheFromTitle(opp.title);
  const targetSegment = opp.targetSegment || 'segmento desconocido';
  const geography = opp.geography || 'global';
  const valueProposition = meta.valueProposition ?? `Ofrecer ${niche} para ${targetSegment} en ${geography}.`;
  const whyNow = meta.whyNow ?? `Timing score ${opp.timing}/100.`;
  const risks = meta.risks && meta.risks.length >= 3
    ? meta.risks.slice(0, 5)
    : ['Mercado con competencia visible.', 'Incertidumbre sobre la demanda real.', 'Cambios regulatorios locales no evaluados.'];
  const leadSearchHints = meta.leadSearchHints && meta.leadSearchHints.length >= 3
    ? meta.leadSearchHints.slice(0, 5)
    : deriveLeadSearchHints(niche, targetSegment, geography, undefined, []);
  const payload: OpportunityV1 = {
    schemaVersion: 'opportunity.v1',
    id: opp.id,
    niche,
    targetSegment,
    geography,
    problem: opp.problem,
    valueProposition,
    whyNow,
    risks,
    score: opp.score,
    confidence: opp.confidence,
    evidence: opp.evidence.slice(0, 20).map((e) => ({
      source: e.source,
      url: e.url,
      snippet: (e.extractedFact ?? e.rawValue ?? '').slice(0, 500),
      truthLevel: e.evidenceType,
    })),
    suggestedNextAgent: 'AGENTE-LEADS',
    leadSearchHints,
  };
  try {
    const v1 = OpportunityV1Schema.parse(payload);
    return { v1 };
  } catch (e: any) {
    return { v1: null, error: e?.message ?? String(e) };
  }
}

/**
 * Best-effort niche extraction from a legacy opportunity title.
 * Strips the leading "Oportunidad:" prefix and any geography suffix.
 */
function deriveNicheFromTitle(title: string): string {
  if (!title) return 'oportunidad sin nombre';
  let t = title.trim();
  t = t.replace(/^Oportunidad:\s*/i, '');
  t = t.replace(/^Opportunity(?:\s+around)?(?:\s+to\s+solve)??:?\s*/i, '');
  // Strip trailing " en <geography>" / " para <segment>".
  t = t.replace(/\s+en\s+[\w\s]+$/i, '');
  t = t.replace(/\s+para\s+[\w\s]+$/i, '');
  return t.trim().toLowerCase() || 'oportunidad sin nombre';
}
