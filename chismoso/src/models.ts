/**
 * CHISMOSO V1.0 — Canonical Models
 *
 * Este archivo define los modelos centrales que cruzan todo el sistema.
 * Siguen la semántica de la especificación pero pueden ajustarse técnicamente.
 *
 * Cualquier модифicación a estos modelos requiere bump de versión y migración.
 */

// ---------------------------------------------------------------------------
// PRINCIPIO DE VERDAD (sección 5 de la especificación — versión extendida §7)
// ---------------------------------------------------------------------------
//
// V1.0 inicialmente sólo definía OBSERVED / DERIVED / INFERRED / PREDICTED /
// UNKNOWN. AUDIT-A §7 (P0 #1) señaló que esto no permite distinguir:
//   - UNVERIFIED  — observado por una sola fuente, sin corroboración
//   - VERIFIED    — corroborado por múltiples fuentes independientes
//   - ESTIMATED   — aproximación (ej. confianza decaída por staleness §15)
//
// La extensión es aditiva para no romper código existente que ya persiste
// OBSERVED/DERIVED/INFERRED/PREDICTED/UNKNOWN. Los nuevos valores permiten
// que cross-source.ts pueda promover el truth level cuando hay múltiples
// fuentes confirmando un mismo hecho.
// ---------------------------------------------------------------------------

export enum TruthLevel {
  OBSERVED = 'OBSERVED', // Una fuente realmente muestra esto (raw signal)
  VERIFIED = 'VERIFIED', // Corroborado por múltiples fuentes independientes
  DERIVED = 'DERIVED', // Sintetizado a partir de evidencia observada (alias histórico)
  INFERRED = 'INFERRED', // Hipótesis razonable
  ESTIMATED = 'ESTIMATED', // Aproximación (ej. confidence decaída por staleness)
  UNVERIFIED = 'UNVERIFIED', // Una sola fuente, sin confirmación
  PREDICTED = 'PREDICTED', // Proyección futura
  UNKNOWN = 'UNKNOWN', // Información insuficiente
}

// ---------------------------------------------------------------------------
// SIGNAL TYPES (sección 14)
// ---------------------------------------------------------------------------

export enum SignalType {
  SEARCH_SPIKE = 'SEARCH_SPIKE',
  MENTION_SPIKE = 'MENTION_SPIKE',
  QUESTION_SPIKE = 'QUESTION_SPIKE',
  COMPLAINT_SPIKE = 'COMPLAINT_SPIKE',
  CONTENT_GROWTH = 'CONTENT_GROWTH',
  ENGAGEMENT_GROWTH = 'ENGAGEMENT_GROWTH',
  NEW_PRODUCT = 'NEW_PRODUCT',
  NEW_BEHAVIOR = 'NEW_BEHAVIOR',
  PRICE_CHANGE = 'PRICE_CHANGE',
  DEMAND_SIGNAL = 'DEMAND_SIGNAL',
  PROBLEM_SIGNAL = 'PROBLEM_SIGNAL',
  MARKET_SIGNAL = 'MARKET_SIGNAL',
}

export const ALL_SIGNAL_TYPES: SignalType[] = Object.values(SignalType);

// ---------------------------------------------------------------------------
// SOURCE TYPES (sección 9)
// ---------------------------------------------------------------------------

export enum SourceType {
  SEARCH_WEB = 'SEARCH_WEB',
  GOOGLE_TRENDS = 'GOOGLE_TRENDS',
  REDDIT_COMMUNITIES = 'REDDIT_COMMUNITIES',
  YOUTUBE = 'YOUTUBE',
  SOCIAL_MEDIA = 'SOCIAL_MEDIA',
  WEB_CONTENT = 'WEB_CONTENT',
}

// ---------------------------------------------------------------------------
// SIGNAL (sección 13 — extendido §5)
// ---------------------------------------------------------------------------
//
// AUDIT-A §5 (P0 #5) señaló tres campos faltantes requeridos por el spec:
//   - observed_at  → cuándo ocurrió el evento en la fuente (vs `timestamp`
//                    que es cuándo CHISMOSO lo capturó)
//   - entity       → named entity extraída (restaurante, producto, persona)
//   - unit         → unidad del `value` (mentions / count / score / ratio)
//
// Todos opcionales para preservar backward compatibility con señales ya
// persistidas que no los tienen.
// ---------------------------------------------------------------------------

