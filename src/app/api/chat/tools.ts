/**
 * AGENT-1 — Chat tools registry.
 *
 * These are the tools the conversational agent (POST /api/chat) can call.
 * They are distinct from the chismoso orchestrator's tools
 * (chismoso/src/orchestrator/tools.ts — search_web, search_community,
 * collect_trends, deepen_content) which are used INSIDE an investigation.
 *
 * The chat tools are higher-level: they read the dashboard's existing
 * API surface and return concise summaries the LLM can weave into its
 * telegram-style replies.
 *
 * Each tool:
 *   - Takes typed args + the active ChatSession (so it can mutate state
 *     if needed, e.g. record seen anomalies).
 *   - Fetches the dashboard's internal API at http://127.0.0.1:3000 (we
 *     are already inside the Next.js server, so we hit loopback directly
 *     — no DNS, no proxy, no Caddy).
 *   - Returns a string (NOT an object). The LLM consumes the string
 *     directly as a `tool` message. Strings are easier for the LLM to
 *     reason about than nested JSON, and they keep token count down.
 *
 * The schemas are JSON-Schema-flavored objects — included for the
 * `tool_call` SSE event payload and for future migration to native
 * tool-calling once the ZAI SDK supports `tools:` param.
 */

import type { ChatSession } from '@/lib/chat-session';

// ---------------------------------------------------------------------------
// Internal fetch helper
// ---------------------------------------------------------------------------

/**
 * Internal base URL for hitting the dashboard's own API.
 *
 * We use 127.0.0.1 (not localhost) to skip DNS resolution. Port 3000
 * is the only port the Next.js dev server binds.
 */
const INTERNAL_BASE = 'http://127.0.0.1:3000';

async function fetchJSON(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: any }> {
  try {
    const r = await fetch(`${INTERNAL_BASE}${path}`, init);
    const data = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      data: { error: 'fetch_failed', message: e instanceof Error ? e.message : String(e) },
    };
  }
}

// ---------------------------------------------------------------------------
// Tool interface
// ---------------------------------------------------------------------------

export interface ChatTool {
  name: string;
  description: string;
  /** JSON-Schema-flavored. Used in the `tool_call` SSE event payload. */
  schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
  /** Returns a concise string summary the LLM can reason about. */
  execute: (args: any, session: ChatSession) => Promise<string>;
}

// ---------------------------------------------------------------------------
// TOOL: list_investigations
// ---------------------------------------------------------------------------

const listInvestigationsTool: ChatTool = {
  name: 'list_investigations',
  description:
    'Lista las investigaciones previas guardadas (con IDs y conteos). Útil cuando el usuario pregunta "qué investigaste" o "qué hay guardado".',
  schema: { type: 'object', properties: {}, required: [] },
  async execute(_args, _session) {
    const { ok, data } = await fetchJSON('/api/investigations');
    if (!ok) return `Error al listar investigaciones: ${data?.error ?? 'desconocido'}.`;
    const invs: any[] = data?.investigations ?? [];
    if (invs.length === 0) return 'Sin investigaciones previas guardadas.';
    const lines = invs.slice(0, 8).map((i: any, idx: number) => {
      const id = i.id ?? 'sin_id';
      const sig = i.signalsFound ?? 0;
      const trend = i.trendsFound ?? 0;
      const opp = i.opportunitiesFound ?? 0;
      const q = (i.query ?? '').toString().slice(0, 60);
      return `[${idx + 1}] ${id} — ${sig}sig/${trend}trend/${opp}opp — "${q}"`;
    });
    const total = invs.length > 8 ? `\n...y ${invs.length - 8} más.` : '';
    return `Investigaciones (${invs.length}):\n${lines.join('\n')}${total}`;
  },
};

// ---------------------------------------------------------------------------
// TOOL: load_investigation
// ---------------------------------------------------------------------------

