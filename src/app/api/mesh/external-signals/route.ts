import { NextRequest } from 'next/server';
import { openMeshDb, ingestExternalSignal, fetchExternalSignals } from '../_mesh-db';
import { rateLimitAsync, getRateLimitKey, getClientIP, LIMITS } from '@/lib/rate-limit';
import { validateMeshPayload } from '@/lib/validation';
import { apiBadRequest, apiOk, apiRateLimited, apiServerError, apiError } from '@/lib/api-response';
import { authedPOST } from '@/lib/middleware';
// Import the inbound HMAC verifier from the precompiled chismoso CLI bundle.
// The TypeScript source lives at chismoso/src/mesh/webhook.ts; the
// compiled JS + sibling .d.ts map ship under chismoso/dist/mesh/webhook.js.
// Same pattern as `_mesh-db.ts` importing `MeshDB` (note: this file is
// one directory deeper than `_mesh-db.ts`, so we need one more `../`).
import { verifyInboundSignature } from '../../../../../chismoso/dist/mesh/webhook.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// PER-AGENT HMAC SECRET RESOLUTION (audit H-5 close)
// ---------------------------------------------------------------------------

/**
 * Resolve the per-agent HMAC signing secret from env. The secret is
 * NEVER stored in the database — it lives only in env config (so a
 * SQLite backup leak, container escape, or DB-read SSRF cannot
 * disclose inbound signing keys).
 *
 * Convention:
 *   CHISMOSO_MESH_SECRETS = JSON map of `{ "<agent_name>": "<secret>", ... }`
 *
 * Example:
 *   CHISMOSO_MESH_SECRETS='{"NEX-SCOPE":"abc123","RADAR-SECOP2":"def456"}'
 *
 * When the env var is unset OR doesn't contain an entry for the
 * requested agent, returns `undefined`. In that case the route keeps
 * the legacy V1.0 "open inbound" posture (the audit explicitly allows
 * this as a transitional state — see H-5 partial). Operators are
 * expected to migrate to per-agent secrets before public GA.
 *
 * Parse failures are silent + logged: a malformed JSON env var should
 * NEVER 500 the route. We treat it as "no secrets configured" so a
 * misconfiguration opens the route instead of breaking it.
 */
function getMeshSecretForAgent(agentName: string): string | undefined {
  const raw = process.env.CHISMOSO_MESH_SECRETS;
  if (!raw || raw.trim().length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const v = parsed[agentName];
    if (typeof v !== 'string' || v.length === 0) return undefined;
    return v;
  } catch {
    if (process.env.CHISMOSO_LOG_LEVEL === 'DEBUG') {
       
      console.warn('[mesh-secrets] CHISMOSO_MESH_SECRETS is not valid JSON — treating as empty');
    }
    return undefined;
  }
}

/**
 * POST /api/mesh/external-signals
 *
 * External agents (NEX-SCOPE, RADAR-SECOP2, etc.) call this to push a
 * signal into the CHISMOSO inbox. The orchestrator/scheduler will pick
 * up unconsumed signals on its next run.
 *
 * Body: `{ source_agent: string, signal_type: string, payload: any }`
 * Response: `{ id: string, received_at: string }`
 *
 * §34 / audit C2 — Protected by `authedPOST`. This endpoint is the primary
 * entry point for external agents pushing data into CHISMOSO — without
 * auth, anyone could pollute the inbox with arbitrary payloads (which are
 * then surfaced to the LLM in the EVALUATE prompt). The mesh external
 * signals are still quarantined in `<untrusted_external_signals>` tags in
 * the prompt (audit C1), but auth prevents the inbox from being spammed.
 *
 * R2-IMP-SEC (audit H-5 + H-6 close): the route now ALSO verifies the
 * `X-Chismoso-Signature: sha256=<hex>` header against
 * `HMAC-SHA256(rawBody, secret)` where `secret` is looked up per
 * `source_agent` in the `CHISMOSO_MESH_SECRETS` env var (JSON map).
 * - When a secret IS configured for the agent: missing/malformed/
 *   mismatched signature → 401. This closes the H-6 spoofing vector
 *   (any agent with the shared `CHISMOSO_AUTH_TOKENS` could previously
 *   push payloads under any other agent's name).
 * - When NO secret is configured for the agent: verification is SKIPPED
 *   (legacy "open inbound" posture — explicitly allowed by the audit
 *   as a transitional state). The route still requires a valid
 *   X-Chismoso-Agent token via `authedPOST`, so the surface is at
 *   least authed even when HMAC is open.
 *
 * The signature is verified over the RAW request body bytes — NOT the
 * parsed JSON. The sender signs the exact bytes they transmit, so
 * re-serialization (which could change whitespace / key order) would
 * break the signature. We read the body once as text, verify, THEN
 * parse.
 *
 * Per-user / per-agent rate limiting (audit H-1): the limiter now keys
 * on the auth subject (`agent:<tokenHash>` for X-Chismoso-Agent callers)
 * instead of just the IP — so a single compromised token can't burst
 * through N IPs' worth of quota. Backed by Redis when `REDIS_URL` is
 * set (see `src/lib/rate-limit.ts`).
 */
