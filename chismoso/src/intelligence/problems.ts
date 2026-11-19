/**
 * CHISMOSO V1.0 — Problem Detection (sección 19)
 *
 * Detecta problemas emergentes a partir de señales tipo:
 *   complaints, questions, frustraciones, trabajo manual, alta fricción,
 *   sentimiento negativo, requests repetidos.
 *
 * Regla crítica: sentimiento negativo ≠ automáticamente problema de negocio.
 * Debe existir evidencia de repetición, relevancia o intensidad.
 *
 * FASE-3-QUALITY §3.5 — concrete problem descriptions.
 * Each detected Problem's `description` MUST include:
 *   - WHO suffers the problem (segment inferred from evidence, or
 *     "segmento desconocido" when the segment can't be inferred).
 *   - WHAT the pain is (extracted from the signal snippets, not a
 *     template like "Recurring friction observed around X").
 *   - A supporting quote from the top evidence signal.
 *
 * When the segment can't be inferred, confidence is lowered (the problem
 * is real but we don't know who it affects).
 */

import type { Evidence, Problem, Signal } from '../models.js';
import { generateId, nowISO, SignalType as ST } from '../models.js';
import { logger } from '../logger.js';

const PROBLEM_SIGNAL_TYPES = new Set<string>([
  ST.COMPLAINT_SPIKE,
  ST.QUESTION_SPIKE,
  ST.PROBLEM_SIGNAL,
]);

/**
 * Patrones lingüísticos que sugieren un problema / fricción.
 * Caso-insensible, sin acentos.
 * Cobertura EN + ES para V1.
 */
const FRICTION_PATTERNS = [
  // EN — preguntas
  /\bhow do i\b/, /\bhow to\b/, /\bdoes anyone know\b/, /\bis there a way\b/, /\bcan i\b/, /\bcan't\b/, /\bcannot\b/,
  // EN — quejas / fricción
  /\bproblems?\b/, /\bissues?\b/, /\bbugs?\b/, /\bnot working\b/, /\bfrustrat/, /\bannoy/, /\bhate\b/, /\bterrible\b/, /\bsuck\b/, /\bbroken\b/,
  /\bmanual\b/, /\btedious\b/, /\btime.?consuming\b/, /\brepetitive\b/, /\bworkaround\b/, /\blost\b/, /\blosing\b/,
  // EN — Wish / necesidad
  /\bwhy doesn'?t\b/, /\bwhy can'?t\b/, /\bwish there was\b/, /\bneed a tool\b/, /\bwish i could\b/, /\bif only\b/, /\blooking for\b/, /\bneed help\b/,
  // ES — preguntas
  /\bcomo hago\b/, /\bcomo puedo\b/, /\bexiste alguna\b/, /\bhay alguna\b/, /\balguien sabe\b/, /\bcomo automatizar\b/, /\balguien recomienda\b/, /\bque recomiendan\b/, /\bnecesito recomendac/, /\bnecesito una?\b/, /\bnecesito ayuda\b/, /\bme urge\b/,
  // ES — quejas / fricción (incluye plurales y conjugaciones)
  /\bproblemas?\b/, /\bdificiles?\b/, /\bcomplicad[oa]s?\b/, /\bmanualmente\b/, /\btedios[oa]s?\b/, /\bperd[iio]\b/, /\bperdidas?\b/, /\bpierden\b/, /\bperdiendo\b/, /\bquejas?\b/, /\breclamos?\b/, /\bfriccion\b/, /\bno funciona\b/, /\brobo\b/, /\bmala experiencia\b/, /\bdeficiente/, /\bineficiente/, /\binutil/, /\bcostos altos\b/, /\bcaro\b/, /\bcarisimo\b/,
  // ES — necesidad
  /\bquisiera\b/, /\bojala\b/, /\bme gustaria\b/, /\bno hay manera\b/, /\bno encuentro\b/, /\bsigue siendo manual\b/, /\bsin sistema\b/, /\bsin automatizar\b/, /\ba mano\b/,
  // Compartidos
  /\bmanual\b/, /\bworkflow\b/, /\bautomatiz/, /\bfrustrac/, /\bgestion manual\b/, /\bpuestos?\b/, /\bcolas?\b/, /\bespera\b/,
];

export interface ProblemInput {
  topic: string;
  canonical: string;
  signals: Signal[];
  evidence: Evidence[];
  segmentsAffected?: string[];
}

export interface ProblemResult {
  problem: Problem | null;
  reasons: string[];
}

/**
 * Detecta un problema a partir de señales.
 * Devuelve `null` si la evidencia es insuficiente — esto evita que
 * CHISMOSO invente problemas sin base observada.
 *
 * Estrategia (V1, documentada):
 *   - Primero considera señales explícitamente clasificadas como
 *     COMPLAINT/QUESTION/PROBLEM (signalType).
 *   - Si hay <2 de esas, también considera cualquier señal cuyo snippet
 *     matchee patrones de fricción (fallback sobre MENTION_SPIKE).
 *   - Requiere >=2 señales con snippets de fricción distintos.
 */
