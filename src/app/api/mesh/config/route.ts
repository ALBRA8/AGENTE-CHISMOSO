import { NextRequest } from 'next/server';
import { openMeshDb, getMeshConfig, setMeshConfig } from '../_mesh-db';
import { apiBadRequest, apiOk, apiServerError } from '@/lib/api-response';
import { authedPUT } from '@/lib/middleware';
import { requireRole } from '@/lib/require-role';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/mesh/config
 *
 * Returns the current mesh configuration: enabled flag + list of
 * registered webhook subscribers (secrets are NOT included in the
 * response — only a boolean `hasSecret` flag per subscriber).
 */
export async function GET() {
  let db: ReturnType<typeof openMeshDb> | null = null;
  try {
    db = openMeshDb();
    const cfg = getMeshConfig(db);
    // Sanitize: never leak secrets to the API caller.
    const safeSubs = cfg.subscribers.map((s) => ({
      agentName: s.agentName,
      webhookUrl: s.webhookUrl,
      hasSecret: Boolean(s.secret),
      eventsFilter: s.eventsFilter,
      active: s.active,
    }));
    return apiOk({ enabled: cfg.enabled, subscribers: safeSubs });
  } catch (e: unknown) {
    // R2-IMP-SEC (audit H-7): in production apiServerError() replaces the
    // `details` with `{ correlationId, message }` — `e.message` is logged
    // server-side + Sentry only, never returned to the client.
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('mesh_config_read_failed', {
      ...(process.env.NODE_ENV !== 'production' ? { message } : {}),
    });
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}

/**
 * PUT /api/mesh/config
 *
 * Replaces the mesh configuration (enabled flag + full subscriber list).
 * Subscribers not in the request body are removed. To add/remove a single
 * subscriber without sending the full list, use the dedicated CLI:
 *   chismoso mesh subscribe --agent=NAME --url=URL [--secret=XXX]
 *
 * Body: `{ enabled: boolean, subscribers: Array<{ agentName, webhookUrl, secret?, eventsFilter? }> }`
 * Response: `{ enabled: boolean, subscribers: number }`
 *
 * §34 / audit C2 — Protected by `authedPUT`: this route reconfigures webhook
 * subscribers (including the `webhook_url` that CHISMOSO will then call out
 * to). Without auth, any caller could redirect webhook delivery to their own
 * receiver and capture HMAC-signed opportunity payloads in real time.
 *
 * R2-IMP-SEC (audit R2-8): the PUT handler is gated on `role === 'admin'`
 * via `requireRole('admin')` composed inside `authedPUT`. Rewriting the
 * subscriber list (including redirecting the webhook_url to an
 * attacker-controlled receiver) is a high-impact mutation that a
 * regular operator should not be able to trigger. Dev (auth disabled)
 * bypasses the gate so the dashboard opens without provisioning an
 * admin user.
 */
export const PUT = authedPUT(requireRole('admin')(async (req: NextRequest) => {
  let body: { enabled?: boolean; subscribers?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return apiBadRequest('Invalid JSON body', { code: 'invalid_json' });
  }
  if (typeof body?.enabled !== 'boolean') {
    return apiBadRequest('enabled (boolean) is required', { code: 'missing_field' });
  }
  if (!Array.isArray(body.subscribers)) {
    return apiBadRequest('subscribers (array) is required', { code: 'missing_field' });
  }
  // Validate each subscriber entry.
  const subs: Array<{ agentName: string; webhookUrl: string; secret?: string; eventsFilter?: string[] }> = [];
  for (const raw of body.subscribers) {
    const s = raw as any;
    if (typeof s?.agentName !== 'string' || !s.agentName.trim()) {
      return apiBadRequest('agentName (string) is required', { code: 'invalid_subscriber' });
    }
    if (typeof s?.webhookUrl !== 'string' || !/^https?:\/\//i.test(s.webhookUrl)) {
      return apiBadRequest(`webhookUrl must be a valid http(s) URL (agent: ${s.agentName})`, { code: 'invalid_subscriber' });
    }
    subs.push({
      agentName: s.agentName,
      webhookUrl: s.webhookUrl,
      secret: typeof s.secret === 'string' && s.secret.length > 0 ? s.secret : undefined,
      eventsFilter: Array.isArray(s.eventsFilter) ? s.eventsFilter : undefined,
    });
  }

  let db: ReturnType<typeof openMeshDb> | null = null;
  try {
    db = openMeshDb();
    setMeshConfig(db, body.enabled, subs);
    return apiOk({ enabled: body.enabled, subscribers: subs.length });
  } catch (e: unknown) {
    // R2-IMP-SEC (audit H-7): in production apiServerError() replaces the
    // `details` with `{ correlationId, message }` — `e.message` is logged
    // server-side + Sentry only, never returned to the client.
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('mesh_config_write_failed', {
      ...(process.env.NODE_ENV !== 'production' ? { message } : {}),
    });
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}));
