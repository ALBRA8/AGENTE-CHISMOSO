import { NextRequest } from 'next/server';
import { alertRepository } from '@/lib/alerts-server';
import { apiOk, apiBadRequest, apiNotFound, apiServerError } from '@/lib/api-response';
import { authedPOST } from '@/lib/middleware';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

interface ResolveBody {
  note?: unknown;
}

interface ResolveResponse {
  alert: ReturnType<typeof alertRepository.findById> extends infer A
    ? Exclude<A, null>
    : never;
}

// ---------------------------------------------------------------------------
// POST /api/alerts/[id]/resolve
// ---------------------------------------------------------------------------

/**
 * POST /api/alerts/{id}/resolve
 *
 * Marks an alert as resolved (spec §20, §28). A resolved alert is moved
 * out of the active queue and into the historical view. Resolution may
 * optionally include a free-form note explaining why (false positive,
 * mitigated, wont_fix, etc.).
 *
 * Path params: `id` — the persisted alert id (`alert_...`).
 * Body (optional): `{ note?: string }` — defaults to `'resolved via API'`.
 *
 * Response: `{ alert: Alert }` — the full updated row, including the new
 * `resolved_at` timestamp, `resolution_note`, and `status: 'RESOLVED'`.
 *
 * §34 / audit C2 — Protected by `authedPOST`: resolution mutates alert
 * state and may feed back into the §28 feedback loop (e.g. a `false_positive`
 * resolution should bias the anomaly detector's threshold). Anonymous
 * callers must not be able to silently resolve alerts.
 *
 * Returns:
 *   200 — { alert }
 *   400 — missing id in path / invalid note
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

  let body: ResolveBody = {};
  try {
    const parsed = await req.json();
    if (parsed && typeof parsed === 'object') {
      body = parsed as ResolveBody;
    }
  } catch {
    // Body is optional — fall through with empty defaults.
  }

  if (body.note !== undefined && typeof body.note !== 'string') {
    return apiBadRequest('invalid_note', {
      message: '`note` must be a string when provided.',
      field: 'note',
    });
  }
  const note =
    typeof body.note === 'string' && body.note.trim().length > 0
      ? body.note.trim()
      : 'resolved via API';

  try {
    const existing = alertRepository.findById(id);
    if (!existing) return apiNotFound('alert_not_found');

    alertRepository.resolve(id, note);

    const updated = alertRepository.findById(id);
    if (!updated) {
      return apiServerError('alert_vanished', { id });
    }
    const responseBody: ResolveResponse = { alert: updated };
    return apiOk(responseBody);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('alert_resolve_failed', { id, message });
  }
});