const loadInvestigationTool: ChatTool = {
  name: 'load_investigation',
  description:
    'Carga el reporte completo de una investigación por su ID. Útil cuando el usuario pregunta por una investigación específica o quiere profundizar una oportunidad de una investigación previa.',
  schema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'ID de la investigación (ej. inv_abc123)' } },
    required: ['id'],
  },
  async execute(args, _session) {
    const id = String(args?.id ?? '').trim();
    if (!id) return 'Falta el parámetro `id` de la investigación.';
    // Defensive: only allow word chars + dash. The /api/investigations/[id]
    // route already validates with the same regex, but we short-circuit
    // here to avoid an obviously-bad request.
    if (!/^[\w-]+$/.test(id)) return `ID inválido: ${id}`;
    const { ok, data } = await fetchJSON(`/api/investigations/${encodeURIComponent(id)}`);
    if (!ok) return `Investigación ${id} no encontrada.`;
    const m = data?.machine;
    if (!m) return `Investigación ${id} cargada pero sin datos estructurados.`;
    const topOpps = (m.opportunities ?? []).slice(0, 3).map((o: any) => ({
      title: o.title,
      score: o.score,
      confidence: o.confidence,
    }));
    const topTrends = (m.trends ?? []).slice(0, 3).map((t: any) => ({
      topic: t.topic,
      state: t.state,
      score: t.score,
    }));
    const summary = {
      id,
      query: m.query,
      status: m.status,
      confidence: m.overallConfidence,
      counts: {
        signals: m.signals?.length ?? 0,
        trends: m.trends?.length ?? 0,
        problems: m.problems?.length ?? 0,
        opportunities: m.opportunities?.length ?? 0,
      },
      topOpportunities: topOpps,
      topTrends: topTrends,
      recommendedNextAction: m.recommendedNextAction,
    };
    return JSON.stringify(summary);
  },
};

// ---------------------------------------------------------------------------
// TOOL: start_investigation
// ---------------------------------------------------------------------------

const startInvestigationTool: ChatTool = {
  name: 'start_investigation',
  description:
    'Inicia una nueva investigación CHISMOSO completa. Útil cuando el usuario pide "investiga X" o "busca oportunidades en Y". Devuelve el investigationId y un resumen cuando termina. NOTA: puede tardar 30-120 segundos.',
  schema: {
    type: 'object',
    properties: {
      objective: { type: 'string', description: 'Objetivo de la investigación, en lenguaje natural' },
      geography: { type: 'string', description: 'Geografía (ej. Colombia, Mexico, global). Default: Colombia.' },
    },
    required: ['objective'],
  },
  async execute(args, _session) {
    const objective = String(args?.objective ?? '').trim();
    if (!objective) return 'Falta el parámetro `objective`.';
    const geography = String(args?.geography ?? 'Colombia').trim();
    const { ok, status, data } = await fetchJSON('/api/investigate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        objective,
        geography,
        maxQueries: 4,
        maxRuntimeMs: 120000,
      }),
    });
    if (!ok) {
      return `Error al iniciar investigación (HTTP ${status}): ${data?.error ?? 'desconocido'}`;
    }
    const invId = data?.investigationId ?? 'unknown';
    const invStatus = data?.status ?? 'UNKNOWN';
    const inv = data?.report?.machine;
    if (!inv) {
      return `Investigación ${invId} — ${invStatus} (sin reporte estructurado disponible).`;
    }
    const sigCount = inv.signals?.length ?? 0;
    const trendCount = inv.trends?.length ?? 0;
    const oppCount = inv.opportunities?.length ?? 0;
    const conf = Math.round((inv.overallConfidence ?? 0) * 100);
    const topOpps = (inv.opportunities ?? []).slice(0, 3).map((o: any) => {
      const score = Math.round(o.score ?? 0);
      const title = String(o.title ?? '').slice(0, 80);
      return `#${score} ${title}`;
    });
    const lines = [
      `Investigación ${invId} — ${invStatus}`,
      `${sigCount} señales · ${trendCount} trends · ${oppCount} oportunidades`,
      `Confianza global: ${conf}%`,
    ];
    if (topOpps.length > 0) {
      lines.push('Top oportunidades:');
      lines.push(...topOpps);
    }
    return lines.join('\n');
  },
};

// ---------------------------------------------------------------------------
// TOOL: semantic_search
// ---------------------------------------------------------------------------

const semanticSearchTool: ChatTool = {
  name: 'semantic_search',
  description:
    'Búsqueda semántica sobre señales acumuladas en la base de datos. Útil cuando el usuario pregunta "qué hay de X" o "qué sabes de Y". Devuelve los fragmentos más similares con su score.',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Consulta en lenguaje natural (ES o EN).' },
      topK: { type: 'number', description: 'Cantidad de resultados (1..50, default 5).' },
    },
    required: ['query'],
  },
  async execute(args, _session) {
    const query = String(args?.query ?? '').trim();
    if (!query) return 'Falta el parámetro `query`.';
    const topK = Number.isFinite(args?.topK) && args.topK > 0 ? Math.min(50, Math.floor(args.topK)) : 5;
    const { ok, data } = await fetchJSON('/api/semantic-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, topK }),
    });
    if (!ok) return `Error en búsqueda semántica: ${data?.error ?? 'desconocido'}.`;
    const results: any[] = data?.results ?? [];
    if (results.length === 0) {
      return `Sin señales que coincidan con "${query}". Prueba con otra formulación o ejecuta una investigación nueva con start_investigation.`;
    }
    const lines = results.map((r: any, i: number) => {
      const score = Math.round((r.score ?? 0) * 100);
      const snippet = String(r.snippet ?? '').slice(0, 100);
      const url = r.url ? ` (${String(r.url).slice(0, 60)})` : '';
      return `[${i + 1}] ${score}% — ${snippet}${url}`;
    });
    return `Resultados para "${query}" (${results.length}):\n${lines.join('\n')}`;
  },
};

