import { NextRequest } from 'next/server';
import { chismosoDb } from '@/lib/db-chismoso';
import { apiBadRequest, apiNotFound, apiOk, apiServerError } from '@/lib/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface MemoryRow {
  id: string;
  agent_id: string;
  domain: string;
  type: string;
  content: string;
  source: string | null;
  source_type: string | null;
  evidence_id: string | null;
  provenance: string | null;
  confidence: number | null;
  truth_level: string | null;
  relevance: number | null;
  utility: number | null;
  decay_half_life_days: number | null;
  scope: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  last_verified: string;
  related_signal_ids_json: string | null;
  related_topic: string | null;
}

/**
 * GET /api/memory/[id]
 *
 * Returns the full MemoryDV record for a specific memory by id.
 *
 * Response shape: the MemoryRecord object directly (no envelope) on 200,
 * or `{ error: '...' }` on 4xx / 5xx.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id || !/^[\w-]+$/.test(id)) {
    return apiBadRequest('Invalid memory ID');
  }

  try {
    let row: MemoryRow | undefined;
    try {
      row = chismosoDb.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
    } catch {
      // Table missing — chismoso hasn't been run since the MemoryDV feature shipped.
      return apiNotFound('Memory not found (memories table not initialized)');
    }
    if (!row) return apiNotFound('Memory not found');

    const record = {
      id: row.id,
      agent_id: row.agent_id,
      domain: row.domain,
      type: row.type,
      content: row.content,
      source: row.source ?? '',
      source_type: row.source_type ?? undefined,
      evidence_id: row.evidence_id ?? undefined,
      provenance: row.provenance ?? '',
      confidence: row.confidence ?? 0,
      truth_level: row.truth_level ?? 'UNKNOWN',
      relevance: row.relevance ?? 0,
      utility: row.utility ?? 0,
      decay_half_life_days: row.decay_half_life_days ?? 30,
      scope: row.scope ?? 'global',
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_verified: row.last_verified,
      related_signal_ids: row.related_signal_ids_json
        ? safeParseStrings(row.related_signal_ids_json)
        : undefined,
      related_topic: row.related_topic ?? undefined,
    };

    return apiOk(record);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('memory_query_failed', { message, id });
  }
}

function safeParseStrings(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