export const POST = authedPOST(async (req: NextRequest) => {
  // --- Rate limit (per-agent via auth subject, 60/min) -----------------
  // R2-IMP-SEC (audit H-1): use the async Redis-backed limiter keyed
  // on the auth subject. Falls back to in-memory + IP when Redis is
  // unavailable.
  const rlKey = getRateLimitKey(req, 'meshPost');
  const rl = await rateLimitAsync(rlKey, LIMITS.meshPost);
  if (!rl.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
    return apiRateLimited(retryAfter);
  }

  // --- Read raw body ONCE — signature is over the exact bytes --------
  // R2-IMP-SEC (audit H-5): the HMAC signature is computed over the
  // raw request body. We must read it BEFORE parsing to JSON. Once
  // parsed + re-serialized, key order / whitespace may differ and the
  // signature wouldn't verify.
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return apiBadRequest('Invalid request body', { code: 'invalid_body' });
  }

  // --- Parse + validate shape -----------------------------------------
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return apiBadRequest('Invalid JSON body', { code: 'invalid_json' });
  }
  const payloadRes = validateMeshPayload(body);
  if (!payloadRes.ok) {
    return apiBadRequest(payloadRes.error ?? 'invalid body', { code: 'invalid_payload' });
  }
  const { sourceAgent, signalType, payload } = payloadRes.value!;

  // --- HMAC verification (audit H-5 + H-6 close) -----------------------
  // Look up the per-agent secret from env (NEVER from the DB). When
  // the operator hasn't provisioned a secret for this agent, the
  // verifier returns `verified: true` with reason
  // `no_secret_configured_open_inbound` — the route accepts the
  // payload (legacy V1.0 posture, explicitly allowed by the audit as
  // transitional).
  const secret = getMeshSecretForAgent(sourceAgent);
  const signatureHeader = req.headers.get('X-Chismoso-Signature');
  const sigResult = verifyInboundSignature({
    rawBody,
    signatureHeader,
    secret,
  });
  if (!sigResult.verified) {
    // 401 with the canonical error shape. The `reason` is safe to
    // disclose (it doesn't leak the secret or the computed digest).
    return apiError(401, 'Unauthorized', {
      reason: sigResult.reason ?? 'signature_verification_failed',
      // Never include `computedDigest` here — that would let an
      // attacker oracle the HMAC byte-by-byte via timing/error
      // channels. The chismoso verifier returns it for SERVER-SIDE
      // debug only.
    });
  }

  // --- Ingest the signal ---------------------------------------------
  let db: ReturnType<typeof openMeshDb> | null = null;
  try {
    db = openMeshDb();
    const result = ingestExternalSignal(db, sourceAgent, signalType, payload);
    return apiOk(result);
  } catch (e: unknown) {
    // R2-IMP-SEC (audit H-7): in production apiServerError() replaces
    // the `details` with `{ correlationId, message }` — `e.message`
    // is logged server-side + Sentry only, never returned to the client.
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('mesh_signal_ingest_failed', {
      ...(process.env.NODE_ENV !== 'production' ? { message } : {}),
    });
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
});

/**
 * GET /api/mesh/external-signals?limit=20&unconsumed=1
 *
 * Returns external signals (newest first by default). Use `?unconsumed=1`
 * to only return signals the orchestrator hasn't consumed yet.
 *
 * Response shape:
 *   { count: number, signals: MeshExternalSignal[] }
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const limitRaw = Number.parseInt(searchParams.get('limit') ?? '20', 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 20;
  const unconsumedOnly = searchParams.get('unconsumed') === '1' || searchParams.get('unconsumed') === 'true';

  let db: ReturnType<typeof openMeshDb> | null = null;
  try {
    db = openMeshDb();
    const signals = fetchExternalSignals(db, limit, unconsumedOnly);
    return apiOk({ count: signals.length, signals });
  } catch (e: unknown) {
    // R2-IMP-SEC (audit H-7): in production apiServerError() replaces
    // the `details` with `{ correlationId, message }` — `e.message`
    // is logged server-side + Sentry only, never returned to the client.
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('mesh_signals_query_failed', {
      ...(process.env.NODE_ENV !== 'production' ? { message } : {}),
    });
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}

// getClientIP is exported for backward-compat callers that still
// import it from this re-export site (none in the current tree, but
// we keep the symbol stable in case downstream packages import it).
export { getClientIP };
