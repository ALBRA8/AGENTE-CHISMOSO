/**
 * CHISMOSO V1.0 — FICHA Builder (Task IMP-CLONA-1)
 *
 * Converts a CHISMOSO Opportunity into a FichaSpec — a ClonaKit-style
 * structured specification that describes WHAT to build, not HOW.
 *
 * Two-stage strategy:
 *   1. LLM stage — ask the LLM to produce a 3-5 function MVP, 1-3 screens,
 *      target audience and data summary in the user's own words. The LLM
 *      only fills "soft" fields; the traceability/evidence block and the
 *      truth_level are ALWAYS computed deterministically from the input
 *      (never trusted to the LLM).
 *   2. Deterministic fallback — if the LLM call fails, returns invalid
 *      JSON, or the JSON does not validate, we synthesise a minimal but
 *      still-valid FichaSpec from the Opportunity fields alone. The
 *      fallback is intentionally generic (it cannot guess what features
 *      the actual product needs), but it satisfies the structural
 *      contract so the rest of the pipeline (renderer, API, MCP) keeps
 *      working in degraded mode.
 *
 * The clean-room rule (ClonaKit §"Checklist de sala limpia") is enforced
 * by the system prompt: DO NOT include code, DO NOT copy from the
 * original product, DO NOT include screenshots/icons/texts. The LLM
 * only sees the Opportunity text — it never sees the source product.
 */

import type { Opportunity, Evidence, Trend, Problem } from '../models.js';
import { nowISO } from '../models.js';
import { logger } from '../logger.js';
import type { LLMClient, ChatMessage } from '../orchestrator/llm.js';
import type { FichaSpec, FichaFunction, FichaScreen } from './models.js';

// ---------------------------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------------------------

export interface BuildFichaInput {
  opportunity: Opportunity;
  trend?: Trend;
  problem?: Problem;
  evidence: Evidence[];
  investigationId: string;
}

/**
 * Build a FichaSpec from a CHISMOSO Opportunity.
 *
 * @param input the opportunity + its supporting trend/problem/evidence
 * @param llm   optional LLM client; when provided, used for the soft
 *               fields (title/one_liner/functions/screens/data/for_later).
 *               When omitted or when the call fails, the deterministic
 *               fallback synthesises a minimal valid FichaSpec.
 */
export async function buildFicha(
  input: BuildFichaInput,
  llm?: LLMClient,
): Promise<FichaSpec> {
  const evidenceBlock = buildEvidenceBlock(input);

  // Try the LLM stage first. Any failure (no client, network, JSON parse,
  // validation) drops us into the deterministic fallback. The fallback is
  // ALWAYS correct on shape — we never return a half-built FichaSpec.
  if (llm) {
    try {
      const llmPartial = await callLLM(input, llm);
      if (llmPartial) {
        const merged: FichaSpec = {
          id: `ficha_${input.opportunity.id}`,
          title: llmPartial.title ?? input.opportunity.title,
          one_liner: llmPartial.one_liner ?? deriveOneLiner(input),
          inspired_by: llmPartial.inspired_by,
          target_audience: llmPartial.target_audience ?? input.opportunity.targetSegment,
          problem_it_solves: llmPartial.problem_it_solves ?? input.opportunity.problem,
          mvp_functions: llmPartial.mvp_functions,
          screens: llmPartial.screens,
          data: llmPartial.data,
          for_later: llmPartial.for_later,
          evidence: evidenceBlock,
          truth_level: 'DERIVED',
          generated_at: nowISO(),
          confidence: input.opportunity.confidence,
          limitations: deriveLimitations(input),
        };
        logger.info('FICHA built from LLM', {
          opportunityId: input.opportunity.id,
          functions: merged.mvp_functions.length,
          screens: merged.screens.length,
        });
        return merged;
      }
    } catch (e: any) {
      logger.warn('FICHA LLM stage failed — using deterministic fallback', {
        opportunityId: input.opportunity.id,
        err: e?.message ?? String(e),
      });
    }
  }

  return deterministicFallback(input, evidenceBlock);
}

