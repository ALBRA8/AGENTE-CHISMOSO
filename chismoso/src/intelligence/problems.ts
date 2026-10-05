/**
 * CHISMOSO V1.0 — Problem Detection (sección 19)
 *
 * Detecta problemas emergentes a partir de señales tipo:
 *   complaints, questions, frustraciones, trabajo manual, alta fricción,
 *   sentimiento negativo, requests repetidos.
 *
 * Regla crítica: sentimiento negativo ≠ automáticamente problema de negocio.
 * Debe existir evidencia de repetición, relevancia o intensidad.
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
  const confidence = Math.min(
    0.9,
    0.3 + candidateSignals.length * 0.07 + distinctSnippets.size * 0.05,
  );

  const now = nowISO();
  const timestamps = signals.map((s) => s.timestamp).sort();

  const problem: Problem = {
    id: generateId('prob'),
    description: describeProblem(canonical, candidateSignals),
    topic: input.topic,
    severity,
    frequency,
    confidence,
    evidence: evidence.slice(0, 20),
    signals: candidateSignals.slice(0, 20),
    segmentsAffected: input.segmentsAffected ?? inferSegments(candidateSignals),
    firstSeen: timestamps[0] ?? now,
    lastSeen: timestamps[timestamps.length - 1] ?? now,
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

function describeProblem(canonical: string, signals: Signal[]): string {
  // Toma el snippet más representativo (el más largo entre los de fricción).
  const snippet = signals
    .slice()
    .sort((a, b) => (b.rawSnippet?.length ?? 0) - (a.rawSnippet?.length ?? 0))[0]?.rawSnippet ?? '';
  const excerpt = snippet.slice(0, 200).trim();
  return `Recurring friction observed around "${canonical}". Representative signal: "${excerpt}..."`;
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