export function detectProblem(input: ProblemInput): ProblemResult {
  const { signals, evidence, canonical } = input;
  const reasons: string[] = [];

  if (signals.length === 0) {
    return { problem: null, reasons: ['no signals available'] };
  }

  // Pool 1: señales ya clasificadas como problema por el normalizer.
  const typedProblemSignals = signals.filter((s) => PROBLEM_SIGNAL_TYPES.has(s.signalType));

  // Pool 2: cualquier señal con snippet que matchee fricción (fallback).
  const frictionSignalsAll = signals.filter((s) => matchesFriction(s.rawSnippet));

  // Unión de ambos pools.
  const candidateSignals = dedupByContent([...typedProblemSignals, ...frictionSignalsAll]);
  reasons.push(`${typedProblemSignals.length} typed problem signals, ${frictionSignalsAll.length} friction-matching signals, ${candidateSignals.length} union`);

  if (candidateSignals.length < 2) {
    return { problem: null, reasons: [...reasons, `only ${candidateSignals.length} candidate signals (need >= 2)`] };
  }

  // Filtro: al menos 2 snippets distintos (no duplicados).
  const distinctSnippets = new Set(candidateSignals.map((s) => s.rawSnippet.slice(0, 100).toLowerCase()));
  if (distinctSnippets.size < 2) {
    return { problem: null, reasons: [...reasons, 'candidate signals come from duplicated snippet'] };
  }
  reasons.push(`${distinctSnippets.size} distinct friction patterns observed`);

  const severity = computeSeverity(candidateSignals);
  const frequency = computeFrequency(signals);
  const inferredSegments = input.segmentsAffected ?? inferSegments(candidateSignals);
  const segmentsAffected = inferredSegments.length > 0 ? inferredSegments : [];
  const segmentUnknown = segmentsAffected.length === 0;
  // FASE-3-QUALITY §3.5 — when the segment can't be inferred from
  // evidence, lower the confidence. The problem is still real (we have
  // 2+ friction signals), but we don't know WHO it affects — that's a
  // meaningful uncertainty the downstream opportunity engine should
  // factor in.
  const baseConfidence = Math.min(
    0.9,
    0.3 + candidateSignals.length * 0.07 + distinctSnippets.size * 0.05,
  );
  const confidence = segmentUnknown ? Math.max(0.1, baseConfidence - 0.2) : baseConfidence;

  const now = nowISO();
  // FASE-3-QUALITY §3.3 — use observedAt (publication date) for firstSeen/
  // lastSeen when available, so the problem reflects WHEN the underlying
  // complaints were published, not when CHISMOSO captured them.
  const pubMillis = candidateSignals
    .map((s) => {
      const obs = s.observedAt ? Date.parse(s.observedAt) : NaN;
      if (!Number.isNaN(obs)) return obs;
      const ts = Date.parse(s.timestamp);
      return Number.isNaN(ts) ? Date.now() : ts;
    })
    .sort((a, b) => a - b);
  const firstSeen = pubMillis.length > 0 ? new Date(pubMillis[0]).toISOString() : now;
  const lastSeen = pubMillis.length > 0 ? new Date(pubMillis[pubMillis.length - 1]).toISOString() : now;

  const problem: Problem = {
    id: generateId('prob'),
    description: describeProblem(canonical, candidateSignals, segmentsAffected, segmentUnknown),
    topic: input.topic,
    severity,
    frequency,
    confidence,
    evidence: evidence.slice(0, 20),
    signals: candidateSignals.slice(0, 20),
    segmentsAffected,
    firstSeen,
    lastSeen,
    observationCount: 1,
    createdAt: now,
  };

  logger.info('Problem detected', {
    topic: input.topic,
    severity,
    frequency,
    confidence,
    signals: candidateSignals.length,
  });

  return { problem, reasons };
}