// ---------------------------------------------------------------------------
// TOOL: list_anomalies
// ---------------------------------------------------------------------------

const listAnomaliesTool: ChatTool = {
  name: 'list_anomalies',
  description:
    'Lista anomalías detectadas actualmente (volume_spike, volume_drop, velocity_change, source_diversification, confidence_drift). Útil cuando el usuario pregunta "qué anomalías hay" o "algo raro pasando".',
  schema: { type: 'object', properties: {}, required: [] },
  async execute(_args, session) {
    const { ok, data } = await fetchJSON('/api/anomalies');
    if (!ok) return `Error al consultar anomalías: ${data?.error ?? 'desconocido'}.`;
    const anoms: any[] = data?.anomalies ?? [];
    // Record seen anomaly IDs so /api/chat/poll can diff later. We update
    // the set here too (not just in /poll) so that if the agent itself
    // surfaced anomalies via this tool, /poll won't re-notify about them.
    for (const a of anoms) {
      if (a?.id) session.lastSeenAnomalyIds.add(String(a.id));
    }
    if (anoms.length === 0) return 'Sin anomalías activas. Todo estable.';
    const lines = anoms.slice(0, 5).map((a: any) => {
      const sev = String(a.severity ?? '?').toUpperCase();
      const type = a.type ?? 'unknown';
      const topic = a.topic ?? '?';
      const z = Number(a.zscore ?? 0).toFixed(2);
      const desc = String(a.description ?? '').slice(0, 100);
      return `[${sev}] ${type} en "${topic}" — z=${z} — ${desc}`;
    });
    const extra = anoms.length > 5 ? `\n...y ${anoms.length - 5} más.` : '';
    return `Anomalías activas (${anoms.length}):\n${lines.join('\n')}${extra}`;
  },
};

// ---------------------------------------------------------------------------
// TOOL: list_topics
// ---------------------------------------------------------------------------

const listTopicsTool: ChatTool = {
  name: 'list_topics',
  description:
    'Lista topics en observación (con historial de observaciones). Útil cuando el usuario pregunta "qué vigilas" o "qué topics hay".',
  schema: { type: 'object', properties: {}, required: [] },
  async execute(_args, _session) {
    const { ok, data } = await fetchJSON('/api/topics');
    if (!ok) return `Error al consultar topics: ${data?.error ?? 'desconocido'}.`;
    const topics: any[] = data?.topics ?? [];
    if (topics.length === 0) {
      return 'Sin topics en observación aún. Ejecuta una investigación primero con start_investigation.';
    }
    const lines = topics.slice(0, 8).map((t: any) => {
      const canonical = t.canonical ?? '?';
      const obs = t.observationCount ?? 0;
      const conf = Math.round((t.latestConfidence ?? 0) * 100);
      const last = t.lastSeen ?? '?';
      return `${canonical} — ${obs} obs · confianza ${conf}% · último ${last}`;
    });
    const extra = topics.length > 8 ? `\n...y ${topics.length - 8} más.` : '';
    return `Topics en observación (${topics.length}):\n${lines.join('\n')}${extra}`;
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const CHAT_TOOLS: ChatTool[] = [
  listInvestigationsTool,
  loadInvestigationTool,
  startInvestigationTool,
  semanticSearchTool,
  listAnomaliesTool,
  listTopicsTool,
];

/** Lookup by name. Returns undefined if not found. */
export function getChatTool(name: string): ChatTool | undefined {
  return CHAT_TOOLS.find((t) => t.name === name);
}

/**
 * Compact tool descriptions for the system prompt — keeps token count
 * low. Format: `<name>(<args>): <description>`.
 */
export function toolsForPrompt(): string {
  return CHAT_TOOLS.map((t) => {
    const argList = t.schema.required.length > 0 ? t.schema.required.join(', ') : 'sin args';
    return `- ${t.name}(${argList}): ${t.description}`;
  }).join('\n');
}
