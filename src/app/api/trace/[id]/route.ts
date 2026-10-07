import { NextRequest } from 'next/server';
import { apiOk, apiBadRequest, apiNotFound, apiServerError } from '@/lib/api-response';
import { executionTraceRepository } from '@/lib/execution-trace-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/trace/[id]
 *
 * Returns a single execution trace by ID. Trace rows are produced by the
 * CHISMOSO orchestrator (chismoso/src/orchestrator/orchestrator.ts +
 * react.ts) at the start (status='running') and end (status='success' |
 * 'failure') of every investigation.
 *
 * Response shape: the ExecutionTrace object verbatim, including inputs,
 * outputs, tools_used, errors, evidence_ids, related_investigation_id, etc.
 *
 * Errors:
 *   400 — invalid id (must match /^[\w-]+$/)
 *   404 — trace not found
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id || !/^[\w-]+$/.test(id)) {
    return apiBadRequest('Invalid trace ID');
  }

  try {
    const trace = executionTraceRepository.findById(id);
    if (!trace) {
      return apiNotFound(`Trace ${id} not found`);
    }
    return apiOk({ trace });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('trace_query_failed', { message, id });
  }
}