function matchesFriction(text: string): boolean {
  const t = (text ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return FRICTION_PATTERNS.some((p) => p.test(t));
}

/**
 * Deduplica señales por contenido (primeros 100 chars del snippet).
 */
function dedupByContent(signals: Signal[]): Signal[] {
  const seen = new Set<string>();
  const out: Signal[] = [];
  for (const s of signals) {
    const key = s.rawSnippet.slice(0, 100).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function computeSeverity(signals: Signal[]): number {
  // severity: combinación de intensidad (cuántos patrones distintos) y volumen.
  const distinctPatterns = new Set<string>();
  for (const s of signals) {
    const t = (s.rawSnippet ?? '').toLowerCase();
    for (const p of FRICTION_PATTERNS) {
      const m = t.match(p);
      if (m) distinctPatterns.add(m[0]);
    }
  }
  const intensity = Math.min(1, distinctPatterns.size / 6);
  const volume = Math.min(1, signals.length / 8);
  return Math.round((0.6 * intensity + 0.4 * volume) * 100);
}

function computeFrequency(signals: Signal[]): number {
  // frequency: cuán a menudo aparece el problema en el set observado.
  return Math.min(100, Math.round((signals.length / 20) * 100));
}

/**
 * FASE-3-QUALITY §3.5 — concrete problem description.
 *
 * Structure:
 *   WHO: <segment> (or "segmento desconocido" when none inferred)
 *   WHAT: <pain phrase extracted from snippets>
 *   Quote: "<excerpt from top evidence signal>"
 *
 * The pain phrase is derived by extracting the most informative sentence
 * from the top evidence signal — i.e. the longest signal whose snippet
 * matches a friction pattern. We no longer use the template
 * `Recurring friction observed around "X"` because it carries zero
 * actionable information.
 *
 * The `segmentUnknown` flag is set when no segment could be inferred
 * from the evidence — in that case the description explicitly says so,
 * which propagates the uncertainty downstream rather than hiding it.
 */
function describeProblem(
  canonical: string,
  signals: Signal[],
  segmentsAffected: string[],
  segmentUnknown: boolean,
): string {
  // Pick the top evidence signal: longest snippet among friction matches.
  const topSignal = signals
    .slice()
    .sort((a, b) => (b.rawSnippet?.length ?? 0) - (a.rawSnippet?.length ?? 0))[0];
  const snippet = topSignal?.rawSnippet ?? '';
  const quote = excerpt(snippet, 180);

  // WHAT: derive a short pain phrase from the snippet. We try to extract
  // the clause that contains the friction keyword (e.g. "I lost two
  // reservations last week" rather than the whole 300-char sentence).
  const painPhrase = extractPainPhrase(snippet) ?? `fricción recurrente en ${canonical}`;

  // WHO: segment label (Spanish, since CHISMOSO targets Spanish-speaking
  // LATAM operators primarily).
  const whoLabel = segmentUnknown
    ? 'segmento desconocido'
    : segmentsAffected.slice(0, 3).map(humanizeSegment).join(', ');

  return [
    `QUIÉN: ${whoLabel}.`,
    `QUÉ: ${painPhrase}.`,
    `Evidencia: "${quote}"`,
  ].join(' ');
}

/**
 * Extract a short pain phrase from a snippet by finding the clause that
 * contains the first friction-pattern match. Falls back to the first
 * ~120 chars of the snippet when no pattern is found.
 */
function extractPainPhrase(snippet: string): string | undefined {
  if (!snippet) return undefined;
  const t = snippet.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Find the first friction pattern match and grab the surrounding clause
  // (a window of ~80 chars centered on the match, clamped to the snippet).
  for (const p of FRICTION_PATTERNS) {
    const m = t.match(p);
    if (m && m.index !== undefined) {
      const start = Math.max(0, m.index - 30);
      const end = Math.min(snippet.length, m.index + m[0].length + 80);
      const clause = snippet.slice(start, end).trim();
      // Trim to the first sentence-ish boundary.
      const sentenceEnd = clause.search(/[.!?]/);
      const phrase = sentenceEnd > 0 ? clause.slice(0, sentenceEnd).trim() : clause;
      return phrase.length > 0 ? phrase : undefined;
    }
  }
  // No friction pattern matched — use the first ~120 chars as the phrase.
  return snippet.slice(0, 120).trim() || undefined;
}

function excerpt(snippet: string, max: number): string {
  if (!snippet) return '';
  const trimmed = snippet.trim();
  if (trimmed.length <= max) return trimmed;
  // Try to break on a word boundary near `max`.
  const slice = trimmed.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > max * 0.6 ? lastSpace : max;
  return trimmed.slice(0, cut).trim() + '…';
}

/**
 * Convert a raw segment token like "small_business" or "pyme" into a
 * human-readable Spanish label for the problem description.
 */
function humanizeSegment(s: string): string {
  const norm = s.toLowerCase().trim();
  const MAP: Record<string, string> = {
    small_business: 'pequeñas empresas',
    restaurant: 'restaurantes',
    restaurante: 'restaurantes',
    retail: 'comercios minoristas',
    startup: 'startups',
    freelancer: 'freelancers',
    pyme: 'PYMEs',
    comercio: 'comercios',
    empresa: 'empresas',
    tienda: 'tiendas',
    cafeteria: 'cafeterías',
  };
  return MAP[norm] ?? norm;
}

function inferSegments(signals: Signal[]): string[] {
  // Heurística simple: extrae sustantivos largos de los snippets.
  const segments = new Set<string>();
  for (const s of signals) {
    const matches = (s.rawSnippet ?? '').match(/\b(small business|restaurant|retail|startup|freelancer|pyme|restaurante|comercio|empresa|tienda|cafeteria)\b/gi);
    if (matches) for (const m of matches) segments.add(m.toLowerCase());
  }
  return Array.from(segments).slice(0, 5);
}
