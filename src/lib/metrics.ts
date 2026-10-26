/**
 * CHISMOSO V1.5 — Prometheus metrics registry (Task IMP-PROD-OBS, P0-1).
 *
 * Single source of truth for the metrics exposed at GET /api/metrics.
 *
 * What this module owns
 * --------------------
 *   - One `Registry` (HMR-safe singleton) so we never collide with another
 *     prom-client instance imported by a Next.js plugin AND we survive
 *     Next.js dev HMR + Turbopack's separate middleware/route bundles.
 *   - Default process metrics (heap, GC, event loop, CPU) collected every
 *     5 s by `collectDefaultMetrics`. Prefix `chismoso_` keeps the series
 *     identifiable in a shared Prometheus instance.
 *   - HTTP request counter + duration histogram — populated by
 *     `src/middleware.ts` on every request.
 *   - Domain counters/gauges (investigations, LLM calls, DB connections,
 *     circuit breaker state) — populated by the relevant API routes and
 *     the chismoso runtime.
 *
 * Why a singleton + module-scope counters
 * ---------------------------------------
 * Next.js 16 / Turbopack loads modules SEPARATELY for the middleware
 * bundle and the route-handler bundle. Without the `globalThis` cache:
 *   1. `src/instrumentation.ts` loads metrics.ts → creates Registry +
 *      calls collectDefaultMetrics (registers ~20 default metrics).
 *   2. Middleware loads metrics.ts again → if it created a new Registry,
 *      collectDefaultMetrics would throw "metric already registered"
 *      on the second call (the names collide on the globalThis Registry
 *      if the singleton worked) OR the cumulative state would silently
 *      reset (if the singleton didn't work).
 *
 * The pattern:
 *   - Registry itself is shared via `globalThis.__chismosoRegistry` so
 *     every module-load returns the same instance.
 *   - `collectDefaultMetrics` is guarded by a `__chismosoDefaultMetricsCollected`
 *     flag so it only runs ONCE per process — the default metrics never
 *     change after the first registration.
 *   - Each Counter/Histogram/Gauge is created once per name (via
 *     `register.getSingleMetric(name)` check) — if the metric already
 *     exists (because an earlier module-load created it), we return the
 *     existing instance instead of constructing a new one.
 */

import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
  type Metric,
} from 'prom-client';

// ---------------------------------------------------------------------------
// REGISTRY (HMR + Turbopack-bundle-safe singleton)
// ---------------------------------------------------------------------------

interface GlobalMetricsState {
  __chismosoRegistry?: Registry;
  __chismosoDefaultMetricsCollected?: boolean;
}

const globalForMetrics = globalThis as unknown as GlobalMetricsState;

const register: Registry =
  globalForMetrics.__chismosoRegistry ?? new Registry();

// Always cache the registry — even in production (the standalone server
// can re-evaluate modules too, and the cost of a global flag is zero).
globalForMetrics.__chismosoRegistry = register;

// Collect Node.js process metrics (heap, GC, event loop, CPU, memory).
// Idempotent guard: only the FIRST module-load runs collectDefaultMetrics.
// Subsequent loads (middleware bundle, HMR reload, instrumentation re-run)
// reuse the already-collected metrics instead of re-registering them
// (which prom-client would reject with "metric already registered").
if (!globalForMetrics.__chismosoDefaultMetricsCollected) {
  collectDefaultMetrics({ register, prefix: 'chismoso_' });
  globalForMetrics.__chismosoDefaultMetricsCollected = true;
}

// ---------------------------------------------------------------------------
// COUNTER / HISTOGRAM / GAUGE FACTORY (idempotent)
// ---------------------------------------------------------------------------

/**
 * Returns the existing metric with `name` from the registry, or
 * constructs one using `factory()` if none exists yet.
 *
 * prom-client throws on duplicate registration, so we MUST check
 * `register.getSingleMetric(name)` first. This is the load-bearing
 * helper that makes the module safe to load twice (once per
 * Turbopack bundle).
 */
function getOrCreate<T extends Metric>(
  name: string,
  factory: () => T,
): T {
  const existing = register.getSingleMetric(name);
  if (existing) return existing as T;
  return factory();
}

// ---------------------------------------------------------------------------
// HTTP instrumentation
// ---------------------------------------------------------------------------

export const httpRequestCounter = getOrCreate(
  'chismoso_http_requests_total',
  () =>
    new Counter({
      name: 'chismoso_http_requests_total',
      help: 'Total HTTP requests handled by the Next.js process',
      labelNames: ['method', 'route', 'status'] as const,
      registers: [register],
    }),
);

export const httpDurationHistogram = getOrCreate(
  'chismoso_http_request_duration_seconds',
  () =>
    new Histogram({
      name: 'chismoso_http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'route'] as const,
      buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30],
      registers: [register],
    }),
);

// ---------------------------------------------------------------------------
// Domain — investigations
// ---------------------------------------------------------------------------

export const investigationsCounter = getOrCreate(
  'chismoso_investigations_total',
  () =>
    new Counter({
      name: 'chismoso_investigations_total',
      help: 'Total investigations started (labelled by terminal status)',
      labelNames: ['status'] as const,
      registers: [register],
    }),
);

export const activeInvestigationsGauge = getOrCreate(
  'chismoso_active_investigations',
  () =>
    new Gauge({
      name: 'chismoso_active_investigations',
      help: 'Currently running investigations (incremented on start, decremented on completion)',
      registers: [register],
    }),
);

// ---------------------------------------------------------------------------
// Domain — LLM
// ---------------------------------------------------------------------------

export const llmCallsCounter = getOrCreate(
  'chismoso_llm_calls_total',
  () =>
    new Counter({
      name: 'chismoso_llm_calls_total',
      help: 'Total LLM API calls (labelled by terminal status and circuit breaker state)',
      labelNames: ['status', 'circuit_state'] as const,
      registers: [register],
    }),
);

export const circuitBreakerStateGauge = getOrCreate(
  'chismoso_circuit_breaker_state',
  () =>
    new Gauge({
      name: 'chismoso_circuit_breaker_state',
      help: 'Circuit breaker state (0=closed, 1=half-open, 2=open)',
      labelNames: ['breaker'] as const,
      registers: [register],
    }),
);

// ---------------------------------------------------------------------------
// Domain — DB
// ---------------------------------------------------------------------------

export const dbConnectionsGauge = getOrCreate(
  'chismoso_db_connections',
  () =>
    new Gauge({
      name: 'chismoso_db_connections',
      help: 'Active SQLite connections opened by the Next.js process',
      registers: [register],
    }),
);

// ---------------------------------------------------------------------------
// Domain — audit log
// ---------------------------------------------------------------------------

export const auditLogWritesCounter = getOrCreate(
  'chismoso_audit_log_writes_total',
  () =>
    new Counter({
      name: 'chismoso_audit_log_writes_total',
      help: 'Total audit log rows appended (labelled by action)',
      labelNames: ['action'] as const,
      registers: [register],
    }),
);

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export { register };

/**
 * Convenience helper used by /api/metrics to render the exposition format.
 * Also used by tests / smoke checks via `register.metrics()`.
 */
export async function collectMetrics(): Promise<string> {
  return register.metrics();
}
