import { NextRequest } from 'next/server';
import { openMeshDb, ackEvents } from '../../_mesh-db';
import { apiBadRequest, apiOk, apiServerError } from '@/lib/api-response';
import { authedPOST } from '@/lib/middleware';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/mesh/events/ack
 *
 * Marks the given event ids as delivered. Returns the count actually
 * updated (rows that existed and were pending).
 *
 * Body: `{ ids: string[] }`
 * Response: `{ acked: number }`
 *
 * §34 / audit C2 — Protected: mesh event acknowledgement mutates the outbox
 * state, so anonymous callers should not be able to ACK events they did
 * not receive.
 */
export const POST = authedPOST(async (req: NextRequest) => {
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
});
