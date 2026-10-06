import { NextRequest } from 'next/server';
import { alertRepository } from '@/lib/alerts-server';
import { apiOk, apiBadRequest, apiNotFound, apiServerError } from '@/lib/api-response';
import { authedPOST } from '@/lib/middleware';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

interface AckBody {
  by?: unknown;
}

interface AckResponse {
  alert: ReturnType<typeof alertRepository.findById> extends infer A
    ? Exclude<A, null>
    : never;
}

// ---------------------------------------------------------------------------
// POST /api/alerts/[id]/ack
// ---------------------------------------------------------------------------

/**
 * POST /api/alerts/{id}/ack
 *
 * Marks an alert as acknowledged by the operator (spec §20, §28). An
 * acknowledged alert stays visible but is no longer "fresh" — the
 * dashboard treats ack as "an operator has seen this and is investigating".
 *
 * Path params: `id` — the persisted alert id (`alert_...`).
 * Body (optional): `{ by?: string }` — free-form identifier of the
 *   acknowledger (default `'user'`).
 *
 * Response: `{ alert: Alert }` — the full updated row, including the
 * new `acknowledged_at` timestamp, `acknowledged_by` field, and
 * `status: 'ACKNOWLEDGED'`.
 *
 * §34 / audit C2 — Protected by `authedPOST`: acknowledgement mutates
 * operator-facing state, so anonymous callers must not be able to silence
 * alerts.
 *
 * Returns:
 *   200 — { alert }
 *   400 — missing id in path / invalid body
 *   404 — alert not found
 *   500 — persistence failure
 */
export const POST = authedPOST(async (
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) => {
  const { id } = await ctx.params;
  if (!id) {
    return apiBadRequest('missing_alert_id', {
      message: 'Alert id is required in the path.',
    });
  }

  let body: AckBody = {};
  try {
    const parsed = await req.json();
    if (parsed && typeof parsed === 'object') {
      body = parsed as AckBody;
    }
  } catch {
    // Body is optional — fall through with empty defaults.
  }

  if (body.by !== undefined && typeof body.by !== 'string') {
    return apiBadRequest('invalid_by', {
      message: '`by` must be a string when provided.',
      field: 'by',
    });
  }
  const by = body.by && body.by.trim().length > 0 ? body.by.trim() : 'user';

  try {
    const existing = alertRepository.findById(id);
    if (!existing) return apiNotFound('alert_not_found');

    alertRepository.acknowledge(id, by);

    const updated = alertRepository.findById(id);
    if (!updated) {
      // Extremely unlikely — the row existed a moment ago.
      return apiServerError('alert_vanished', { id });
    }
    const responseBody: AckResponse = { alert: updated };
    return apiOk(responseBody);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('alert_ack_failed', { id, message });
  }
});
