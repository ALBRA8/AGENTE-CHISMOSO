/**
 * CHISMOSO V1.5 — Sentry server-side integration (Task IMP-PROD-OBS, P0-3).
 *
 * Initializes `@sentry/node` when `SENTRY_DSN` is present in the
 * environment. If absent, this module is a no-op (so dev environments
 * without Sentry configured continue to work).
 *
 * Configuration
 * --------------
 *   SENTRY_DSN          — required to enable Sentry. Without it, this
 *                          module returns immediately.
 *   SENTRY_ENVIRONMENT  — 'production' / 'staging' / 'development'.
 *                          Defaults to NODE_ENV or 'development'.
 *   SENTRY_RELEASE      — git commit hash or release tag. Defaults to
 *                          `process.env.SENTRY_RELEASE` or 'dev'.
 *   SENTRY_TRACES_SAMPLE_RATE — fraction of traces to sample. Default
 *                          1.0 in production, 0.1 otherwise.
 *
 * The Sentry SDK is loaded lazily via `await import('@sentry/node')`
 * so the SDK isn't pulled into the bundle when `SENTRY_DSN` is unset
 * (saves ~150KB on cold start).
 *
 * Used by
 * -------
 *   - `src/instrumentation.ts` — the Next.js instrumentation hook,
 *       which runs once per process before any request is handled.
 *   - `src/lib/api-response.ts` — `apiError()` calls
 *       `captureServerError()` so 5xx responses are reported to Sentry
 *       with the active trace ID attached as a tag.
 */

import { getCurrentTraceId } from '@/lib/trace-id';

// ---------------------------------------------------------------------------
// CONFIG RESOLUTION
// ---------------------------------------------------------------------------

interface SentryConfig {
  dsn?: string;
  environment: string;
  release: string;
  tracesSampleRate: number;
}

function resolveConfig(): SentryConfig {
  const environment =
    process.env.SENTRY_ENVIRONMENT ??
    process.env.NODE_ENV ??
    'development';
  const release = process.env.SENTRY_RELEASE ?? 'dev';
  // 100% traces in prod, 10% in dev/staging — keep dev noise low.
  const tracesSampleRate =
    environment === 'production' ? 1.0 : 0.1;
  return {
    dsn: process.env.SENTRY_DSN,
    environment,
    release,
    tracesSampleRate,
  };
}

// ---------------------------------------------------------------------------
// SDK LAZY LOAD
// ---------------------------------------------------------------------------

type SentryLike = {
  init: (opts: Record<string, unknown>) => void;
  captureException: (e: unknown, ctx?: Record<string, unknown>) => void;
  captureMessage: (
    msg: string,
    level?: string,
    ctx?: Record<string, unknown>,
  ) => void;
};

let sdkPromise: Promise<SentryLike | null> | null = null;
let initialized = false;

async function loadSentry(): Promise<SentryLike | null> {
  const cfg = resolveConfig();
  if (!cfg.dsn) return null;

  if (!initialized) {
    // Lazy-import so the SDK is only loaded when SENTRY_DSN is set.
    // The instrumentation hook awaits this — no per-request cost.
    const sentry = (await import('@sentry/node')) as unknown as SentryLike;
    sentry.init({
      dsn: cfg.dsn,
      environment: cfg.environment,
      release: cfg.release,
      tracesSampleRate: cfg.tracesSampleRate,
      // Don't capture user-supplied strings as PII — the operator can
      // enable this in dev to test, but production should stay opt-in.
      sendDefaultPii: false,
      // Capture unhandled promise rejections + uncaught exceptions.
      // These handlers are installed by the SDK on init.
      integrations: [],
    });
    initialized = true;
  }
  return (await import('@sentry/node')) as unknown as SentryLike;
}

// Kick off initialization eagerly so the SDK is ready by the time the
// first request arrives. This is called from `src/instrumentation.ts`.
export async function initSentry(): Promise<void> {
  if (!sdkPromise) {
    sdkPromise = loadSentry();
  }
  await sdkPromise;
}

// ---------------------------------------------------------------------------
// CAPTURE HELPERS — used by apiError + route handlers
// ---------------------------------------------------------------------------

/**
 * Reports an error to Sentry with the active trace ID attached as a
 * tag. Safe to call when Sentry is not configured (no-op).
 *
 * Use this in route handlers when an unexpected error occurs:
 *
 *   try {
 *     await risky();
 *   } catch (e) {
 *     await captureServerError(e, { route: '/api/foo' });
 *     return apiServerError('internal_error', { message: ... });
 *   }
 */
export async function captureServerError(
  err: unknown,
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    const sdk = await loadSentry();
    if (!sdk) return;
    const traceId = getCurrentTraceId();
    sdk.captureException(err, {
      extra,
      tags: traceId ? { trace_id: traceId } : undefined,
    });
  } catch {
    // Never let Sentry fail and bubble into the request path.
  }
}

/**
 * Reports a free-form message (not an exception). Useful for "this
 * shouldn't happen but did" warnings that aren't exceptions.
 */
export async function captureWarning(
  msg: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    const sdk = await loadSentry();
    if (!sdk) return;
    const traceId = getCurrentTraceId();
    sdk.captureMessage(msg, 'warning', {
      extra,
      tags: traceId ? { trace_id: traceId } : undefined,
    });
  } catch {
    /* swallow */
  }
}
