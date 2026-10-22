/**
 * CHISMOSO V1.5 — Route-handler wrappers (Task IMP-PROD-SEC, audit C-1, C-2, H-2)
 *
 * Tiny wrappers around `withAuth` for the common Next.js App Router patterns:
 *
 *   - `authedPOST(handler)`   — protect a POST handler (session or agent
 *                               token; CSRF enforced for session callers).
 *   - `authedPUT(handler)`    — protect a PUT handler.
 *   - `authedPATCH(handler)`  — protect a PATCH handler.
 *   - `authedDELETE(handler)` — protect a DELETE handler.
 *   - `authedRoute(handler)`  — protect any HTTP method.
 *   - `optionalAuth(handler)` — attach the auth subject to the request
 *                                but never reject (useful for GET
 *                                endpoints that may optionally
 *                                personalize based on caller identity).
 *
 * Auth posture: **fail-closed in production**. In dev (`NODE_ENV !=
 * 'production'`) the default is `enabled=false` so the dashboard opens
 * without setup; set `CHISMOSO_AUTH_ENABLED=true` to test the auth flow
 * locally.
 *
 * CSRF (audit H-2): state-changing methods (POST/PUT/PATCH/DELETE)
 * invoked via a session cookie MUST carry `X-CSRF-Token` matching the
 * user's per-session bound token. Machine callers (X-Chismoso-Agent)
 * are CSRF-exempt (they have no browser origin).
 *
 * See `src/lib/auth.ts::checkAuth` for the full auth logic.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withAuth, checkAuth, type AuthCheckResult, type AuthSubject } from './auth';
import {
  getTraceIdFromHeaders,
  generateTraceId,
  runWithTraceId,
} from './trace-id';

type RouteHandler = (
  req: NextRequest,
  ctx: any,
) => Promise<NextResponse | Response> | NextResponse | Response;

/**
 * Protects a POST handler with auth. Use for write endpoints that mutate
 * server state, spawn expensive jobs, or ingest external data.
 *
 *   export const POST = authedPOST(async (req, ctx) => {
 *     // ... handler body ...
 *     return apiOk({ ... });
 *   });
 */
export function authedPOST(handler: RouteHandler): RouteHandler {
  return withAuth(handler);
}

/**
 * Protects a PUT handler.
 */
export function authedPUT(handler: RouteHandler): RouteHandler {
  return withAuth(handler);
}

/**
 * Protects a PATCH handler.
 */
export function authedPATCH(handler: RouteHandler): RouteHandler {
  return withAuth(handler);
}

/**
 * Protects a DELETE handler.
 */
export function authedDELETE(handler: RouteHandler): RouteHandler {
  return withAuth(handler);
}

/**
 * Generic auth wrapper — works for any HTTP method.
 */
export function authedRoute(handler: RouteHandler): RouteHandler {
  return withAuth(handler);
}

/**
 * Attaches the auth check result to the request (via a non-enumerable
 * property) so the handler can branch on identity, but NEVER rejects the
 * request. Useful for GET endpoints that may optionally personalize the
 * response based on who's calling (e.g. include extra fields for known
 * operators) but should remain open to anonymous readers in V1.
 *
 * The attached result is retrievable via `getAuthStatus(req)`.
 */
export function optionalAuth(handler: RouteHandler): RouteHandler {
  return async (req, ctx) => {
    const result = checkAuth(req);
    (req as any).__authResult = result;
    (req as any).__authSubject = result.subject ?? { kind: 'anonymous' };
    // P0-1 (R2-IMP-OBS): install the AsyncLocalStorage trace-ID scope
    // so any code path inside `handler` (audit-log-server, sentry,
    // the chismoso CLI subprocess env) can call `getCurrentTraceId()`
    // and get the request's trace ID. Same pattern as `withAuth`.
    const traceId = getTraceIdFromHeaders(req.headers) ?? generateTraceId();
    return runWithTraceId(traceId, () => handler(req, ctx));
  };
}

/**
 * Retrieves the auth result attached by `optionalAuth`. Returns
 * `{ ok: true, reason: 'auth_disabled' }` when auth is disabled, or
 * `{ ok: true }` when the caller passed a valid token, or
 * `{ ok: false, reason: '...' }` for anonymous callers when auth is enabled.
 */
export function getAuthStatus(req: NextRequest): AuthCheckResult {
  return (
    (req as any).__authResult ?? {
      ok: false,
      reason: 'not_checked' as const,
    }
  );
}

/**
 * Retrieves the auth subject attached by `optionalAuth` or `withAuth`.
 * Returns `{ kind: 'anonymous' }` when no auth check ran.
 */
export function getAuthSubject(req: NextRequest): AuthSubject {
  return (
    (req as any).__authSubject ?? {
      kind: 'anonymous' as const,
    }
  );
}
