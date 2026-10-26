/**
 * CHISMOSO V1.5 — Next.js instrumentation hook (Task IMP-PROD-OBS, P0-3).
 *
 * Runs ONCE per process, before any HTTP request is handled. Used to
 * eagerly initialize:
 *
 *   1. Sentry SDK (when SENTRY_DSN is set).
 *   2. The metrics Registry is created on first import of
 *      `@/lib/metrics` — no action needed here, but importing it
 *      forces the module to load + start collecting default metrics.
 *   3. The graceful-shutdown handler (SIGINT/SIGTERM hooks so the
 *      process drains in-flight requests before exit).
 *
 * See https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
 *
 * IMPORTANT: this file MUST be at `src/instrumentation.ts` (or
 * `instrumentation.ts` at the project root if `srcDir` is false).
 * Next.js looks for it automatically when `instrumentationHook` is
 * enabled (the default in Next.js 16).
 *
 * NOTE: the `register()` export name is REQUIRED by Next.js — do NOT
 * rename it.
 */

export async function register(): Promise<void> {
  // `NEXT_RUNTIME` is 'nodejs' or 'edge'. We only init Sentry + the
  // shutdown hook in the nodejs runtime — the edge runtime doesn't
  // support the uncaughtException / beforeExit hooks Sentry uses.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Defer imports so the edge bundle doesn't pull in `@sentry/node`.
    await import('./lib/sentry').then((m) => m.initSentry());
    // Force-load the metrics module so default process metrics
    // (heap, GC, event loop) are collected from the very first
    // scrape. The import has the side effect of registering the
    // `collectDefaultMetrics` interval.
    await import('./lib/metrics');
    await import('./lib/graceful-shutdown');
  }
}
