import { NextRequest } from 'next/server';
import { openMeshDb, fetchPendingEvents, ackEvents } from '../_mesh-db';
import { apiBadRequest, apiOk, apiServerError } from '@/lib/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/mesh/events?agent=AGENTE-LEADS&limit=20
 *
 * Returns pending (undelivered) opportunity events for the given target
 * agent. Events are NOT marked as delivered — the consumer must POST
 * `{ ids: [...] }` to `/api/mesh/events/ack` (or POST the same to this
 * route) once it has processed them.
 *
 * Response shape:
 *   {
 *     agent: string,
 *     count: number,
 *     events: MeshOpportunityEvent[]
 *   }
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const agent = searchParams.get('agent');
  if (!agent) {
    return apiBadRequest('Query parameter "agent" is required', { code: 'missing_agent' });
  }
  const limitRaw = Number.parseInt(searchParams.get('limit') ?? '20', 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 20;

  let db: ReturnType<typeof openMeshDb> | null = null;
  try {
    db = openMeshDb();
    const events = fetchPendingEvents(db, agent, limit);
    return apiOk({ agent, count: events.length, events });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('mesh_events_query_failed', { message });
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}

/**
 * POST /api/mesh/events
 *
 * Alternative ACK endpoint: send `{ ids: string[] }` to mark events as
 * delivered. Same effect as POSTing to `/api/mesh/events/ack`.
 *
 * Response shape:
 *   { acked: number }
 */
export async function POST(req: NextRequest) {
  let body: { ids?: string[] };
  try {
    body = (await req.json()) as { ids?: string[] };
  } catch {
    return apiBadRequest('Invalid JSON body', { code: 'invalid_json' });
  }
  const ids = Array.isArray(body?.ids) ? body!.ids!.filter((x): x is string => typeof x === 'string') : [];
  if (ids.length === 0) {
    return apiOk({ acked: 0 });
  }
  let db: ReturnType<typeof openMeshDb> | null = null;
  try {
    db = openMeshDb();
    const acked = ackEvents(db, ids);
    return apiOk({ acked });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('mesh_ack_failed', { message });
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}
