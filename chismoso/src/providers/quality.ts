/**
 * CHISMOSO V1.0 — Provider Quality Tracker (spec §10, audit B findings)
 *
 * Records per-provider call outcomes (success, latency, signals returned,
 * duplicates) and computes rolling metrics:
 *
 *   - success_rate        (0..1)  — successful_calls / total_calls
 *   - avg_latency_ms      — mean of recorded latencies
 *   - p95_latency_ms      — 95th-percentile latency (ring buffer last 100)
 *   - duplicate_rate      (0..1)  — duplicate_signals / total_signals_returned
 *   - usable_signal_rate  (0..1)  — (total_signals - duplicates) / total
 *   - freshness_score     (0..1)  — 1.0 if called within 1h, 0.5 within 24h, 0 otherwise
 *   - health_score        (0..1)  — composite weighted blend of the above
 *
 * A provider is considered DEGRADED when any of:
 *   - success_rate < 0.7
 *   - duplicate_rate > 0.5
 *   - health_score < 0.5
 *
 * The tracker is wired into each built-in tool (`search_web`,
 * `search_community`, `deepen_content`) via `attachQualityTracker()`
 * in `orchestrator/tools.ts`. After each `provider.search()` the tool
 * calls `tracker.recordCall(providerName, ...)`.
 *
 * The data lives in the `provider_quality` table (SCHEMA_V3 in db.ts).
 * The latencies ring buffer is stored as JSON in `latencies_json` so
 * the p95 computation survives process restarts.
 */

import type { ChismosoDB } from '../db.js';
import { logger } from '../logger.js';
import { nowISO } from '../models.js';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface ProviderQualityMetrics {
  provider_name: string;
  total_calls: number;
  successful_calls: number;
  failed_calls: number;
  success_rate: number;          // 0..1
  avg_latency_ms: number;
  p95_latency_ms: number;
  last_call_at: string;
  last_success_at: string;
  last_failure_at?: string;
  last_error?: string;
  // Signal quality (post-normalization)
  total_signals_returned: number;
  duplicate_signals: number;    // signals that were deduped
  duplicate_rate: number;        // 0..1
  usable_signal_rate: number;    // signals that survived dedup + clustering
  // Freshness
  freshness_score: number;       // 0..1
  // Health composite
  health_score: number;           // 0..1 weighted combination
}

export interface ProviderCallResult {
  success: boolean;
  latencyMs: number;
  signalsReturned: number;
  duplicateSignals: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// CONSTANTS — ring buffer size + degradation thresholds + weights
// ---------------------------------------------------------------------------

const LATENCY_RING_SIZE = 100;

const DEGRADED_SUCCESS_RATE = 0.7;
const DEGRADED_DUPLICATE_RATE = 0.5;
const DEGRADED_HEALTH_SCORE = 0.5;

// Composite health_score weights (sum = 1.0).
const WEIGHTS = {
  success: 0.4,
  usableSignals: 0.2,
  freshness: 0.2,
  latency: 0.2,
};

// ---------------------------------------------------------------------------
// TRACKER
// ---------------------------------------------------------------------------

export class ProviderQualityTracker {
  constructor(private db: ChismosoDB) {}

