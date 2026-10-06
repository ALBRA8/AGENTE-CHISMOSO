import { NextResponse } from 'next/server';

/**
 * Canonical API response helpers for all routes under /api.
 *
 * Goal: every error response from any route has the SAME shape:
 *   { error: string, details?: unknown }
 * accompanied by an appropriate HTTP status code (4xx / 5xx). Success
 * responses are free-form objects returned via `apiOk(...)`.
 *
 * Pre-fix audit (AUDIT-CODE HIGH #4) found 11 routes inventing 4 variants:
 *   - { error }                    (1 route)
 *   - { error, message }           (5 routes)
 *   - { error, details }           (1 route — already spec-compliant)
 *   - 200 OK + { ok: false, ... }  (1 route — wrong status code)
 * After this normalization every error response uses one of the helpers
 * below and conforms to the canonical `{ error, details? }` contract.
 */

/**
 * Canonical error response shape: `{ error: string, details?: unknown }`
 * with the given HTTP status code. Use this directly when none of the
 * convenience wrappers (`apiBadRequest`, `apiNotFound`, …) fit.
 *
 * `details` is omitted entirely from the JSON body when `undefined`, so
 * callers that don't need it get a clean `{ error: '…' }` payload.
 */
export function apiError(
  status: number,
  error: string,
  details?: unknown,
): NextResponse {
  const body: { error: string; details?: unknown } = { error };
  if (details !== undefined) body.details = details;
  return NextResponse.json(body, { status });
}

/**
 * Canonical success response shape: `{ ...data }`.
 *
 * Status 200 by default. Use a different status (e.g. 201 for POST-create)
 * via the second argument.
 *
 * Note: there is no `ok: true` wrapper — the HTTP status code already
 * communicates success. Returning `{ ok: true, ... }` would duplicate
 * information and introduce a shape that downstream consumers would
 * have to special-case.
 *
 * The parameter type is `object` (not `Record<string, unknown>`) so callers
 * can pass named interfaces like `TopicHistoryResponse` without needing an
 * index signature.
 */
export function apiOk(data: object = {}, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

/**
 * 400 Bad Request — caller sent invalid input.
 */
export function apiBadRequest(error: string, details?: unknown): NextResponse {
  return apiError(400, error, details);
}

/**
 * 404 Not Found.
 */
export function apiNotFound(error: string): NextResponse {
  return apiError(404, error);
}

/**
 * 429 Too Many Requests — includes Retry-After header (in seconds).
 *
 * Response body: `{ error: 'Rate limit exceeded', details: { retryAfterSec } }`.
 */
export function apiRateLimited(retryAfterSec: number): NextResponse {
  return NextResponse.json(
    { error: 'Rate limit exceeded', details: { retryAfterSec } },
    { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
  );
}

/**
 * 500 Internal Server Error.
 */
export function apiServerError(
  error: string,
  details?: unknown,
): NextResponse {
  return apiError(500, error, details);
}

/**
 * 503 Service Unavailable — provider failed or downstream dependency is down.
 */
export function apiUnavailable(
  error: string,
  details?: unknown,
): NextResponse {
  return apiError(503, error, details);
}
