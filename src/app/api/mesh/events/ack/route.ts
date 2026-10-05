import { NextRequest, NextResponse } from 'next/server';
import { openMeshDb, ackEvents } from '../../_mesh-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/mesh/events/ack
 *
 * Marks the given event ids as delivered. Returns the count actually
 * updated (rows that existed and were pending).
 *
 * Body: `{ ids: string[] }`
 * Response: `{ ok: true, acked: number }`
 */
export async function POST(req: NextRequest) {
  let body: { ids?: string[] };
  try {
    body = (await req.json()) as { ids?: string[] };
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const ids = Array.isArray(body?.ids) ? body!.ids!.filter((x): x is string => typeof x === 'string') : [];
  if (ids.length === 0) {
    return NextResponse.json({ ok: true, acked: 0 });
  }
  let db: ReturnType<typeof openMeshDb> | null = null;
  try {
    db = openMeshDb();
    const acked = ackEvents(db, ids);
    return NextResponse.json({ ok: true, acked });
  } catch (e: any) {
    return NextResponse.json(
      { error: 'mesh_ack_failed', message: e?.message ?? String(e) },
      { status: 500 },
    );
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}