  /**
   * Records a single provider call result. Idempotent at the row level —
   * uses UPSERT. The latencies ring buffer is appended to (capped at
   * LATENCY_RING_SIZE entries, oldest evicted).
   */
  recordCall(
    providerName: string,
    result: ProviderCallResult,
  ): void {
    const now = nowISO();
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT * FROM provider_quality WHERE provider_name = ?')
        .get(providerName) as ProviderQualityRow | undefined;

      const prev: ProviderQualityRow = row ?? {
        provider_name: providerName,
        total_calls: 0,
        successful_calls: 0,
        failed_calls: 0,
        total_signals_returned: 0,
        duplicate_signals: 0,
        latencies_json: '[]',
        last_call_at: now,
        last_success_at: now,
        last_failure_at: null,
        last_error: null,
        updated_at: now,
      };

      // Update rolling counters.
      const totalCalls = prev.total_calls + 1;
      const successfulCalls = prev.successful_calls + (result.success ? 1 : 0);
      const failedCalls = prev.failed_calls + (result.success ? 0 : 1);
      const totalSignals = prev.total_signals_returned + Math.max(0, result.signalsReturned);
      const duplicateSignals =
        prev.duplicate_signals + Math.max(0, Math.min(result.duplicateSignals, result.signalsReturned));

      // Update latencies ring buffer.
      const latencies = parseLatencies(prev.latencies_json);
      latencies.push(Math.max(0, Math.round(result.latencyMs)));
      while (latencies.length > LATENCY_RING_SIZE) latencies.shift();

      const lastError = result.success ? prev.last_error : (result.error ?? 'unknown_error');
      const lastFailureAt = result.success ? prev.last_failure_at : now;
      const lastSuccessAt = result.success ? now : prev.last_success_at;

      this.db
        .prepare(
          `INSERT INTO provider_quality
             (provider_name, total_calls, successful_calls, failed_calls,
              total_signals_returned, duplicate_signals, latencies_json,
              last_call_at, last_success_at, last_failure_at, last_error, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider_name) DO UPDATE SET
             total_calls            = excluded.total_calls,
             successful_calls       = excluded.successful_calls,
             failed_calls            = excluded.failed_calls,
             total_signals_returned = excluded.total_signals_returned,
             duplicate_signals      = excluded.duplicate_signals,
             latencies_json         = excluded.latencies_json,
             last_call_at           = excluded.last_call_at,
             last_success_at        = excluded.last_success_at,
             last_failure_at        = excluded.last_failure_at,
             last_error             = excluded.last_error,
             updated_at             = excluded.updated_at`,
        )
        .run(
          providerName,
          totalCalls,
          successfulCalls,
          failedCalls,
          totalSignals,
          duplicateSignals,
          JSON.stringify(latencies),
          now,
          lastSuccessAt ?? now,
          lastFailureAt ?? null,
          lastError ?? null,
          now,
        );
    });
    tx();

    logger.debug('ProviderQuality recorded', {
      provider: providerName,
      success: result.success,
      latencyMs: result.latencyMs,
      signalsReturned: result.signalsReturned,
      duplicateSignals: result.duplicateSignals,
    });
  }

  /**
   * Returns the current metrics for a provider, or null if the provider
   * has never been called.
   */
  getMetrics(providerName: string): ProviderQualityMetrics | null {
    const row = this.db
      .prepare('SELECT * FROM provider_quality WHERE provider_name = ?')
      .get(providerName) as ProviderQualityRow | undefined;
    if (!row) return null;
    return rowToMetrics(row);
  }

  /**
   * Returns metrics for every provider that has at least one recorded call.
   */
  getAllMetrics(): ProviderQualityMetrics[] {
    const rows = this.db
      .prepare('SELECT * FROM provider_quality ORDER BY provider_name ASC')
      .all() as ProviderQualityRow[];
    return rows.map(rowToMetrics);
  }

  /**
   * Detects providers whose metrics indicate degradation:
   *   - success_rate < 0.7, OR
   *   - duplicate_rate > 0.5, OR
   *   - health_score < 0.5
   *
   * Providers with zero calls are NOT returned (they have no metrics to
   * judge — that's "unknown", not "degraded").
   */
  detectDegraded(): ProviderQualityMetrics[] {
    return this.getAllMetrics().filter((m) => {
      if (m.total_calls === 0) return false;
      return (
        m.success_rate < DEGRADED_SUCCESS_RATE ||
        m.duplicate_rate > DEGRADED_DUPLICATE_RATE ||
        m.health_score < DEGRADED_HEALTH_SCORE
      );
    });
  }

  /**
   * Composite health_score (0..1) computed from a metrics blob.
   *
   *   health = w_success      * success_rate
   *          + w_usable      * usable_signal_rate
   *          + w_freshness   * freshness_score
   *          + w_latency     * latency_score
   *
   * Where latency_score is 1 - min(1, avg_latency_ms / 10000) — a 10s
   * average gets a 0 latency score; 0ms gets 1.
   */
  private computeHealth(m: Partial<ProviderQualityMetrics>): number {
    const success = m.success_rate ?? 0;
    const usable = m.usable_signal_rate ?? 0;
    const freshness = m.freshness_score ?? 0;
    const avgLatency = m.avg_latency_ms ?? 0;
    const latencyScore = 1 - Math.min(1, avgLatency / 10_000);
    return Number(
      (
        WEIGHTS.success * success +
        WEIGHTS.usableSignals * usable +
        WEIGHTS.freshness * freshness +
        WEIGHTS.latency * latencyScore
      ).toFixed(4),
    );
  }
}

