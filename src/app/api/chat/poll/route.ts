/**
 * AGENT-1 — GET /api/chat/poll
 *
 * Proactive anomaly polling endpoint.
 *
 * The dashboard chat UI polls this endpoint every 60s while a chat session
 * is active. The server diffs the current `/api/anomalies` output against
 * the per-session `lastSeenAnomalyIds` set and returns ONLY the new ones.
 *
 * The chat UI then inserts a synthetic system message into the chat:
 *   "⚠ Spike en X — z=2.8. ¿Profundizo?"
 *
 * The server-side diff approach (vs. client-side) is intentional:
 *   - The session-scoped `lastSeenAnomalyIds` set is also updated when
 *     the agent itself calls `list_anomalies` tool — so the user is never
 *     double-notified about the same anomaly.
 *   - Poll cadence enforcement stays server-side, where we can apply
 *     a sane minimum interval (30s) without trusting the client.
 *
 * === Contract ===
 *
 *   GET /api/chat/poll?sessionId=sess_xxx
 *
 *   200: { sessionId, polledAt: ISO, newAnomalies: Anomaly[], totalActive: N, seenCount: N }
 *   200 (throttled): { ..., newAnomalies: [], throttled: true, retryAfterSec: N }
 *   400: { error: "missing_sessionId" | "invalid_sessionId" }
 *   404: { error: "session_not_found" }
 *   429: { error: "Rate limit exceeded", details: { retryAfterSec } }
 */

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/chat-session';
import { getClientIP, rateLimit } from '@/lib/rate-limit';
import { apiBadRequest, apiNotFound, apiOk, apiRateLimited, apiServerError } from '@/lib/api-response';
import { detectAnomalies, type Anomaly } from '@/lib/anomaly-detector';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

/**
 * Per-IP rate limit. Polls should come every 60s per session; with
 * multiple sessions per IP that's still well under 10/min/IP. We allow
 * 15/min/IP to absorb client retries without punishing users.
 */
const POLL_RATE_LIMIT = { windowMs: 60_000, maxRequests: 15 };

/** Minimum interval between polls for a given session. Enforced server-side
 *  so a buggy client can't spam the detector. */
const MIN_POLL_INTERVAL_MS = 30_000;

export async function GET(req: NextRequest) {
  // --- Rate limit (per-IP) --------------------------------------------
  const ip = getClientIP(req);
  const rl = rateLimit(`chat-poll:${ip}`, POLL_RATE_LIMIT);
  if (!rl.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
    return apiRateLimited(retryAfter);
  }

  // --- Parse sessionId --------------------------------------------------
  const url = new URL(req.url);
  const sessionId = (url.searchParams.get('sessionId') ?? '').trim();

  if (!sessionId) {
    return apiBadRequest('missing_sessionId', {
      hint: 'Pass ?sessionId=sess_xxx from the value returned by POST /api/chat',
    });
  }
  if (!/^sess_[a-z0-9_]+$/.test(sessionId)) {
    return apiBadRequest('invalid_sessionId', { hint: 'sessionId must match /^sess_[a-z0-9_]+$/' });
  }

  const session = getSession(sessionId);
  if (!session) {
    return apiNotFound('session_not_found');
  }

  // --- Enforce minimum poll interval -----------------------------------
  const now = Date.now();
  const sinceLast = now - session.lastPolledAnomaliesAt;
  if (sinceLast < MIN_POLL_INTERVAL_MS) {
    // Don't 429 (that would burn the client's rate-limit budget) — just
    // return an empty newAnomalies list and tell them when they can poll
    // again. This keeps the diff logic idempotent.
    return apiOk({
      sessionId,
      polledAt: new Date(now).toISOString(),
      newAnomalies: [],
      totalActive: 0,
      throttled: true,
      retryAfterSec: Math.ceil((MIN_POLL_INTERVAL_MS - sinceLast) / 1000),
      message: `Polling too frequent — wait ${Math.ceil((MIN_POLL_INTERVAL_MS - sinceLast) / 1000)}s`,
    });
  }
  session.lastPolledAnomaliesAt = now;

  // --- Detect anomalies ------------------------------------------------
  let allAnomalies: Anomaly[];
  try {
    allAnomalies = detectAnomalies(null);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('anomaly_detection_failed', { message });
  }

  // --- Diff against lastSeenAnomalyIds ---------------------------------
  const newAnomalies: Anomaly[] = [];
  for (const a of allAnomalies) {
    // Record every active anomaly as seen — so subsequent polls only
    // surface ones that appeared AFTER this call.
    const isNew = !session.lastSeenAnomalyIds.has(a.id);
    if (isNew) {
      session.lastSeenAnomalyIds.add(a.id);
      newAnomalies.push(a);
    }
  }

  // --- Bound the set size so long-lived sessions don't leak memory -----
  // Anomaly IDs are short strings; even 1000 of them is negligible. But
  // a session that lives for hours with high churn could accumulate stale
  // IDs that no longer correspond to active anomalies. Trim to last 200.
  if (session.lastSeenAnomalyIds.size > 200) {
    // Drop entries that no longer appear in the active set — they're
    // not useful anymore since the anomaly has either cleared or been
    // acknowledged.
    const activeIds = new Set(allAnomalies.map((a) => a.id));
    for (const seenId of Array.from(session.lastSeenAnomalyIds)) {
      if (!activeIds.has(seenId)) session.lastSeenAnomalyIds.delete(seenId);
    }
  }

  return apiOk({
    sessionId,
    polledAt: new Date(now).toISOString(),
    newAnomalies,
    totalActive: allAnomalies.length,
    seenCount: session.lastSeenAnomalyIds.size,
  });
}
