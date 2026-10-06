/**
 * AGENT-1 — POST /api/chat
 *
 * Conversational agent SSE endpoint. Streams the agent's reply token-by-
 * token to the dashboard chat sidebar.
 *
 * === Architecture ===
 *
 *   Client ──POST {message, sessionId?}──▶ /api/chat
 *                                            │
 *                                            ▼
 *                          ┌─────────────────────────────────┐
 *                          │  createSession(ip) on first call │
 *                          │  appendMessage(user)            │
 *                          └─────────────────────────────────┘
 *                                            │
 *                                            ▼
 *                          ┌─────────────────────────────────┐
 *                          │  Agent loop (max 6 iterations):  │
 *                          │    1. LLM call (non-streaming)   │
 *                          │    2. Parse JSON {tool}|{reply}  │
 *                          │    3a. {tool, args} → execute →  │
 *                          │        append tool msg → loop    │
 *                          │    3b. {reply} → emit tokens →  │
 *                          │        done                     │
 *                          └─────────────────────────────────┘
 *                                            │
 *                                            ▼
 *                          ┌─────────────────────────────────┐
 *                          │  SSE stream closed (event: done) │
 *                          └─────────────────────────────────┘
 *
 * === ReAct-style prompt ===
 *
 * The ZAI SDK 0.0.18 doesn't expose a `tools:` param on
 * chat.completions.create. We therefore drive tool selection via the
 * system prompt: the LLM responds with a single JSON object per turn —
 * either `{"tool":"name","args":{...}}` to invoke a tool, or
 * `{"reply":"..."}` to give the final answer. Mirrors the pattern in
 * chismoso/src/orchestrator/react.ts (ReActOrchestrator).
 *
 * === Streaming ===
 *
 * The agent reasoning loop runs non-streaming (we need to JSON-parse each
 * decision). When the LLM produces the final reply, we emit it via SSE
 * `event: token` chunks (word-level) to give the chat UI a real-time
 * typing feel. The spec explicitly allows "token (or chunk)" emission.
 *
 * === SSE event contract ===
 *
 *   event: session     data: {"sessionId":"sess_..."}
 *   event: tool_call   data: {"name":"...","args":{...},"iteration":N}
 *   event: tool_result data: {"name":"...","summary":"...","ok":true,"iteration":N,"durationMs":N}
 *   event: token       data: {"text":"..."}    (chunk of the final reply)
 *   event: done        data: {"sessionId":"...","toolCalls":N,"durationMs":N}
 *   event: error       data: {"message":"..."}
 */

import { NextRequest } from 'next/server';
import ZAI from 'z-ai-web-dev-sdk';
import {
  createSession,
  getSession,
  appendMessage,
  SYSTEM_PROMPT,
  type ChatSession,
} from '@/lib/chat-session';
import { getClientIP, rateLimit } from '@/lib/rate-limit';
import { getChatTool, toolsForPrompt } from './tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard ceiling on agent iterations per user turn. 5 tool calls + 1 final. */
const MAX_ITERATIONS = 6;

/** Cap on conversation history we forward to the LLM (system prompt is on top). */
const MAX_HISTORY_MESSAGES = 10;

/**
 * Per-IP rate limit. Chat is interactive — 20/min/IP is generous enough
 * for real-time typing while still blocking naive abuse.
 */
const CHAT_RATE_LIMIT = { windowMs: 60_000, maxRequests: 20 };

/** Delay (ms) between SSE token chunks for the typing feel. */
const TOKEN_STREAM_DELAY_MS = 12;

// ---------------------------------------------------------------------------
// ZAI singleton (lazy — first call pays the create() cost, subsequent calls
// reuse the cached promise). Same pattern as chismoso LLMClient.
// ---------------------------------------------------------------------------

