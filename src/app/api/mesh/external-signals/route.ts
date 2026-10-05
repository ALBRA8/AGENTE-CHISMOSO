import { NextRequest, NextResponse } from 'next/server';
import { openMeshDb, ingestExternalSignal, fetchExternalSignals } from '../_mesh-db';

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
 * Response: `{ ok: true, id: string, received_at: string }`
 */
export async function POST(req: NextRequest) {
  let body: { source_agent?: string; signal_type?: string; payload?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const sourceAgent = (body?.source_agent ?? '').trim();
  const signalType = (body?.signal_type ?? '').trim();
  if (!sourceAgent || !signalType) {
    return NextResponse.json(
      { error: 'missing_fields', message: 'source_agent and signal_type are required' },
      { status: 400 },
    );
  }
  if (sourceAgent.length > 100 || signalType.length > 100) {
    return NextResponse.json(
      { error: 'field_too_long', message: 'source_agent and signal_type must be ≤ 100 chars' },
      { status: 400 },
    );
  }

  let db: ReturnType<typeof openMeshDb> | null = null;
  try {
    db = openMeshDb();
    const result = ingestExternalSignal(db, sourceAgent, signalType, body?.payload);
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    return NextResponse.json(
      { error: 'mesh_signal_ingest_failed', message: e?.message ?? String(e) },
      { status: 500 },
    );
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}

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
    return NextResponse.json({ count: signals.length, signals });
  } catch (e: any) {
    return NextResponse.json(
      { error: 'mesh_signals_query_failed', message: e?.message ?? String(e) },
      { status: 500 },
    );
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}