export interface Signal {
  id: string;
  topic: string;
  keyword: string;
  source: string;
  sourceType: SourceType;
  timestamp: string; // ISO — cuando CHISMOSO capturó la señal
  observedAt?: string; // ISO — cuando ocurrió el evento en la fuente (§5)
  geography: string;
  metric: string;
  value: number | string;
  normalizedValue: number;
  unit?: string; // unidad del value: 'mentions' | 'count' | 'score' | ... (§5)
  entity?: string; // named entity extraída: restaurante, producto, persona (§5)
  direction: 'up' | 'down' | 'flat' | 'unknown';
  velocity: number; // cambio por unidad de tiempo, 0 si no aplica
  confidence: number; // 0..1
  evidenceType: TruthLevel;
  signalType: SignalType;
  metadata: Record<string, unknown>;
  rawSnippet: string;
  url?: string;
  evidenceIds?: string[]; // back-ref a la Evidence que soporta esta señal (§5)
}

// ---------------------------------------------------------------------------
// EVIDENCE (sección 6 — ADN de evidencia, extendido §8)
// ---------------------------------------------------------------------------
//
// AUDIT-A §8 (P0 #3) señaló tres campos faltantes requeridos por el spec:
//   - extracted_fact       → el hecho específico extraído, distinto del
//                            rawValue (que es el snippet completo)
//   - provenance           → cómo se obtuvo: 'web_search' | 'reddit_communities' |
//                            'mesh_external' | 'deepen_content' | ...
//   - verification_status  → 'unverified' | 'verified' | 'contradicted' | 'stale'
//
// Sin verification_status, una Evidence no puede ser invalidada más tarde
// cuando una investigación más reciente la contradice. El modelo actual
// trata toda Evidence persistida como verdad inmutable — esto lo arregla.
// ---------------------------------------------------------------------------

export type EvidenceVerificationStatus =
  | 'unverified'
  | 'verified'
  | 'contradicted'
  | 'stale';