let zaiPromise: Promise<ZAI> | null = null;
function getZAI(): Promise<ZAI> {
  if (!zaiPromise) zaiPromise = ZAI.create();
  return zaiPromise;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AgentDecision {
  /** When present, the LLM wants to call a tool. */
  tool?: string;
  args?: Record<string, unknown>;
  /** When present, the LLM is giving the final reply. */
  reply?: string;
  /** When true, the LLM is ready to close the turn (with reply). */
  done?: boolean;
}

/**
 * Parse the LLM's text response into an AgentDecision.
 *
 * Tolerates:
 *   - Leading/trailing whitespace.
 *   - Markdown fences (```json ... ```).
 *   - Plain-text replies (LLM ignored the JSON directive) — treated as a
 *     final reply using the raw text.
 */
function parseDecision(raw: string): AgentDecision {
  const text = (raw ?? '').trim();
  if (text.length === 0) return { reply: '(sin respuesta)' };

  // Strip ```json ... ``` fences if present.
  let candidate = text;
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) candidate = fenceMatch[1].trim();

  // Try strict JSON parse.
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object') {
      // Recognized shapes:
      //   {tool, args}            → tool call
      //   {reply}                 → final reply
      //   {done: true, reply}     → final reply (explicit close)
      //   {done: true}            → empty final reply
      if (typeof parsed.tool === 'string') {
        return {
          tool: parsed.tool,
          args:
            parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args)
              ? (parsed.args as Record<string, unknown>)
              : {},
        };
      }
      if (typeof parsed.reply === 'string') {
        return { reply: parsed.reply, done: Boolean(parsed.done) };
      }
      if (parsed.done === true) {
        return { reply: '', done: true };
      }
    }
  } catch {
    /* fall through to plain-text fallback */
  }

  // Fallback: treat the raw LLM output as a natural-language reply.
  // This is the graceful degradation when the LLM ignores the JSON
  // directive — we still give the user the answer.
  return { reply: text };
}

/**
 * Convert ChatSession messages → ZAI ChatMessage[].
 *
 * Keeps the system prompt (always index 0) + the last MAX_HISTORY_MESSAGES
 * non-system messages. We re-write the system prompt each call so the
 * tools-available list is always current.
 *
 * ZAI's ChatMessage type only allows role in {'system','user','assistant'}
 * — there is no 'tool' role. We fold tool results into a `user` message
 * prefixed with `[tool_result: <name>]` so the LLM sees the structured
 * observation but the type system stays happy.
 */
function buildLLMMessages(session: ChatSession): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const sysContent = `${SYSTEM_PROMPT}\n\nTools disponibles:\n${toolsForPrompt()}`;

  // Skip the seed system message (index 0) — we just rebuilt it above.
  const history = session.messages.slice(1).slice(-MAX_HISTORY_MESSAGES);

  const out: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: sysContent },
  ];

  for (const m of history) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      // Fold tool result into a user-side observation.
      const toolName = m.toolName ?? 'unknown';
      const summary = (m.toolResult ?? '').slice(0, 4000);
      out.push({
        role: 'user',
        content: `[tool_result: ${toolName}]\n${summary}`,
      });
    } else if (m.role === 'assistant') {
      // If the assistant's message contains a tool call marker, preserve
      // it as-is so the LLM remembers it asked for that tool.
      out.push({ role: 'assistant', content: m.content });
    } else {
      // user
      out.push({ role: 'user', content: m.content });
    }
  }

  return out;
}

/**
 * Call the LLM (non-streaming) and return the raw content string.
 *
 * Errors are thrown; the caller is responsible for emitting an SSE error
 * event and closing the stream.
 */
async function callLLM(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>): Promise<string> {
  const zai = await getZAI();
  const completion: any = await zai.chat.completions.create({
    messages,
    thinking: { type: 'disabled' },
  } as any);
  return (completion?.choices?.[0]?.message?.content ?? '').toString();
}

/**
 * Split a reply string into word-level chunks (keeping whitespace) for
 * SSE token emission. Each chunk is small enough that the UI can render
 * it as a "typing" tick.
 *
 * Examples:
 *   "Hola"               → ["Hola"]
 *   "Hola mundo"         → ["Hola", " ", "mundo"]
 *   "Hola.\n- bullet 1"  → ["Hola.", "\n", "-", " ", "bullet", " ", "1"]
 */
