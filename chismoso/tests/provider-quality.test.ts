/**
 * Unit tests — Provider Quality Tracker (Task IMP-6, spec §10)
 *
 * Verifies the per-provider rolling metrics maintained by
 * `ProviderQualityTracker`:
 *   - success_rate after a mix of successful + failed calls
 *   - p95 latency from a recorded sample
 *   - degradation detection (success_rate < 0.7 OR duplicate_rate > 0.5)
 *   - the composite health_score weighting
 *
 * Uses an in-memory SQLite DB so each test starts from a clean slate.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChismosoDB } from '../src/db.js';
import {
  ProviderQualityTracker,
  computeP95,
  computeFreshness,
  HEALTH_WEIGHTS,
  DEGRADED_THRESHOLDS,
  type ProviderCallResult,
} from '../src/providers/quality.js';

describe('ProviderQualityTracker', () => {
  let db: ChismosoDB;
  let tracker: ProviderQualityTracker;

  beforeEach(() => {
    db = new ChismosoDB({ path: ':memory:' });
    tracker = new ProviderQualityTracker(db);
  });

  afterEach(() => {
    db.close();
  });

  // Helper: record N successful calls + M failed calls.
  function recordCalls(
    provider: string,
    successful: number,
    failed: number,
    resultOverrides: Partial<ProviderCallResult> = {},
  ): void {
    const successResult: ProviderCallResult = {
      success: true,
      latencyMs: 100,
      signalsReturned: 5,
      duplicateSignals: 0,
      ...resultOverrides,
    };
    const failResult: ProviderCallResult = {
      success: false,
      latencyMs: 100,
      signalsReturned: 0,
      duplicateSignals: 0,
      error: 'simulated_failure',
      ...resultOverrides,
    };
    for (let i = 0; i < successful; i++) tracker.recordCall(provider, successResult);
    for (let i = 0; i < failed; i++) tracker.recordCall(provider, failResult);
  }

  describe('recordCall + getMetrics', () => {
    it('returns null for a provider with no recorded calls', () => {
      expect(tracker.getMetrics('web_search')).toBeNull();
    });

    it('records a single successful call correctly', () => {
      tracker.recordCall('web_search', {
        success: true,
        latencyMs: 250,
        signalsReturned: 10,
        duplicateSignals: 2,
      });
      const m = tracker.getMetrics('web_search');
      expect(m).not.toBeNull();
      expect(m!.total_calls).toBe(1);
      expect(m!.successful_calls).toBe(1);
      expect(m!.failed_calls).toBe(0);
      expect(m!.success_rate).toBeCloseTo(1.0, 2);
      expect(m!.total_signals_returned).toBe(10);
      expect(m!.duplicate_signals).toBe(2);
      expect(m!.duplicate_rate).toBeCloseTo(0.2, 2);
      expect(m!.usable_signal_rate).toBeCloseTo(0.8, 2);
      expect(m!.avg_latency_ms).toBe(250);
      expect(m!.p95_latency_ms).toBe(250);
      expect(m!.last_error).toBeFalsy();
    });

    it('records 10 successful + 2 failed calls → success_rate ≈ 0.83', () => {
      recordCalls('web_search', 10, 2);
      const m = tracker.getMetrics('web_search');
      expect(m).not.toBeNull();
      expect(m!.total_calls).toBe(12);
      expect(m!.successful_calls).toBe(10);
      expect(m!.failed_calls).toBe(2);
      // 10/12 = 0.8333
      expect(m!.success_rate).toBeCloseTo(0.83, 1);
      expect(m!.last_error).toBe('simulated_failure');
      expect(m!.last_failure_at).toBeTruthy();
    });

    it('persists latencies across calls so p95 reflects the full sample', () => {
      const latencies = [100, 200, 150, 5000];
      for (const lat of latencies) {
        tracker.recordCall('web_search', {
          success: true,
          latencyMs: lat,
          signalsReturned: 1,
          duplicateSignals: 0,
        });
      }
      const m = tracker.getMetrics('web_search');
      expect(m).not.toBeNull();
      const sorted = [...latencies].sort((a, b) => a - b);
      const expectedAvg = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
      expect(m!.avg_latency_ms).toBe(expectedAvg);
      // p95 of [100,150,200,5000] with closest-rank: idx = ceil(0.95*4) - 1 = 3 → 5000
      expect(m!.p95_latency_ms).toBe(5000);
    });

    it('caps the latencies ring buffer at 100 entries', () => {
      // Record 150 calls with monotonic latencies 1..150ms.
      for (let i = 1; i <= 150; i++) {
        tracker.recordCall('web_search', {
          success: true,
          latencyMs: i,
          signalsReturned: 0,
          duplicateSignals: 0,
        });
      }
      const m = tracker.getMetrics('web_search');
      expect(m!.total_calls).toBe(150);
      // avg should be the mean of the last 100 latencies (51..150) = 100.5 → 101 (rounded).
      const expectedAvg = Math.round(
        Array.from({ length: 100 }, (_, k) => k + 51).reduce((a, b) => a + b, 0) / 100,
      );
      expect(m!.avg_latency_ms).toBe(expectedAvg);
      // p95 of [51..150] with closest-rank: idx = ceil(0.95 * 100) - 1 = 94 → 51 + 94 = 145
      expect(m!.p95_latency_ms).toBe(145);
    });
  });

  describe('getAllMetrics', () => {
    it('returns empty array when no providers have been recorded', () => {
      expect(tracker.getAllMetrics()).toEqual([]);
    });

    it('returns metrics for every provider that has been recorded', () => {
      recordCalls('web_search', 2, 0);
      recordCalls('reddit_communities', 1, 1);
      const all = tracker.getAllMetrics();
      expect(all.length).toBe(2);
      const names = all.map((m) => m.provider_name);
      expect(names).toContain('web_search');
      expect(names).toContain('reddit_communities');
    });
  });

  describe('detectDegraded', () => {
    it('returns empty array when no providers have been recorded', () => {
      expect(tracker.detectDegraded()).toEqual([]);
    });

    it('flags a provider with success_rate < 0.7 as degraded', () => {
      // 5 successful, 5 failed → success_rate = 0.5
      recordCalls('web_search', 5, 5);
      const degraded = tracker.detectDegraded();
      expect(degraded.length).toBe(1);
      expect(degraded[0].provider_name).toBe('web_search');
      expect(degraded[0].success_rate).toBeCloseTo(0.5, 1);
    });

    it('does NOT flag a provider with success_rate >= 0.7 and duplicate_rate <= 0.5', () => {
      // 9 successful, 1 failed → success_rate = 0.9, duplicate_rate = 0
      recordCalls('web_search', 9, 1);
      expect(tracker.detectDegraded()).toEqual([]);
    });

    it('flags a provider with duplicate_rate > 0.5 as degraded (even if all calls succeed)', () => {
      // 10 successful calls, each returning 4 signals of which 3 are duplicates
      // → duplicate_rate = 30/40 = 0.75
      for (let i = 0; i < 10; i++) {
        tracker.recordCall('web_search', {
          success: true,
          latencyMs: 100,
          signalsReturned: 4,
          duplicateSignals: 3,
        });
      }
      const m = tracker.getMetrics('web_search');
      expect(m!.success_rate).toBeCloseTo(1.0, 2);
      expect(m!.duplicate_rate).toBeCloseTo(0.75, 2);
      const degraded = tracker.detectDegraded();
      expect(degraded.length).toBe(1);
      expect(degraded[0].provider_name).toBe('web_search');
    });

    it('flags a provider whose health_score drops below 0.5 even if neither threshold is crossed individually', () => {
      // Construct a scenario where success_rate is just above 0.7 and
      // duplicate_rate is just below 0.5, but the composite health_score
      // is below 0.5 because the latency is enormous (10s+) AND freshness
      // has decayed (last call > 24h ago).
      //
      // 8 successful + 3 failed → success_rate = 8/11 ≈ 0.7273  (> 0.7)
      // signals: 8 calls × 10 signals = 80, duplicates = 8 × 4 = 32
      //   → dup_rate = 32/80 = 0.4  (< 0.5, "just below")
      // usable_rate = (80 - 32) / 80 = 0.6
      // latency: 10_000ms → latency_score = 0
      // freshness: last_call set to > 24h ago → freshness_score = 0
      //
      // health = 0.4 * 0.7273 + 0.2 * 0.6 + 0.2 * 0 + 0.2 * 0
      //        ≈ 0.2909 + 0.12 + 0 + 0
      //        = 0.4109  (< 0.5)
      const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      for (let i = 0; i < 8; i++) {
        tracker.recordCall('web_search', {
          success: true,
          latencyMs: 10_000,
          signalsReturned: 10,
          duplicateSignals: 4,
        });
      }
      for (let i = 0; i < 3; i++) {
        tracker.recordCall('web_search', {
          success: false,
          latencyMs: 10_000,
          signalsReturned: 0,
          duplicateSignals: 0,
          error: 'simulated_failure',
        });
      }
      // Backdate last_call_at so freshness_score becomes 0.
      db.prepare(
        'UPDATE provider_quality SET last_call_at = ? WHERE provider_name = ?',
      ).run(twentyFiveHoursAgo, 'web_search');

      const m = tracker.getMetrics('web_search');
      expect(m!.success_rate).toBeGreaterThan(DEGRADED_THRESHOLDS.successRate);
      expect(m!.duplicate_rate).toBeLessThan(DEGRADED_THRESHOLDS.duplicateRate);
      expect(m!.health_score).toBeLessThan(DEGRADED_THRESHOLDS.healthScore);
      const degraded = tracker.detectDegraded();
      expect(degraded.length).toBe(1);
      expect(degraded[0].provider_name).toBe('web_search');
    });
  });

  describe('health_score weighting', () => {
    it('produces a 1.0 health_score for a perfect provider', () => {
      tracker.recordCall('web_search', {
        success: true,
        latencyMs: 0,
        signalsReturned: 10,
        duplicateSignals: 0,
      });
      const m = tracker.getMetrics('web_search');
      expect(m!.health_score).toBeCloseTo(1.0, 2);
    });

    it('respects the documented weights (sum = 1.0)', () => {
      const sum =
        HEALTH_WEIGHTS.success +
        HEALTH_WEIGHTS.usableSignals +
        HEALTH_WEIGHTS.freshness +
        HEALTH_WEIGHTS.latency;
      expect(sum).toBeCloseTo(1.0, 6);
    });
  });
});

describe('computeP95', () => {
  it('returns 0 for an empty sample', () => {
    expect(computeP95([])).toBe(0);
  });

  it('returns the max for a single-element sample', () => {
    expect(computeP95([42])).toBe(42);
  });

  it('returns the max for a small sample (closest-rank lands on the last element)', () => {
    expect(computeP95([100, 200, 150, 5000])).toBe(5000);
  });

  it('returns the 95th-percentile element for a larger sample', () => {
    // 1..100 → p95 = element at index ceil(0.95 * 100) - 1 = 94 → 95
    const sample = Array.from({ length: 100 }, (_, k) => k + 1);
    expect(computeP95(sample)).toBe(95);
  });

  it('does not mutate the input array', () => {
    const sample = [3, 1, 2];
    const snapshot = [...sample];
    computeP95(sample);
    expect(sample).toEqual(snapshot);
  });
});

describe('computeFreshness', () => {
  it('returns 0 for null/undefined input', () => {
    expect(computeFreshness(null)).toBe(0);
    expect(computeFreshness(undefined)).toBe(0);
  });

  it('returns 0 for an unparseable date string', () => {
    expect(computeFreshness('not-a-date')).toBe(0);
  });

  it('returns 1.0 when last_call_at is within the last hour', () => {
    const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(computeFreshness(recent)).toBe(1);
  });

  it('returns 0.5 when last_call_at is between 1h and 24h ago', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    expect(computeFreshness(twoHoursAgo)).toBe(0.5);
  });

  it('returns 0 when last_call_at is more than 24h ago', () => {
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    expect(computeFreshness(twoDaysAgo)).toBe(0);
  });
});
