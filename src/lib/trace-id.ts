/**
 * CHISMOSO V1.5 — Trace ID generation + propagation (Task IMP-PROD-OBS, P0-4).
 *
 * Provides a per-request trace ID so the API logs, the chismoso CLI
 * subprocess logs, and any error captured by Sentry can all be joined
 * post-hoc. The header we use is the custom `X-Trace-Id`; if the caller
 * already supplies one (e.g. an upstream gateway) we trust and propagate
 * it. Otherwise we generate a fresh UUID v4.
 *
 * Why not `traceparent` (W3C)?
 * ---------------------------
 * W3C traceparent is `version-traceid-spanid-flags`. The spec mandates a
 * 16-hex-byte traceId. Our logger emits `trace_id` as a string field and
 * Sentry's `tags.trace_id` accepts free-form strings, so a plain UUID is
 * easier to wire through every layer without forcing a 16-byte id
 * (which would mangle the chismoso CLI subprocess env). For V2, when we
 * add OpenTelemetry, this module will become the adapter that converts
 * between OTel traceIds and our `X-Trace-Id` header.
 *
 * AsyncLocalStorage
 * ------------------
 * The chismoso logger (`chismoso/src/logger.ts`) reads the active trace
 * ID out of `traceIdStorage` so that any log line emitted during a
 * request automatically includes `trace_id` without callers having to
 * pass it through. `runWithTraceId` sets the storage for the duration of
 * a unit of work (a request handler, a CLI invocation).
 *
 *   middleware:
 *     const traceId = ensureTraceId(req.headers);
 *     await runWithTraceId(traceId, () => handler(req));
 *
 *   logger:
 *     const tid = traceIdStorage.getStore();
 *     payload.trace_id = tid;   // absent when no request scope is active
 */

import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

export const TRACE_ID_HEADER = 'X-Trace-Id';

/**
 * Environment variable name used to propagate the trace ID across process
 * boundaries (Next.js API route → chismoso CLI subprocess → MCP server).
 * The chismoso logger reads `process.env[TRACE_ID_ENV]` on boot and seeds
 * `traceIdStorage` so log lines emitted by the CLI inherit the parent
 * request's trace ID. Mirror of `chismoso/src/trace-id.ts::TRACE_ID_ENV`.
 */
export const TRACE_ID_ENV = 'CHISMOSO_TRACE_ID';

// ---------------------------------------------------------------------------
// STORAGE
// ---------------------------------------------------------------------------

/**
 * AsyncLocalStorage holding the active trace ID for the current
 * request/handler/CLI invocation. Set by `runWithTraceId`, read by the
 * logger (`getCurrentTraceId`). When no scope is active (background
 * scheduler tick, top-level process code), `getStore()` returns
 * undefined and the logger omits the field.
 */
export const traceIdStorage = new AsyncLocalStorage<string>();

// ---------------------------------------------------------------------------
// GET / SET HEADER
// ---------------------------------------------------------------------------

/**
 * Extracts the trace ID from incoming request headers. Returns
 * `undefined` when the caller did not supply one (so the middleware can
 * generate a fresh UUID).
 */
export function getTraceIdFromHeaders(headers: Headers): string | undefined {
  const raw = headers.get(TRACE_ID_HEADER);
  if (!raw) return undefined;
  // Strip whitespace and reject anything that isn't URL-safe so a
  // malicious header can't smuggle newlines into the log lines we emit.
  const trimmed = raw.trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Writes the trace ID into a response Headers object. Idempotent.
 */
export function setTraceIdHeader(headers: Headers, traceId: string): void {
  headers.set(TRACE_ID_HEADER, traceId);
}

/**
 * Generates a fresh trace ID (UUID v4, lowercase hex with hyphens).
 * Always 36 chars. Cheap (one `randomFillSync` call).
 */
export function generateTraceId(): string {
  return randomUUID();
}

/**
 * Returns the trace ID for the current async context, or `undefined`
 * when no scope is active. Called by the logger.
 */
export function getCurrentTraceId(): string | undefined {
  return traceIdStorage.getStore();
}

/**
 * Runs `fn` with `traceId` set as the active trace ID for the duration
 * of the call. The logger will automatically pick it up via
 * `getCurrentTraceId()`. Any downstream code that uses `runWithTraceId`
 * again will shadow this scope — that's the expected behavior for
 * nested spans (a sub-investigation inherits the parent trace ID until
 * it decides to mint its own).
 */
export function runWithTraceId<T>(traceId: string, fn: () => T): T {
  return traceIdStorage.run(traceId, fn);
}

/**
 * Convenience used by the middleware: returns the trace ID from the
 * request if present, otherwise mints a fresh one.
 */
export function ensureTraceId(headers: Headers): string {
  return getTraceIdFromHeaders(headers) ?? generateTraceId();
}