function chunkReply(text: string): string[] {
  if (!text) return [];
  // Match words OR sequences of whitespace OR single punctuation chars.
  // This keeps newline characters as their own chunks so the chat UI
  // can render bullet lists line-by-line as they stream in.
  const matches = text.match(/(\s+|[^\s]+)/g);
  return matches ?? [text];
}

// ---------------------------------------------------------------------------
// SSE stream construction
// ---------------------------------------------------------------------------

interface SSEController {
  send: (event: string, data: unknown) => void;
  close: () => void;
}

/**
 * Build a `text/event-stream` Response whose underlying ReadableStream
 * is driven by the returned controller. Pattern matches
 * /api/investigate/stream/route.ts.
 *
 * The controller's `enqueue`/`close` calls are no-ops after the first
 * `close()` (or after the client disconnects), so the agent loop can
 * call them defensively without checking state.
 */
function createSSEStream(signal: AbortSignal): { response: Response; controller: SSEController } {
  const encoder = new TextEncoder();
  let closed = false;
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      signal.addEventListener(
        'abort',
        () => {
          closed = true;
          try { controller.close(); } catch { /* already closed */ }
        },
        { once: true },
      );
    },
    cancel() {
      // Client navigated away / closed the tab.
      closed = true;
    },
  });

  const send = (event: string, data: unknown) => {
    if (closed || !streamController) return;
    try {
      const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      streamController.enqueue(encoder.encode(payload));
    } catch {
      /* controller may already be closed — ignore */
    }
  };

  const close = () => {
    if (closed) return;
    closed = true;
    if (!streamController) return;
    try { streamController.close(); } catch { /* already closed */ }
  };

  const response = new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disable nginx/proxy buffering (Caddy passes this through fine).
      'X-Accel-Buffering': 'no',
    },
  });

  return { response, controller: { send, close } };
}

