import { NextRequest } from 'next/server';
import { apiOk, apiBadRequest, apiServerError } from '@/lib/api-response';
import { executionTraceRepository } from '@/lib/execution-trace-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/trace
 *
 * Lists execution traces (most recent first). All filters are optional
 * and AND-combined.
 *
 * Query params:
 *   ?task=investigate|investigate-react|mcp_call|skill_invoke|...
 *   ?status=running|success|failure|timeout
 *   ?related_investigation_id=<id>
 *   ?limit=N (default 20, max 500)
 *
 * Response: { count, traces: ExecutionTrace[] }
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const task = url.searchParams.get('task') ?? undefined;
  const status = url.searchParams.get('status') ?? undefined;
  const relatedInvestigationId = url.searchParams.get('related_investigation_id') ?? undefined;
  const limitRaw = parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, limitRaw) : 20;

  if (status && !['running', 'success', 'failure', 'timeout'].includes(status)) {
    return apiBadRequest(
      `Invalid status="${status}". Valid values: running, success, failure, timeout`,
    );
  }

  try {
    const traces = executionTraceRepository.list({
      task,
      status: status as any,
      related_investigation_id: relatedInvestigationId,
      limit,
    });
    return apiOk({
      count: traces.length,
      traces,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('trace_query_failed', { message });
  }
}