// ---------------------------------------------------------------------------
// LLM STAGE
// ---------------------------------------------------------------------------

const FICHA_SYSTEM_PROMPT = `You are CHISMOSO's FICHA builder. Given an Opportunity with evidence, produce a FichaSpec JSON with 3-5 MVP functions, 1-3 screens, target audience, and what data the product would store.

Hard rules:
- DO NOT include code, pseudocode, or library names from the original product.
- DO NOT copy text, screenshots, icons, logos, sounds, or images from any existing product. We do not have access to the original product and do not want it.
- Use the user's own words from the opportunity description.
- Each MVP function must have a short name, a description ("what it does, in the user's words"), and a "web_equivalent" (the closest standard web building block, e.g. "WhatsApp Business API + calendar widget" — not code).
- Each screen must have a name, "what_you_see" (zones of the screen as a string array), and "what_you_can_do" (actions as a string array).
- The "data" block must say what the product stores (string array), where (e.g. "browser (localStorage)" or "server (Postgres)"), and what personal data it handles (e.g. "none" or "emails and names of customers (RGPD)").
- "for_later" is a string array of out-of-MVP features that should be built in a later version.

Respond with valid JSON ONLY. No markdown fences, no comments, no text outside the JSON object.

The JSON shape:
{
  "title": "string — short product name (not the same as the opportunity title)",
  "one_liner": "string — Una frase: qué es y qué problema resuelve, p. ej. 'Una web para...'",
  "inspired_by": "string (optional) — e.g. 'Inspirada en WhatsApp Business'",
  "target_audience": "string — quién la va a usar y en qué momento",
  "problem_it_solves": "string — el problema que resuelve",
  "mvp_functions": [
    { "name": "string", "description": "string", "web_equivalent": "string" }
  ],
  "screens": [
    { "name": "string", "what_you_see": ["string"], "what_you_can_do": ["string"] }
  ],
  "data": {
    "what_it_stores": ["string"],
    "where": "string",
    "personal_data": "string"
  },
  "for_later": ["string"]
}`;

interface LLMPartialFicha {
  title?: string;
  one_liner?: string;
  inspired_by?: string;
  target_audience?: string;
  problem_it_solves?: string;
  mvp_functions: FichaFunction[];
  screens: FichaScreen[];
  data: {
    what_it_stores: string[];
    where: string;
    personal_data: string;
  };
  for_later: string[];
}

