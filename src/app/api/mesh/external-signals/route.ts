import { NextRequest } from 'next/server';
import { openMeshDb, ingestExternalSignal, fetchExternalSignals } from '../_mesh-db';
import { rateLimit, getClientIP, LIMITS } from '@/lib/rate-limit';
import { validateMeshPayload } from '@/lib/validation';
import { apiBadRequest, apiOk, apiRateLimited, apiServerError } from '@/lib/api-response';
import { authedPOST } from '@/lib/middleware';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
 */
export const POST = authedPOST(async (req: NextRequest) => {
  // --- Rate limit (per-IP, 60/min) -------------------------------------
  const ip = getClientIP(req);
  const rl = rateLimit(`meshPost:${ip}`, LIMITS.meshPost);
  if (!rl.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
    return apiRateLimited(retryAfter);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiBadRequest('Invalid JSON body', { code: 'invalid_json' });
  }
  const payloadRes = validateMeshPayload(body);
  if (!payloadRes.ok) {
    return apiBadRequest(payloadRes.error ?? 'invalid body', { code: 'invalid_payload' });
  }
  const { sourceAgent, signalType, payload } = payloadRes.value!;

  let db: ReturnType<typeof openMeshDb> | null = null;
  try {
    db = openMeshDb();
    const result = ingestExternalSignal(db, sourceAgent, signalType, payload);
    return apiOk(result);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('mesh_signal_ingest_failed', { message });
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
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('mesh_signals_query_failed', { message });
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}
