/**
 * CHISMOSO V1.0 — Middleware helper (spec §34, audit C2)
 *
 * Tiny wrappers around `withAuth` for the common Next.js App Router patterns:
 *
 *   - `authedPOST(handler)`     — protect a POST handler.
 *   - `authedPUT(handler)`      — protect a PUT handler.
 *   - `authedDELETE(handler)`   — protect a DELETE handler.
 *   - `authedRoute(handler)`    — protect any HTTP method.
 *   - `optionalAuth(handler)`   — attach auth result to the request for
 *                                  inspection but never reject (useful for
 *                                  GET endpoints that may optionally
 *                                  personalize based on caller identity).
 *
 * All helpers respect the `CHISMOSO_AUTH_ENABLED` env var. When disabled
 * (the default), the wrapped handler runs without any auth check.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withAuth, checkAuth, type AuthCheckResult } from './auth';

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
    return handler(req, ctx);
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