export interface Evidence {
  id: string;
  source: string;
  sourceType: SourceType;
  url?: string;
  observedAt: string; // ISO
  collectedAt: string; // ISO
  geographicScope: string;
  topic: string;
  rawValue: string;
  normalizedValue: string;
  extractedFact?: string; // hecho específico extraído (distinto de rawValue) (§8)
  provenance?: string; // cómo se obtuvo: 'web_search' | 'reddit_communities' | ... (§8)
  verificationStatus?: EvidenceVerificationStatus; // §8
  confidence: number;
  evidenceType: TruthLevel;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// TREND (sección 7.1 y 15 — extendido §17)
// ---------------------------------------------------------------------------
//
// AUDIT-A §17 (P0 #4) señaló que `Trend` tenía `state` (NOISE / WEAK_SIGNAL /
// EMERGING_TREND / ...) pero no `direction: up|down|flat`. El spec §17 lista
// `direction` como campo requerido.
//
// `direction` se computa a partir de `growth`:
//   - growth > 1.2 → 'up'    (más señales recientes que históricas)
//   - growth < 0.8 → 'down'  (menos señales recientes que históricas)
//   - else          → 'flat'
// ---------------------------------------------------------------------------

export type TrendDirection = 'up' | 'down' | 'flat';

export enum TrendState {
  NOISE = 'NOISE',
  WEAK_SIGNAL = 'WEAK_SIGNAL',
  EMERGING_TREND = 'EMERGING_TREND',
  STRONG_TREND = 'STRONG_TREND',
  ESTABLISHED_TREND = 'ESTABLISHED_TREND',
  DECLINING_TREND = 'DECLINING_TREND',
}

export interface Trend {
  id: string;
  topic: string;
  description: string;
  state: TrendState;
  direction: TrendDirection; // §17 — computed from growth
  confidence: number;
  sourcesCount: number;
  signalsCount: number;
  evidence: Evidence[];
  signals: Signal[];
  firstSeen: string;
  lastSeen: string;
  observationCount: number;
  growth: number; // 0..1 normalizado
  velocity: number;
  persistence: number; // 0..1
  crossSourceConfirmation: number; // 0..1
  score: number; // 0..100
  scoreBreakdown: Record<string, number>;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// PROBLEM (sección 7.2 y 19)
// ---------------------------------------------------------------------------

export interface Problem {
  id: string;
  description: string;
  topic: string;
  severity: number; // 0..100
  frequency: number; // 0..100
  confidence: number; // 0..1
  evidence: Evidence[];
  signals: Signal[];
  segmentsAffected: string[];
  firstSeen: string;
  lastSeen: string;
  observationCount: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// OPPORTUNITY (sección 20, 21 y 30)
// ---------------------------------------------------------------------------

export interface Opportunity {
  id: string;
  title: string;
  description: string;
  problem: string;
  problemRef?: string;
  targetSegment: string;
  geography: string;
  evidence: Evidence[];
  trendRef?: string;
  trend?: Trend;
  problemRef_obj?: Problem;
  demand: number; // 0..100
  growth: number; // 0..100
  problemSeverity: number; // 0..100
  monetization: number; // 0..100
  timing: number; // 0..100
  marketFit: number; // 0..100
  competition: number; // 0..100
  uncertainty: number; // 0..100
  score: number; // 0..100
  scoreBreakdown: Record<string, number>;
  confidence: number; // 0..1
  suggestedNextAgent: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// INVESTIGATION (sección 32 — observability)
// ---------------------------------------------------------------------------

export enum InvestigationStatus {
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  PARTIAL = 'PARTIAL',
  FAILED = 'FAILED',
  INSUFFICIENT_EVIDENCE = 'INSUFFICIENT_EVIDENCE',
}

export interface ProviderRun {
  providerName: string;
  startedAt: string;
  completedAt?: string;
  query: string;
  resultsCount: number;
  error?: string;
  errorCode?: string;
  durationMs?: number;
}

export interface Investigation {
  id: string;
  query: string;
  scope: string;
  startedAt: string;
  completedAt?: string;
  status: InvestigationStatus;
  providersUsed: string[];
  queriesExecuted: string[];
  signalsFound: number;
  evidenceFound: number;
  trendsFound: number;
  problemsFound: number;
  opportunitiesFound: number;
  errors: string[];
  durationMs?: number;
  providerRuns: ProviderRun[];
  iterations: number;
  budget: InvestigationBudget;
  /**
   * ID of the ExecutionTrace that wraps this investigation (§30).
   * Optional for backward compatibility with investigations persisted
   * before the ExecutionTrace system existed.
   */
  executionId?: string;
}

// ---------------------------------------------------------------------------
// AUTONOMY BUDGET (sección 26)
// ---------------------------------------------------------------------------

export interface InvestigationBudget {
  maxIterations: number;
  maxQueries: number;
  maxSources: number;
  maxResults: number;
  maxRuntimeMs: number;
  maxProviderCalls: number;
}

export const DEFAULT_BUDGET: InvestigationBudget = {
  maxIterations: 3,
  maxQueries: 12,
  maxSources: 5,
  maxResults: 60,
  maxRuntimeMs: 5 * 60 * 1000, // 5 minutos
  maxProviderCalls: 15,
};

// ---------------------------------------------------------------------------
// INTELLIGENCE REPORT (sección 27 y 28)
// ---------------------------------------------------------------------------

export interface IntelligenceReport {
  query: string;
  scope: string;
  generatedAt: string;
  executiveSummary: string;
  trends: Trend[];
  problems: Problem[];
  opportunities: Opportunity[];
  signals: Signal[];
  evidence: Evidence[];
  overallConfidence: number;
  limitations: string[];
  recommendedNextAction: string;
  investigationId: string;
  providersUsed: string[];
}

// ---------------------------------------------------------------------------
// PROVIDER HEALTH (sección 33)
// ---------------------------------------------------------------------------

export enum ProviderHealth {
  OK = 'OK',
  DEGRADED = 'DEGRADED',
  UNAVAILABLE = 'UNAVAILABLE',
  AUTH_REQUIRED = 'AUTH_REQUIRED',
  RATE_LIMITED = 'RATE_LIMITED',
}

export interface ProviderCapabilities {
  name: string;
  type: SourceType;
  capabilities: string[];
  status: ProviderHealth;
  limits: {
    requestsPerMinute?: number;
    maxResultsPerCall?: number;
  };
  authentication: 'none' | 'env' | 'oauth';
}

// ---------------------------------------------------------------------------
// TOPIC CLUSTER (sección 18)
// ---------------------------------------------------------------------------

export interface TopicCluster {
  id: string;
  canonical: string;
  keywords: string[];
  signalIds: string[];
  evidenceIds: string[];
  sourcesCount: number;
  firstSeen: string;
  lastSeen: string;
  observationCount: number;
}

// ---------------------------------------------------------------------------
// HELPER: ID generation (deterministic, no external deps)
// ---------------------------------------------------------------------------

export function generateId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${ts}${rnd}`;
}

export function nowISO(): string {
  return new Date().toISOString();
}
