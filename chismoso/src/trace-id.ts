/**
 * CHISMOSO V1.5 — Trace ID propagation (used by the logger).
 *
 * The chismoso logger reads the active trace ID from this module's
 * AsyncLocalStorage so log lines emitted during a request include
 * `trace_id` automatically.
 *
 * Lifecycle:
 *   1. Next.js middleware (`src/middleware.ts`) generates a UUID
 *      trace_id and runs the request handler inside
 *      `traceIdStorage.run(trace_id, handler)`.
 *   2. /api/investigate spawns the chismoso CLI as a subprocess.
 *      It passes the trace_id via the `CHISMOSO_TRACE_ID` env var
 *      (set in the spawned child's env).
 *   3. The chismoso CLI's entrypoint (`src/index.ts` or `src/cli.ts`)
 *      reads `CHISMOSO_TRACE_ID` and runs the CLI's main function
 *      inside `traceIdStorage.run(trace_id, main)`.
 *
 * The Next.js `src/lib/trace-id.ts` and the chismoso
 * `src/trace-id.ts` BOTH define an AsyncLocalStorage, but they're
 * separate processes — the env var is the bridge.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export const TRACE_ID_ENV = 'CHISMOSO_TRACE_ID';
export const TRACE_ID_HEADER = 'X-Trace-Id';

/**
 * AsyncLocalStorage holding the active trace ID for the current
 * request/handler/CLI invocation. Set by `runWithTraceId`, read by
 * the logger via `getCurrentTraceId`.
 */
export const traceIdStorage = new AsyncLocalStorage<string>();

/**
 * Generates a fresh trace ID (UUID v4, lowercase hex with hyphens).
 */
export function generateTraceId(): string {
  // Use globalThis.crypto — available in Node 19+ and modern browsers.
  // Falls back to a Math.random-based string if unavailable (rare,
  // only in old Node without WebCrypto).
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  // Fallback: timestamp + random — not RFC 4122 but unique enough for
  // log correlation.
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 14);
  return `trace_${ts}${rand}`;
}

/**
 * Returns the trace ID for the current async context, or `undefined`
 * when no scope is active. Called by the logger.
 */
export function getCurrentTraceId(): string | undefined {
  return traceIdStorage.getStore();
}

/**
 * Runs `fn` with `traceId` set as the active trace ID for the
 * duration of the call.
 */
export function runWithTraceId<T>(traceId: string, fn: () => T): T {
  return traceIdStorage.run(traceId, fn);
}

/**
 * Reads the trace ID from the `CHISMOSO_TRACE_ID` env var. Returns
 * `undefined` if unset (so the logger omits the field).
 *
 * Used by the chismoso CLI entrypoint on startup.
 */
export function getTraceIdFromEnv(): string | undefined {
  const v = process.env[TRACE_ID_ENV];
  if (!v) return undefined;
  // Reject anything that isn't URL-safe so a malicious env can't
  // smuggle newlines into the log lines we emit.
  const trimmed = v.trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(trimmed)) return undefined;
  return trimmed;
}
