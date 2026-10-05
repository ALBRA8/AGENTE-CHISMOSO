/**
 * CHISMOSO V1.0 — Signal Normalizer (sección 13)
 *
 * Convierte RawItem (output de providers) → Signal + Evidence.
 *
 * Esta es la capa que "limpia" la diferencia entre fuentes heterogéneas
 * y produce un modelo uniforme. La lógica es heurística y está documentada;
 * NO se presenta como científica.
 */

import type { RawItem } from '../providers/base.js';
import type { Evidence, Signal, SignalType, SourceType, TruthLevel } from '../models.js';
import { generateId, nowISO, SignalType as ST, TruthLevel as TL } from '../models.js';

// ---------------------------------------------------------------------------
// DETECCIÓN DE TIPO DE SEÑAL (heurística documentada)
// ---------------------------------------------------------------------------

/**
 * Heurística simple para inferir el tipo de señal a partir del texto.
 * No es perfecta: el LLM puede re-clasificar señales más adelante si
 * conviene. Aquí simplemente evitamos que TODAS las señales terminen
 * con el mismo tipo.
 */
export function inferSignalType(snippet: string, sourceType: SourceType): SignalType {
  const t = snippet.toLowerCase();
  if (sourceType === 'REDDIT_COMMUNITIES') {
    // EN + ES questions
    if (/\b(how do i|how to|does anyone|is there|can i|what's the best|which|recommend)\b/.test(t)) return ST.QUESTION_SPIKE;
    if (/\b(necesito|busco|me urge|alguien sabe|alguien recomienda|como hago|como puedo|alguna recomendacion|que recomiendan|ayuda con)\b/.test(t)) return ST.QUESTION_SPIKE;
    // EN + ES complaints
    if (/\b(frustrat|hate|annoying|terrible|broken|suck|complaint|problem|issue|bug|fails?|struggl)\b/.test(t)) return ST.COMPLAINT_SPIKE;
    if (/\b(problema|queja|frustrac|odio|mala experiencia|deficiente|ineficiente|inutil|caro|carisimo|no funciona|paso|perdido|perdi|fatal|horrible)\b/.test(t)) return ST.COMPLAINT_SPIKE;
    return ST.MENTION_SPIKE;
  }
  if (sourceType === 'WEB_CONTENT') {
    if (/\b(launch|launched|launches|announces?|announced|new release|new product|just shipped|just released)\b/.test(t)) return ST.NEW_PRODUCT;
    if (/\b(problem|friction|complaint|pain point|issue|struggle|problema|friccion|dolor|necesidad)\b/.test(t)) return ST.PROBLEM_SIGNAL;
    return ST.CONTENT_GROWTH;
  }
  if (sourceType === 'SEARCH_WEB') {
    if (/\b(demand|growing|surge|spike|trending|adoption|crecimiento|demanda|auge|tendencia|creciendo)\b/.test(t)) return ST.DEMAND_SIGNAL;
    if (/\b(new product|new service|launches?|nuevo producto|nuevo servicio)\b/.test(t)) return ST.NEW_PRODUCT;
    // problem indicators: explicit pain signals in articles/blogs
    if (/\b(problem|friction|pain point|issue|struggle|problema|friccion|dolor|perdida|perdi|explota|cruzan|se cayeron|perder reservas|perdi reservas|perdidas|perdido|queja|quejas|reclamo)\b/.test(t)) return ST.PROBLEM_SIGNAL;
    return ST.MENTION_SPIKE;
  }
  return ST.MENTION_SPIKE;
}

// ---------------------------------------------------------------------------
// NORMALIZACIÓN DE TEXTO
// ---------------------------------------------------------------------------

/**
 * Normaliza un texto para que sea comparable.
 * - lowercase
 * - quita acentos
 * - colapsa espacios
 * - quita puntuación extrema
 */
export function normalizeText(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tokeniza en keywords significativas (stop-words básicas en ES + EN).
 */
const STOPWORDS = new Set([
  // EN
  'the','a','an','of','to','in','on','for','and','or','with','is','are','be','by','that','this','it','as','at','from','you','your','i','we','our','they','them','he','she','his','her',
  // ES
  'el','la','los','las','un','una','unos','unas','de','del','al','a','en','para','por','con','y','o','que','se','su','sus','es','son','ser','como','mas','muy','cuando','donde','si','no',
]);

export function tokenize(s: string): string[] {
  const t = normalizeText(s);
  if (!t) return [];
  return t.split(' ').filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/**
 * Extrae un keyword representativo de un snippet (la palabra no-stopword
 * más frecuente en el snippet).
 */
export function extractKeyword(snippet: string, topicHint?: string): string {
  const tokens = tokenize(snippet);
  if (tokens.length === 0) return topicHint ?? 'unknown';
  const freq = new Map<string, number>();
  for (const w of tokens) freq.set(w, (freq.get(w) ?? 0) + 1);
  let best = tokens[0];
  let bestCount = 0;
  for (const [w, c] of freq.entries()) {
    if (c > bestCount || (c === bestCount && w.length > best.length)) {
      best = w;
      bestCount = c;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// SCORE DE CALIDAD DE EVIDENCIA
// ---------------------------------------------------------------------------

/**
 * Heurística simple para asignar confianza inicial a un raw item.
 * - más largo = mejor evidencia
 * - tiene URL = mejor
 * - tiene fecha = mejor
 * - sourceType conocido = mejor
 *
 * Devuelve un valor entre 0 y 1.
 */
export function rawConfidence(item: RawItem): number {
  let score = 0.4; // base
  if (item.url && /^https?:\/\//.test(item.url)) score += 0.15;
  if (item.title && item.title.length > 10) score += 0.1;
  if (item.snippet && item.snippet.length > 100) score += 0.15;
  else if (item.snippet && item.snippet.length > 50) score += 0.08;
  if (item.date && /\d{4}/.test(item.date)) score += 0.1;
  if (item.sourceType === 'REDDIT_COMMUNITIES') score += 0.05; // evidencia de usuario real
  if (item.sourceType === 'WEB_CONTENT') score += 0.05; // confirmación profunda
  return Math.min(0.95, score);
}

// ---------------------------------------------------------------------------
// NORMALIZACIÓN PRINCIPAL
// ---------------------------------------------------------------------------

export interface NormalizeContext {
  topic: string;
  geography: string;
  keywordHint?: string;
  investigationId?: string;
}

export interface NormalizedSignal {
  signal: Signal;
  evidence: Evidence;
}

export function normalizeRawItem(item: RawItem, ctx: NormalizeContext): NormalizedSignal {
  const ts = item.date || nowISO();
  const keyword = extractKeyword(item.snippet, ctx.keywordHint);
  const signalType = inferSignalType(item.snippet, item.sourceType);
  const conf = rawConfidence(item);

  const signal: Signal = {
    id: generateId('sig'),
    topic: ctx.topic,
    keyword,
    source: item.providerName,
    sourceType: item.sourceType,
    timestamp: ts,
    geography: ctx.geography,
    metric: 'mention_count',
    value: 1,
    normalizedValue: 1,
    direction: 'up',
    velocity: 0,
    confidence: conf,
    evidenceType: TruthLevelFor(item.sourceType),
    signalType,
    metadata: item.rawMetadata ?? {},
    rawSnippet: item.snippet,
    url: item.url,
  };

  const evidence: Evidence = {
    id: generateId('ev'),
    source: item.providerName,
    sourceType: item.sourceType,
    url: item.url,
    observedAt: ts,
    collectedAt: nowISO(),
    geographicScope: ctx.geography,
    topic: ctx.topic,
    rawValue: item.snippet,
    normalizedValue: normalizeText(item.snippet).slice(0, 500),
    confidence: conf,
    evidenceType: TruthLevelFor(item.sourceType),
    metadata: { title: item.title, host: item.hostName, ...((item.rawMetadata as object) ?? {}) },
  };

  return { signal, evidence };
}

function TruthLevelFor(st: SourceType): TruthLevel {
  // Las señales observadas en una fuente real son OBSERVED.
  // Las inferidas por el LLM (más adelante en el pipeline) serán INFERRED.
  return TL.OBSERVED;
}

// ---------------------------------------------------------------------------
// DEDUP
// ---------------------------------------------------------------------------

/**
 * Deduplica señales por (url|snippet-normalizado). Mantiene la primera
 * aparición y descarta duplicados. NO cruza con la base de datos histórica
 * — eso es responsabilidad de TopicRepository / SignalRepository al persistir.
 *
 * Esto evita que una misma URL recogida por dos providers cuente como dos
 * señales independientes para fines de cross-source confirmation.
 */
export function dedupSignals(signals: Signal[]): Signal[] {
  const seen = new Set<string>();
  const out: Signal[] = [];
  for (const s of signals) {
    const key = s.url
      ? `url:${s.url}`
      : `snip:${normalizeText(s.rawSnippet).slice(0, 200)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

export function dedupEvidence(evidence: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  const out: Evidence[] = [];
  for (const e of evidence) {
    const key = e.url
      ? `url:${e.url}`
      : `snip:${e.normalizedValue.slice(0, 200)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}
