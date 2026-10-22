/**
 * GET /api/audit-log — query the append-only audit log (Task IMP-PROD-OBS, P0-5).
 *
 * Query params (all optional, AND-combined):
 *
 *   actor=<string>         — exact actor match (e.g. 'user:alice')
 *   action=<prefix>         — prefix match (e.g. 'alert' matches
 *                              'alert.ack', 'alert.resolve', etc.)
 *   since=<ISO timestamp>   — returns entries with timestamp >= since
 *   limit=<int>             — page size, default 100, capped at 1000
 *
 * Response:
 *   {
 *     entries: AuditEntry[],
 *     total: number,
 *     filter: AuditQueryFilter,
 *     timestamp: ISO string
 *   }
 *
 * Auth required (admin only). When `CHISMOSO_AUTH_ENABLED=true`,
 * callers must supply a valid `X-Chismoso-Agent` header. When auth is
 * disabled (default in dev), the route is open — but in that case the
 * audit log is the only defense, so it still records the request
 * itself (via the authedRoute wrapper).
 *
 * Why authedRoute + not authedGET?
 * ------------------------------
 * `authedRoute` works for ALL HTTP methods. We only export GET, but
 * using authedRoute means a future admin-only POST (e.g. export
 * filtered audit log) would inherit the same auth gate.
 */

import { NextRequest } from 'next/server';
import { apiOk, apiBadRequest } from '@/lib/api-response';
import { authedRoute } from '@/lib/middleware';
import { requireRole } from '@/lib/require-role';
import { queryAudit, countAudit } from '@/lib/audit-log-server';
import type { AuditQueryFilter } from '@/lib/audit-log-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 100;

// ---------------------------------------------------------------------------
// QUERY PARAM PARSING
// ---------------------------------------------------------------------------

function parseFilter(searchParams: URLSearchParams): {
  ok: boolean;
  filter?: AuditQueryFilter;
  error?: string;
} {
  const filter: AuditQueryFilter = {};

  const actor = searchParams.get('actor');
  if (actor) filter.actor = actor;

  const action = searchParams.get('action');
  if (action) filter.action = action;

  const since = searchParams.get('since');
  if (since) {
    // Validate ISO timestamp — the audit_log query is a string
    // comparison so any parseable string works, but rejecting
    // malformed values early gives a cleaner 400 response.
    const parsed = Date.parse(since);
    if (Number.isNaN(parsed)) {
      return {
        ok: false,
        error: `'since' must be a valid ISO 8601 timestamp, got: ${since}`,
      };
    }
    filter.since = new Date(parsed).toISOString();
  }

  const limitStr = searchParams.get('limit');
  if (limitStr) {
    const parsed = Number.parseInt(limitStr, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return {
        ok: false,
        error: `'limit' must be a positive integer, got: ${limitStr}`,
      };
    }
    if (parsed > MAX_LIMIT) {
      return {
        ok: false,
        error: `'limit' must be <= ${MAX_LIMIT}, got: ${parsed}`,
      };
    }
    filter.limit = parsed;
  } else {
    filter.limit = DEFAULT_LIMIT;
  }

  return { ok: true, filter };
}

// ---------------------------------------------------------------------------
// ROUTE
// ---------------------------------------------------------------------------

// R2-IMP-SEC (audit R2-8): the audit log surfaces every operator action
// (login, alert ack, investigation trigger, etc.) and is sensitive — a
// regular operator shouldn't be able to read another operator's audit
// trail. Gate the GET on `role === 'admin'` via the `requireRole`
// wrapper composed inside `authedRoute`. Dev (auth disabled) bypasses
// the gate so the dashboard opens without provisioning an admin user.
export const GET = authedRoute(requireRole('admin')(async (req: NextRequest) => {
  const { ok, filter, error } = parseFilter(req.nextUrl.searchParams);
  if (!ok || !filter) {
    return apiBadRequest('invalid_query', { message: error });
  }

  const entries = queryAudit(filter);
  const total = countAudit(filter);

  return apiOk({
    entries,
    total,
    filter,
    timestamp: new Date().toISOString(),
  });
}));