async function callLLM(
  input: BuildFichaInput,
  llm: LLMClient,
): Promise<LLMPartialFicha | null> {
  const userPrompt = buildUserPrompt(input);
  const messages: ChatMessage[] = [
    { role: 'system', content: FICHA_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];
  const resp = await llm.chat(messages);
  const parsed = parseAndValidate(resp.content);
  return parsed;
}

function buildUserPrompt(input: BuildFichaInput): string {
  const { opportunity, trend, problem, evidence } = input;
  const topEvidence = evidence.slice(0, 5);
  const evidenceList = topEvidence.length > 0
    ? topEvidence.map((e, i) =>
        `  [${i + 1}] source="${e.source}" topic="${e.topic}"\n      fact: ${e.extractedFact ?? e.rawValue.slice(0, 200)}`,
      ).join('\n')
    : '  (none)';
  return `OPPORTUNITY:
  id: ${opportunity.id}
  title: ${opportunity.title}
  description: ${opportunity.description}
  problem: ${opportunity.problem}
  target segment: ${opportunity.targetSegment}
  geography: ${opportunity.geography}
  score: ${opportunity.score}/100 (confidence ${Math.round(opportunity.confidence * 100)}%)

TREND (if any):
${trend ? `  topic: ${trend.topic}\n  state: ${trend.state}\n  description: ${trend.description}` : '  (no explicit trend)'}

PROBLEM (if any):
${problem ? `  description: ${problem.description}\n  severity: ${problem.severity}/100\n  frequency: ${problem.frequency}/100\n  segments: ${problem.segmentsAffected.join(', ') || 'unspecified'}` : '  (no explicit problem)'}

TOP EVIDENCE (max 5):
${evidenceList}

Now produce the FichaSpec JSON. Remember: respond with JSON ONLY.`;
}

/**
 * Parse + validate the LLM's JSON response. Returns null on any failure
 * (parse error, missing required field, wrong array length, etc.). The
 * caller will then fall back to the deterministic synthesiser.
 *
 * We deliberately do NOT try to repair malformed LLM output — the
 * deterministic fallback produces a structurally-valid FichaSpec anyway,
 * and we'd rather drop the LLM contribution entirely than ship a
 * half-broken one.
 */
function parseAndValidate(content: string): LLMPartialFicha | null {
  const jsonStr = extractJson(content);
  if (!jsonStr) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(jsonStr);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;

  const mvp_functions = validateFunctions(o.mvp_functions);
  if (!mvp_functions) return null;

  const screens = validateScreens(o.screens);
  if (!screens) return null;

  const data = validateData(o.data);
  if (!data) return null;

  const for_later = validateStringArray(o.for_later);
  if (!for_later) return null;

  return {
    title: typeof o.title === 'string' && o.title.trim() ? o.title.trim() : undefined,
    one_liner: typeof o.one_liner === 'string' && o.one_liner.trim() ? o.one_liner.trim() : undefined,
    inspired_by: typeof o.inspired_by === 'string' && o.inspired_by.trim() ? o.inspired_by.trim() : undefined,
    target_audience: typeof o.target_audience === 'string' && o.target_audience.trim() ? o.target_audience.trim() : undefined,
    problem_it_solves: typeof o.problem_it_solves === 'string' && o.problem_it_solves.trim() ? o.problem_it_solves.trim() : undefined,
    mvp_functions,
    screens,
    data,
    for_later,
  };
}

function extractJson(s: string): string | null {
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) return null;
  return s.slice(start, end + 1);
}

function validateFunctions(v: unknown): FichaFunction[] | null {
  if (!Array.isArray(v)) return null;
  if (v.length < 3 || v.length > 5) return null;
  const out: FichaFunction[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') return null;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    const description = typeof o.description === 'string' ? o.description.trim() : '';
    const web_equivalent = typeof o.web_equivalent === 'string' ? o.web_equivalent.trim() : '';
    if (!name || !description || !web_equivalent) return null;
    out.push({ name, description, web_equivalent });
  }
  return out;
}

function validateScreens(v: unknown): FichaScreen[] | null {
  if (!Array.isArray(v)) return null;
  if (v.length < 1 || v.length > 3) return null;
  const out: FichaScreen[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') return null;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    const what_you_see = validateStringArray(o.what_you_see);
    const what_you_can_do = validateStringArray(o.what_you_can_do);
    if (!name || !what_you_see || !what_you_can_do) return null;
    out.push({ name, what_you_see, what_you_can_do });
  }
  return out;
}

function validateData(v: unknown): LLMPartialFicha['data'] | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const what_it_stores = validateStringArray(o.what_it_stores);
  const where = typeof o.where === 'string' ? o.where.trim() : '';
  const personal_data = typeof o.personal_data === 'string' ? o.personal_data.trim() : '';
  if (!what_it_stores || !where || !personal_data) return null;
  return { what_it_stores, where, personal_data };
}

function validateStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  if (v.length === 0) return null;
  const out: string[] = [];
  for (const s of v) {
    if (typeof s !== 'string') return null;
    const trimmed = s.trim();
    if (!trimmed) return null;
    out.push(trimmed);
  }
  return out;
}

// ---------------------------------------------------------------------------
// DETERMINISTIC FALLBACK
// ---------------------------------------------------------------------------

