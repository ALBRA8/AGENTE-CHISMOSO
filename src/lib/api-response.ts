import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';

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
 *
 * R2-IMP-SEC (audit H-7 close): for 5xx responses in production, the
 * `details` field is replaced with a sanitized `{ correlationId, message }`
 * envelope. The original `details` (typically containing `e.message`,
 * child-process stderr, absolute file paths, or stack traces) is
 * forwarded to Sentry (when configured) AND logged to stdout with the
 * correlation ID attached, so an operator can grep `correlationId=…` to
 * find the real error. The client never sees the raw `e.message` /
 * stderr. This closes the "stop returning `e.message` and stderr to API
 * clients" half of audit H-7 (the other half — stripping the success-
 * payload `log` field from `/api/investigate` — lives in that route's
 * handler, not here, since `apiOk` deliberately stays free-form).
 *
 * 4xx responses (caller errors) are NOT sanitized — the audit's H-7
 * wording specifically calls out `e.message` and stderr leaks on the
 * 5xx path, and the operational value of returning a structured
 * `{ error: 'Bad Request', details: { code: 'invalid_json' } }` for
 * caller errors outweighs the marginal info leak (a 4xx's `details`
 * are typically field-validation hints the caller already knows).
 */

/** True when the running process is configured for production. */
function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Canonical error response shape: `{ error: string, details?: unknown }`
 * with the given HTTP status code. Use this directly when none of the
 * convenience wrappers (`apiBadRequest`, `apiNotFound`, …) fit.
 *
 * `details` is omitted entirely from the JSON body when `undefined`, so
 * callers that don't need it get a clean `{ error: '…' }` payload.
 *
 * Production sanitization for 5xx (R2-IMP-SEC / audit H-7):
 *   - When `NODE_ENV === 'production'` and `status >= 500`, the
 *     client-facing `details` is replaced with
 *     `{ correlationId: <uuid>, message: 'An internal error occurred. Server logs have the full error details.' }`.
 *   - The original `details` is forwarded to Sentry (when SENTRY_DSN is
 *     configured) AND logged to stdout with `correlationId=…` so the
 *     operator can grep the real error server-side.
 *   - 4xx responses are NOT sanitized — caller-error details are
 *     legitimate operational feedback.
 */
export function apiError(
  status: number,
  error: string,
  details?: unknown,
): NextResponse {
  const isServerError = status >= 500;
  const production = isProduction();

  let clientDetails: unknown = details;
  let correlationId: string | undefined;

  if (isServerError && production) {
    // Mint a correlation ID so the operator can grep the original
    // details from the server logs. randomUUID is CSPRNG-backed.
    correlationId = randomUUID();
    clientDetails = {
      correlationId,
      message: 'An internal error occurred. Server logs have the full error details.',
    };
    // Log the full original error to stdout so the operator can triage.
    // Never include this in the response body.
     
    console.error(
      `[apiServerError] correlationId=${correlationId} error=${error}`,
      { details },
    );
  }

  const body: { error: string; details?: unknown } = { error };
  if (clientDetails !== undefined) body.details = clientDetails;

  // Forward 5xx to Sentry with the ORIGINAL details (server-side only).
  // 4xx are caller errors (not worth reporting).
  if (status >= 500) {
    void import('./sentry')
      .then((m) =>
        m.captureServerError(new Error(error), {
          status,
          // Pass the ORIGINAL details so Sentry has the real error
          // context, even in production where the client sees only
          // the correlationId envelope.
          details,
          correlationId,
        }),
      )
      .catch(() => {
        /* swallow — never let Sentry break the response */
      });
  }
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
 *
 * R2-IMP-SEC (audit H-7): `apiOk` is NOT sanitized here — the success-
 * response shape is the route's responsibility. Routes that leak
 * sensitive fields in their success payloads (e.g. `/api/investigate`
 * previously returned 200 lines of CLI stderr as `log`) must gate
 * those fields on `NODE_ENV !== 'production'` themselves.
 */
export function apiOk(data: object = {}, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

/**
 * 400 Bad Request — caller sent invalid input.
 *
 * Caller-error details are NOT sanitized (the audit's H-7 scope is 5xx).
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
 * Rate-limit metadata (retryAfterSec) is operational data the caller
 * needs to implement backoff — NOT a security leak — so it is preserved
 * in production.
 */
export function apiRateLimited(retryAfterSec: number): NextResponse {
  return NextResponse.json(
    { error: 'Rate limit exceeded', details: { retryAfterSec } },
    { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
  );
}

/**
 * 500 Internal Server Error.
 *
 * R2-IMP-SEC (audit H-7): in production, the `details` field is replaced
 * with `{ correlationId, message }` — the original `details` is logged
 * server-side + forwarded to Sentry but never returned to the client.
 */
export function apiServerError(
  error: string,
  details?: unknown,
): NextResponse {
  return apiError(500, error, details);
}

/**
 * 503 Service Unavailable — provider failed or downstream dependency is down.
 *
 * Sanitized in production the same way as 5xx (audit H-7).
 */
export function apiUnavailable(
  error: string,
  details?: unknown,
): NextResponse {
  return apiError(503, error, details);
}
