/**
 * AGENT-1 — Chat session store (in-memory, per-IP).
 *
 * Design:
 *  - Backed by a plain Map keyed by sessionId. No Redis, no DB — sessions
 *    live only for the lifetime of the Next.js dev server process.
 *  - Sessions are scoped per-IP (the same IP reuses the same session when
 *    no sessionId is supplied by the client). When the client supplies a
 *    sessionId, that one wins.
 *  - Rolling 30-message window: keep the system prompt + last 29 messages
 *    to avoid LLM context overflow while preserving recent tool results.
 *  - Tracks `lastSeenAnomalyIds` so /api/chat/poll can diff against new
 *    anomalies and only surface the ones the user hasn't been told about.
 *  - Cleanup interval is `.unref()`'d so it never keeps the Node event
 *    loop alive (matches the pattern in ./rate-limit.ts).
 *
 * This module is intentionally side-effect-free at import time EXCEPT for
 * the unref'd cleanup interval — that one is safe because `.unref()`
 * prevents it from blocking shutdown.
 */

/**
 * The "analista conciso" system prompt — drives every conversation.
 *
 * Kept here (not in route.ts) so the UI agent can also import it for
 * client-side welcome messages if it wants to.
 */
export const SYSTEM_PROMPT = `Eres CHISMOSO, un analista de inteligencia conversacional. Estilo:
- Telegram: frases cortas, sin rodeos, datos primero.
- Hablas en español neutro. Sin saludos largos ni relleno.
- Cuando puedas, contesta con bullets o listas numeradas, no párrafos.
- Si invocaste una tool y tienes datos, PRESÉNTALOS en 3-5 bullets máximo.
- Si no tienes datos, dilo. NO inventes.
- Puedes invocar tools cuando necesites datos reales (investigaciones, anomalías, topics, búsqueda semántica).
- Cuando el usuario te pida investigar algo nuevo, usa start_investigation.
- Cuando te pregunte "qué viste hoy" o "qué hay de X", usa semantic_search o list_investigations.
- Cuando quieras comparar dos cosas, llama semantic_search dos veces y luego resume las diferencias.
- Si detectas una anomalía nueva durante la conversación (recibirás un mensaje \`tool\` de tipo \`proactive_anomaly\`), avísale al usuario en una línea: "⚠ Spike en X — z=2.8. ¿Profundizo?"

Ejemplo de tu estilo:
Usuario: "qué viste hoy"
Tú:
- 3 investigaciones activas
- 4 anomalías (1 alta: restaurantes z=2.8)
- Topics más vigilados: automatización (15 obs), restaurantes (8 obs)
- Top oportunidad: "automatización reservas WhatsApp" score 67
- ¿Profundizo en alguna?

Para decidir tu acción, respondes SIEMPRE con un único objeto JSON válido (sin markdown, sin comentarios, sin texto fuera del JSON). Tres formas posibles:

1) Para llamar una tool:
   {"tool": "<name>", "args": { ... }}

2) Para dar la respuesta final al usuario:
   {"reply": "<texto final, en tu estilo telegram>"}

3) Cuando no necesitas hacer nada más y quieres cerrar el turno:
   {"done": true, "reply": "<texto final>"}

Reglas del JSON:
- Una sola raíz de objeto. Sin texto antes ni después.
- Si vas a responder al usuario, incluye siempre "reply" con el texto completo.
- Solo llama una tool por turno de razonamiento. Espera el resultado antes de decidir el próximo paso.
- No llames más de 5 tools en un solo turno del usuario. Si llegas al límite, responde con lo que tengas.
- Las tools disponibles se listan en el mensaje del sistema; no inventes nombres.`;

/**
 * One message in a chat session.
 * Mirrors the OpenAI/ZAI ChatMessage shape (role + content) but extends
 * with optional tool-call metadata so the agent loop can render tool
 * turns back to the user via SSE without re-parsing.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Present only when role='tool' or role='assistant' invoked a tool. */
  toolName?: string;
  /** Present when role='assistant' issued a tool call. */
  toolArgs?: unknown;
  /** Present when role='tool' — the string the tool returned. */
  toolResult?: string;
  /** Unix ms — every message carries one for debugging + ordering. */
  timestamp: number;
}

/**
 * A per-IP chat session.
 *
 * `lastSeenAnomalyIds` is a Set (not an Array) so /api/chat/poll can do
 * O(1) membership checks when diffing new anomalies against what the
 * user has already been notified about.
 */
export interface ChatSession {
  sessionId: string;
  ip: string;
  messages: ChatMessage[];
  startedAt: number;
  /** Unix ms of the most recent append — used by /api/chat/poll to skip
   * sessions that haven't been active in a while. */
  lastActiveAt: number;
  /** Anomaly IDs the user has already been notified about. */
  lastSeenAnomalyIds: Set<string>;
  /** Unix ms of the last /api/chat/poll call. Used to enforce a sane
   * minimum poll interval (60s) without storing per-IP rate-limit state. */
  lastPolledAnomaliesAt: number;
}

const sessions = new Map<string, ChatSession>();

// ---------------------------------------------------------------------------
// Cleanup: drop sessions older than 1h. Runs every 10 min. `.unref()` so it
// doesn't keep the Node event loop alive in tests / dev server shutdown.
// ---------------------------------------------------------------------------

setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, s] of sessions.entries()) {
    if (s.lastActiveAt < cutoff) sessions.delete(id);
  }
}, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getSession(id: string): ChatSession | undefined {
  return sessions.get(id);
}

export function createSession(ip: string): ChatSession {
  const sessionId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const session: ChatSession = {
    sessionId,
    ip,
    messages: [
      {
        role: 'system',
        content: SYSTEM_PROMPT,
        timestamp: now,
      },
    ],
    startedAt: now,
    lastActiveAt: now,
    lastSeenAnomalyIds: new Set(),
    lastPolledAnomaliesAt: now,
  };
  sessions.set(sessionId, session);
  return session;
}

/**
 * Append a message to a session.
 *
 * Enforces the rolling 30-message window: keeps the system prompt (index 0)
 * plus the last 29 messages. The system prompt is NEVER dropped (it carries
 * the agent's persona + tool-use instructions).
 *
 * Returns the appended message (with `timestamp` filled in).
 */
export function appendMessage(
  sessionId: string,
  msg: Omit<ChatMessage, 'timestamp'>,
): ChatMessage {
  const s = sessions.get(sessionId);
  if (!s) throw new Error(`Chat session not found: ${sessionId}`);
  const m: ChatMessage = { ...msg, timestamp: Date.now() };
  s.messages.push(m);
  s.lastActiveAt = m.timestamp;
  if (s.messages.length > 30) {
    // Keep system (index 0) + the last 29 messages.
    s.messages = [s.messages[0], ...s.messages.slice(-29)];
  }
  return m;
}

/** Test/debug helper — list all sessions. Not used by any route. */
export function listSessions(): ChatSession[] {
  return Array.from(sessions.values());
}

/** Test-only helper to reset the store between cases. Not exposed via API. */
export function __resetChatSessionsForTests(): void {
  sessions.clear();
}