/**
 * Synthesise a minimal but structurally-valid FichaSpec from the
 * Opportunity fields alone. Used when the LLM is unavailable or returns
 * invalid JSON.
 *
 * The fallback is intentionally generic: it cannot guess what specific
 * features the actual product needs, so it produces 3 generic but
 * defensible MVP functions (Discovery / Direct request / Dashboard), one
 * main screen, and a `for_later` list derived from competition/uncertainty.
 *
 * The output STILL carries the full evidence block (opportunity_id,
 * investigation_id, signal_count, top_evidence_urls) so a downstream
 * builder agent can walk back to the source signals even in degraded
 * mode. The `truth_level` is STILL 'DERIVED'.
 */
function deterministicFallback(
  input: BuildFichaInput,
  evidenceBlock: FichaSpec['evidence'],
): FichaSpec {
  const { opportunity } = input;
  const ficha: FichaSpec = {
    id: `ficha_${opportunity.id}`,
    title: opportunity.title,
    one_liner: deriveOneLiner(input),
    target_audience: opportunity.targetSegment || 'unspecified segment',
    problem_it_solves: opportunity.problem || '(no explicit problem detected)',
    mvp_functions: deriveFallbackFunctions(input),
    screens: deriveFallbackScreens(input),
    data: deriveFallbackData(input),
    for_later: deriveFallbackForLater(input),
    evidence: evidenceBlock,
    truth_level: 'DERIVED',
    generated_at: nowISO(),
    confidence: opportunity.confidence,
    limitations: deriveLimitations(input),
  };
  logger.info('FICHA built from deterministic fallback', {
    opportunityId: opportunity.id,
    functions: ficha.mvp_functions.length,
    screens: ficha.screens.length,
  });
  return ficha;
}

function deriveOneLiner(input: BuildFichaInput): string {
  const { opportunity, trend } = input;
  // If the opportunity description is already a sentence, use it.
  if (opportunity.description && opportunity.description.length > 0) {
    return opportunity.description;
  }
  if (trend) {
    return `Una web para resolver la oportunidad en torno a "${trend.topic}".`;
  }
  return `Una web para resolver: ${opportunity.problem || opportunity.title}.`;
}

/**
 * Three generic but defensible MVP functions. The "web_equivalent" hints
 * are intentionally vague so a builder agent treats them as a starting
 * point, not a finished architecture.
 */
function deriveFallbackFunctions(input: BuildFichaInput): FichaFunction[] {
  const { opportunity } = input;
  const segment = opportunity.targetSegment || 'el segmento afectado';
  return [
    {
      name: 'Descubrir',
      description:
        `Permitir a ${segment} encontrar y explorar lo que necesita en relación a: ` +
        `${truncateForFicha(opportunity.problem || opportunity.title, 160)}.`,
      web_equivalent: 'Lista filtrable + buscador en cliente (HTML semántico + JavaScript)',
    },
    {
      name: 'Solicitar o actuar',
      description:
        'Permitir al usuario realizar la acción principal (pedir, reservar, contactar o registrar) ' +
        'con el mínimo de pasos posible y sin depender de terceros externos.',
      web_equivalent: 'Formulario web estándar con validación en cliente + envío asíncrono',
    },
    {
      name: 'Seguimiento',
      description:
        'Mostrar al usuario el estado de lo que ha solicitado o registrado, con fechas y estado legible.',
      web_equivalent: 'Tabla o lista de registros persistida en navegador o servidor',
    },
  ];
}

function deriveFallbackScreens(input: BuildFichaInput): FichaScreen[] {
  const { opportunity } = input;
  return [
    {
      name: 'Pantalla principal',
      what_you_see: [
        'Una cabecera con el nombre del producto y una sola frase que diga qué resuelve.',
        `Una zona central que muestre la acción principal relacionada con: ${truncateForFicha(opportunity.problem || opportunity.title, 120)}.`,
        'Un pie con la mención "datos solo en este navegador" o equivalente, según el modelo de datos.',
      ],
      what_you_can_do: [
        'Iniciar la acción principal con un botón primario.',
        'Ver el historial de acciones anteriores en una lista.',
        'Acceder a la configuración básica del producto.',
      ],
    },
  ];
}