/**
 * Small sleep helper that respects an AbortSignal — if the client
 * disconnects mid-stream, we abort the sleep and bail out.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

async function runAgentLoop(
  session: ChatSession,
  sse: SSEController,
): Promise<{ toolCalls: number; reply: string }> {
  let toolCalls = 0;
  const startedAt = Date.now();

  // Initial: emit session id so the client can persist it for the next turn.
  sse.send('session', { sessionId: session.sessionId });

  for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
    const llmMessages = buildLLMMessages(session);
    const raw = await callLLM(llmMessages).catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      sse.send('error', { message: `LLM unavailable: ${msg}`, iteration: iter });
      return null;
    });
    if (raw === null) {
      sse.send('done', {
        sessionId: session.sessionId,
        toolCalls,
        durationMs: Date.now() - startedAt,
        error: 'llm_unavailable',
      });
      sse.close();
      return { toolCalls, reply: '' };
    }

    const decision = parseDecision(raw);

    // ---- Case 1: LLM wants to call a tool -------------------------------
    if (decision.tool) {
      const toolName = decision.tool;
      const tool = getChatTool(toolName);
      sse.send('tool_call', { name: toolName, args: decision.args ?? {}, iteration: iter });

      // Record the assistant's tool-call intent so the next LLM call sees it.
      appendMessage(session.sessionId, {
        role: 'assistant',
        content: JSON.stringify({ tool: toolName, args: decision.args ?? {} }),
        toolName,
        toolArgs: decision.args,
      });

      if (!tool) {
        const errMsg = `Tool desconocida: ${toolName}. Tools disponibles: list_investigations, load_investigation, start_investigation, semantic_search, list_anomalies, list_topics.`;
        appendMessage(session.sessionId, { role: 'tool', content: errMsg, toolName, toolResult: errMsg });
        sse.send('tool_result', { name: toolName, summary: errMsg, ok: false, iteration: iter, durationMs: 0 });
        continue;
      }

      const toolStart = Date.now();
      let summary = '';
      let ok = true;
      try {
        summary = await tool.execute(decision.args ?? {}, session);
      } catch (e) {
        ok = false;
        summary = `Error ejecutando ${toolName}: ${e instanceof Error ? e.message : String(e)}`;
      }
      const toolDurationMs = Date.now() - toolStart;
      appendMessage(session.sessionId, {
        role: 'tool',
        content: summary,
        toolName,
        toolResult: summary,
      });
      sse.send('tool_result', {
        name: toolName,
        summary: summary.slice(0, 400),
        ok,
        iteration: iter,
        durationMs: toolDurationMs,
      });
      toolCalls++;
      continue;
    }

    // ---- Case 2: LLM is giving the final reply -------------------------
    const reply = decision.reply ?? '';
    appendMessage(session.sessionId, { role: 'assistant', content: reply });

    // Stream the reply word-by-word as `event: token`.
    const chunks = chunkReply(reply);
    for (const chunk of chunks) {
      sse.send('token', { text: chunk });
      // Small delay for the typing feel. Skip on very long replies so the
      // user doesn't wait for the full stream.
      if (chunks.length < 80 && TOKEN_STREAM_DELAY_MS > 0) {
        await sleep(TOKEN_STREAM_DELAY_MS);
      }
    }

    sse.send('done', {
      sessionId: session.sessionId,
      toolCalls,
      durationMs: Date.now() - startedAt,
    });
    sse.close();
    return { toolCalls, reply };
  }

  // ---- Exhausted iterations without a final reply ----------------------
  // Force a graceful close so the client doesn't hang.
  const fallback = 'Alcanzado el límite de iteraciones. Reformula tu consulta o inténtalo de nuevo.';
  appendMessage(session.sessionId, { role: 'assistant', content: fallback });
  sse.send('token', { text: fallback });
  sse.send('done', {
    sessionId: session.sessionId,
    toolCalls,
    durationMs: Date.now() - startedAt,
    exhausted: true,
  });
  sse.close();
  return { toolCalls, reply: fallback };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  // --- Rate limit ------------------------------------------------------
  const ip = getClientIP(req);
  const rl = rateLimit(`chat:${ip}`, CHAT_RATE_LIMIT);
  if (!rl.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
    return new Response(
      JSON.stringify({ error: 'Rate limit exceeded', details: { retryAfterSec: retryAfter } }),
      {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) },
      },
    );
  }

  // --- Parse body ------------------------------------------------------
  let body: { message?: unknown; sessionId?: unknown };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) {
    return new Response(JSON.stringify({ error: 'Missing `message` field' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (message.length > 2000) {
    return new Response(JSON.stringify({ error: 'Message too long (max 2000 chars)' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // --- Resolve / create session ---------------------------------------
  const sessionIdRaw = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  let session: ChatSession;
  if (sessionIdRaw && /^sess_[a-z0-9_]+$/.test(sessionIdRaw)) {
    const existing = getSession(sessionIdRaw);
    if (existing) {
      session = existing;
    } else {
      // Stale or unknown sessionId — create a fresh session.
      session = createSession(ip);
    }
  } else {
    session = createSession(ip);
  }

  // --- Append user message --------------------------------------------
  appendMessage(session.sessionId, { role: 'user', content: message });

  // --- Build SSE stream + run agent loop -------------------------------
  const { response, controller } = createSSEStream(req.signal);

  // Run the agent loop asynchronously — fire and forget. The SSE stream
  // stays open until the loop calls `close()` or the client disconnects.
  runAgentLoop(session, controller).catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      controller.send('error', { message: `Agent loop crashed: ${msg}` });
      controller.send('done', { sessionId: session.sessionId, toolCalls: 0, durationMs: 0, error: msg });
    } catch { /* ignore */ }
    controller.close();
  });

  return response;
}

// ---------------------------------------------------------------------------
// GET /api/chat — convenience health/info endpoint
// ---------------------------------------------------------------------------

/**
 * GET /api/chat — convenience health/info endpoint.
 *
 * Returns a static descriptor so curl/browser tests can confirm the
 * endpoint is reachable without paying for a full agent run. Does NOT
 * consume the rate-limit budget.
 */
export async function GET() {
  return new Response(
    JSON.stringify({
      ok: true,
      endpoint: 'POST /api/chat',
      contract: {
        request: { message: 'string (required, max 2000 chars)', sessionId: 'string? (sess_...)' },
        sseEvents: ['session', 'tool_call', 'tool_result', 'token', 'done', 'error'],
        maxToolCallsPerTurn: 5,
        maxDurationSec: 60,
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}