// Expose for tests that want to assert on the composite scoring.
// (Not part of the public API — exported for transparency.)
export const HEALTH_WEIGHTS = WEIGHTS;
export const DEGRADED_THRESHOLDS = {
  successRate: DEGRADED_SUCCESS_RATE,
  duplicateRate: DEGRADED_DUPLICATE_RATE,
  healthScore: DEGRADED_HEALTH_SCORE,
};

// ---------------------------------------------------------------------------
// ROW PARSERS
// ---------------------------------------------------------------------------

interface ProviderQualityRow {
  provider_name: string;
  total_calls: number;
  successful_calls: number;
  failed_calls: number;
  total_signals_returned: number;
  duplicate_signals: number;
  latencies_json: string | null;
  last_call_at: string;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error: string | null;
  updated_at: string;
}

function parseLatencies(json: string | null | undefined): number[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
      .map((n) => Math.max(0, Math.round(n)));
  } catch {
    return [];
  }
}

function rowToMetrics(r: ProviderQualityRow): ProviderQualityMetrics {
  const totalCalls = r.total_calls ?? 0;
  const successfulCalls = r.successful_calls ?? 0;
  const failedCalls = r.failed_calls ?? 0;
  const totalSignals = r.total_signals_returned ?? 0;
  const duplicateSignals = r.duplicate_signals ?? 0;
  const latencies = parseLatencies(r.latencies_json);

  const success_rate = totalCalls > 0 ? successfulCalls / totalCalls : 0;
  const duplicate_rate = totalSignals > 0 ? duplicateSignals / totalSignals : 0;
  const usable_signal_rate = totalSignals > 0 ? Math.max(0, (totalSignals - duplicateSignals) / totalSignals) : 0;

  const avg_latency_ms =
    latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : 0;
  const p95_latency_ms = computeP95(latencies);
  const freshness_score = computeFreshness(r.last_call_at);

  const metrics: ProviderQualityMetrics = {
    provider_name: r.provider_name,
    total_calls: totalCalls,
    successful_calls: successfulCalls,
    failed_calls: failedCalls,
    success_rate: Number(success_rate.toFixed(4)),
    avg_latency_ms,
    p95_latency_ms,
    last_call_at: r.last_call_at,
    last_success_at: r.last_success_at ?? r.last_call_at,
    last_failure_at: r.last_failure_at ?? undefined,
    last_error: r.last_error ?? undefined,
    total_signals_returned: totalSignals,
    duplicate_signals: duplicateSignals,
    duplicate_rate: Number(duplicate_rate.toFixed(4)),
    usable_signal_rate: Number(usable_signal_rate.toFixed(4)),
    freshness_score,
    health_score: 0,
  };

  // Compute the composite health_score using the same formula the class
  // uses internally. (We reproduce it here because the private method
  // can't be called from a free function — same formula, single source
  // of truth maintained by the constants WEIGHTS.)
  const latencyScore = 1 - Math.min(1, avg_latency_ms / 10_000);
  metrics.health_score = Number(
    (
      WEIGHTS.success * success_rate +
      WEIGHTS.usableSignals * usable_signal_rate +
      WEIGHTS.freshness * freshness_score +
      WEIGHTS.latency * latencyScore
    ).toFixed(4),
  );

  return metrics;
}

/**
 * Computes the 95th-percentile latency from a sample.
 *
 *   - Empty array → 0
 *   - Sorts ascending and picks the element at index ceil(0.95 * (n-1))
 *     (closest-rank method).
 *   - For samples with fewer than 20 elements, p95 is dominated by the
 *     max — that's expected and acceptable for V1.
 */
export function computeP95(latencies: number[]): number {
  if (latencies.length === 0) return 0;
  const sorted = [...latencies].sort((a, b) => a - b);
  // closest-rank: index = ceil(0.95 * n) - 1 (clamped to [0, n-1]).
  const n = sorted.length;
  const idx = Math.min(n - 1, Math.max(0, Math.ceil(0.95 * n) - 1));
  return sorted[idx];
}

/**
 * Freshness score (0..1):
 *   - 1.0 if last_call_at is within the last 1 hour
 *   - 0.5 if within the last 24 hours
 *   - 0 otherwise (or if no calls yet)
 */
export function computeFreshness(lastCallAt: string | null | undefined): number {
  if (!lastCallAt) return 0;
  const t = Date.parse(lastCallAt);
  if (!Number.isFinite(t)) return 0;
  const ageMs = Date.now() - t;
  if (ageMs <= 60 * 60 * 1000) return 1;
  if (ageMs <= 24 * 60 * 60 * 1000) return 0.5;
  return 0;
}
