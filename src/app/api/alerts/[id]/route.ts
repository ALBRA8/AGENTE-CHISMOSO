import { NextRequest } from 'next/server';
import { alertRepository, AlertStatus, AlertSeverity, AlertPriority, type Alert } from '@/lib/alerts-server';
import { apiOk, apiBadRequest, apiNotFound, apiServerError } from '@/lib/api-response';
import { authedPATCH } from '@/lib/middleware';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

interface AlertDetailResponse {
  alert: Alert;
}

interface AlertPatchBody {
  severity?: string;
  priority?: string;
  title?: string;
  description?: string;
  recommended_action?: string;
  evidence_summary?: string;
  cooldown_until?: string;
  related_investigation_id?: string;
  status?: string;
}

// ---------------------------------------------------------------------------
// GET /api/alerts/[id]
// ---------------------------------------------------------------------------

/**
 * GET /api/alerts/{id}
 *
 * Returns the full Alert row by id. 404 if not found.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!id) return apiBadRequest('missing_id', { id });

  try {
    const alert = alertRepository.findById(id);
    if (!alert) return apiNotFound('alert_not_found');
    const body: AlertDetailResponse = { alert };
    return apiOk(body);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('alert_lookup_failed', { id, message });
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/alerts/[id]
// ---------------------------------------------------------------------------

/**
 * PATCH /api/alerts/{id}
 *
 * Update mutable fields on an existing alert. Used for severity/priority
 * overrides (operator decides a CRITICAL alert is actually only a HIGH)
 * and for re-titling / re-describing.
 *
 * Status transitions are NOT done here — use POST /api/alerts/{id}/ack
 * and POST /api/alerts/{id}/resolve for those (they enforce lifecycle
 * invariants and set the accompanying timestamps).
 *
 * Body (all fields optional, only provided fields are updated):
 *   {
 *     severity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
 *     priority?: 'P1' | 'P2' | 'P3' | 'P4',
 *     title?: string,
 *     description?: string,
 *     recommended_action?: string,
 *     evidence_summary?: string,
 *     cooldown_until?: string (ISO),
 *     related_investigation_id?: string
 *   }
 *
 * Returns the updated Alert (full row).
 *
 * §34 / audit C2 — Protected by `authedPATCH`: alert metadata edits mutate
 * operator-facing state. Status transitions are done via the dedicated
 * /ack and /resolve endpoints (also auth-protected).
 */
export const PATCH = authedPATCH(async (
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) => {
  const { id } = await ctx.params;
  if (!id) return apiBadRequest('missing_id', { id });

  let body: AlertPatchBody;
  try {
    body = (await req.json()) as AlertPatchBody;
  } catch {
    return apiBadRequest('invalid_json', { message: 'Expected JSON body' });
  }

  if (body.status) {
    return apiBadRequest(
      'use_ack_or_resolve',
      { message: 'PATCH may not change status directly — use POST /ack or POST /resolve for lifecycle transitions.' },
    );
  }

  try {
    const existing = alertRepository.findById(id);
    if (!existing) return apiNotFound('alert_not_found');

    // Validate enum-typed overrides.
    const extra: Partial<Alert> = {};
    if (body.severity) {
      const u = body.severity.toUpperCase();
      if (!Object.values(AlertSeverity).includes(u as AlertSeverity)) {
        return apiBadRequest('invalid_severity', {
          severity: body.severity,
          valid: Object.values(AlertSeverity),
        });
      }
      extra.severity = u as AlertSeverity;
    }
    if (body.priority) {
      const u = body.priority.toUpperCase();
      if (!Object.values(AlertPriority).includes(u as AlertPriority)) {
        return apiBadRequest('invalid_priority', {
          priority: body.priority,
          valid: Object.values(AlertPriority),
        });
      }
      extra.priority = u as AlertPriority;
    }
    if (body.title !== undefined) extra.title = body.title;
    if (body.description !== undefined) extra.description = body.description;
    if (body.recommended_action !== undefined) extra.recommended_action = body.recommended_action;
    if (body.evidence_summary !== undefined) extra.evidence_summary = body.evidence_summary;
    if (body.cooldown_until !== undefined) extra.cooldown_until = body.cooldown_until;
    if (body.related_investigation_id !== undefined) extra.related_investigation_id = body.related_investigation_id;

    if (Object.keys(extra).length === 0) {
      return apiBadRequest('empty_patch', {
        message: 'No updatable fields provided.',
      });
    }

    // updateStatus with the SAME status as current → no-op transition but
    // applies the extra field updates. The repository's updateStatus does
    // not enforce transition legality — it just sets the columns.
    alertRepository.updateStatus(id, existing.status, extra);

    const updated = alertRepository.findById(id);
    if (!updated) return apiServerError('alert_vanished', { id });
    return apiOk({ alert: updated });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('alert_update_failed', { id, message });
  }
});