function deriveFallbackData(input: BuildFichaInput): FichaSpec['data'] {
  const { opportunity, evidence } = input;
  // Heuristic: if the opportunity has any email-like signal, assume personal data.
  const text = (evidence.map((e) => e.rawValue).join(' ') + ' ' + opportunity.problem).toLowerCase();
  const hasEmail = /\b(email|correo|e-mail|@|name|nombre|phone|teléfono)\b/.test(text);
  const hasReservation = /\b(reserva|booking|cita|appointment|pedido|order)\b/.test(text);

  const whatItStores: string[] = [];
  if (hasReservation) whatItStores.push('las solicitudes o reservas realizadas');
  whatItStores.push('las preferencias del usuario');
  if (hasEmail) whatItStores.push('los datos de contacto del usuario');

  return {
    what_it_stores: whatItStores.length > 0 ? whatItStores : ['la configuración y el historial de acciones'],
    where: 'navegador (localStorage) — sin servidor en la primera versión',
    personal_data: hasEmail
      ? 'sí: correos y nombres de los usuarios (manejar con RGPD en cuenta)'
      : 'ninguno en la primera versión',
  };
}

function deriveFallbackForLater(input: BuildFichaInput): string[] {
  const { opportunity } = input;
  const out: string[] = [];
  if (opportunity.competition >= 60) {
    out.push('Integración con servicios externos para diferenciarse de la competencia existente.');
  }
  if (opportunity.uncertainty >= 60) {
    out.push('Validación con usuarios reales antes de añadir más funciones.');
  }
  if (opportunity.monetization >= 60) {
    out.push('Capa de pagos y planes de suscripción.');
  }
  out.push('Sincronización entre dispositivos (requiere backend).');
  return out;
}

/**
 * Surface the Opportunity's uncertainty / competition / staleness as
 * explicit limitations the renderer prints in the "Veracidad y
 * limitaciones" section. These mirror what the IntelligenceReport
 * already says — we keep the FICHA self-contained so the builder agent
 * does not need to read both documents.
 */
function deriveLimitations(input: BuildFichaInput): string[] {
  const { opportunity, evidence } = input;
  const out: string[] = [];
  if (opportunity.uncertainty >= 60) {
    out.push(
      `Incertidumbre alta (${opportunity.uncertainty}/100) — validar con usuarios reales antes de programar todas las funciones.`,
    );
  }
  if (opportunity.competition >= 60) {
    out.push(
      `Competencia detectada (${opportunity.competition}/100) — el producto debe diferenciarse claramente.`,
    );
  }
  const evidenceCount = opportunity.evidence.length || evidence.length;
  if (evidenceCount < 5) {
    out.push(
      `Base de evidencia limitada (${evidenceCount} señales) — la ficha es exploratoria, no definitiva.`,
    );
  }
  out.push(
    'Esta ficha es una síntesis de señales observadas; no incluye observaciones directas del producto original.',
  );
  return out;
}

// ---------------------------------------------------------------------------
// EVIDENCE BLOCK (always deterministic)
// ---------------------------------------------------------------------------

function buildEvidenceBlock(input: BuildFichaInput): FichaSpec['evidence'] {
  const { opportunity, trend, evidence, investigationId } = input;
  const urls = evidence
    .map((e) => e.url)
    .filter((u): u is string => typeof u === 'string' && u.length > 0)
    .slice(0, 5);
  return {
    opportunity_id: opportunity.id,
    investigation_id: investigationId,
    trend_topic: trend?.topic,
    signal_count: opportunity.evidence.length || evidence.length,
    top_evidence_urls: urls,
  };
}

// ---------------------------------------------------------------------------
// SMALL HELPERS
// ---------------------------------------------------------------------------

function truncateForFicha(s: string, n: number): string {
  if (!s) return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// Re-exported for tests so the deterministic synthesiser can be exercised
// directly without standing up an LLM mock.
export const __test__ = {
  deterministicFallback,
  deriveOneLiner,
  deriveFallbackFunctions,
  deriveFallbackScreens,
  deriveFallbackData,
  deriveFallbackForLater,
  deriveLimitations,
  buildEvidenceBlock,
  parseAndValidate,
  extractJson,
};
