import { NextRequest, NextResponse } from 'next/server';
import { openMeshDb, getMeshConfig, setMeshConfig } from '../_mesh-db';

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
    return NextResponse.json({ enabled: cfg.enabled, subscribers: safeSubs });
  } catch (e: any) {
    return NextResponse.json(
      { error: 'mesh_config_read_failed', message: e?.message ?? String(e) },
      { status: 500 },
    );
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
 * Response: `{ ok: true, enabled, subscribers: number }`
 */
export async function PUT(req: NextRequest) {
  let body: { enabled?: boolean; subscribers?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  if (typeof body?.enabled !== 'boolean') {
    return NextResponse.json(
      { error: 'missing_field', message: 'enabled (boolean) is required' },
      { status: 400 },
    );
  }
  if (!Array.isArray(body.subscribers)) {
    return NextResponse.json(
      { error: 'missing_field', message: 'subscribers (array) is required' },
      { status: 400 },
    );
  }
  // Validate each subscriber entry.
  const subs: Array<{ agentName: string; webhookUrl: string; secret?: string; eventsFilter?: string[] }> = [];
  for (const raw of body.subscribers) {
    const s = raw as any;
    if (typeof s?.agentName !== 'string' || !s.agentName.trim()) {
      return NextResponse.json(
        { error: 'invalid_subscriber', message: 'agentName (string) is required' },
        { status: 400 },
      );
    }
    if (typeof s?.webhookUrl !== 'string' || !/^https?:\/\//i.test(s.webhookUrl)) {
      return NextResponse.json(
        { error: 'invalid_subscriber', message: `webhookUrl must be a valid http(s) URL (agent: ${s.agentName})` },
        { status: 400 },
      );
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
    return NextResponse.json({ ok: true, enabled: body.enabled, subscribers: subs.length });
  } catch (e: any) {
    return NextResponse.json(
      { error: 'mesh_config_write_failed', message: e?.message ?? String(e) },
      { status: 500 },
    );
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}
