/**
 * CHISMOSO V1.5 — Circuit Breaker (REL-P0-006)
 *
 * Wraps a flaky remote dependency (the LLM, by default) so that when it
 * starts failing repeatedly the circuit OPENS and we fail-fast instead of
 * hammering a degraded dependency with new requests.
 *
 * Lifecycle:
 *
 *   closed    — normal operation. Every call goes through. Failures bump
 *               the failure counter; reaching `failureThreshold` flips
 *               state to OPEN.
 *
 *   open      — calls throw `circuit_breaker_open` immediately without
 *               touching the network. This is the fail-fast path.
 *               After `resetTimeoutMs` the state transitions to HALF_OPEN
 *               on the next call.
 *
 *   half-open — AT MOST ONE probe call is allowed through at a time
 *               (REL2-P1-1 fix). Concurrent callers that arrive while the
 *               probe is in flight throw `circuit_breaker_probe_in_flight`
 *               so they don't stampede the still-degraded dependency. If
 *               the probe succeeds, state flips back to CLOSED and the
 *               failure counter resets. If it fails, state flips back to
 *               OPEN and the reset clock starts over.
 *
 * Tuning (defaults baked into `llmCircuitBreaker` below):
 *   - failureThreshold: 5    — five consecutive failures before opening
 *   - resetTimeoutMs: 60_000 — give the LLM provider 60s to recover before
 *                               we even try a probe request
 *
 * These defaults match the audit recommendation (REL-P0-006). They are
 * deliberately conservative — CHISMOSO's investigation loop makes many
 * LLM calls per request, so opening the circuit on a small number of
 * failures is the right tradeoff (vs. continuing to spam a degraded
 * dependency).
 */

import { logger } from './logger.js';

export type CircuitState = 'closed' | 'open' | 'half-open';

export class CircuitBreakerError extends Error {
  constructor(public readonly breakerName: string) {
    super(`circuit_breaker_open:${breakerName}`);
    this.name = 'CircuitBreakerError';
  }
}

/**
 * Thrown when the breaker is in HALF_OPEN state and a probe is already
 * in flight (REL2-P1-1). The caller's request did NOT touch the network —
 * it was rejected at the breaker gate so the recovering dependency only
 * sees ONE probe request, not N concurrent ones. The caller should treat
 * this the same as `CircuitBreakerError` (fail-fast + retry with backoff).
 */
export class CircuitBreakerProbeInFlightError extends Error {
  constructor(public readonly breakerName: string) {
    super(`circuit_breaker_probe_in_flight:${breakerName}`);
    this.name = 'CircuitBreakerProbeInFlightError';
  }
}

export interface CircuitBreakerOptions {
  name: string;
  failureThreshold: number;
  resetTimeoutMs: number;
}

export class CircuitBreaker {
  private failureCount = 0;
  private lastFailureAt = 0;
  private state: CircuitState = 'closed';
  // REL2-P1-1 — `true` while a half-open probe call is in flight.
  // Concurrent callers that arrive during the probe are rejected with
  // `CircuitBreakerProbeInFlightError` so the still-recovering dependency
  // only sees a single probe (not N concurrent ones that would
  // stampede it back into failure).
  private halfOpenInFlight = false;

  constructor(private readonly opts: CircuitBreakerOptions) {}

  /**
   * Run `fn` through the breaker. Throws `CircuitBreakerError` if the
   * circuit is OPEN; throws `CircuitBreakerProbeInFlightError` if the
   * circuit is HALF_OPEN and a probe is already running; otherwise
   * returns whatever `fn` returns (and throws whatever `fn` throws on
   * failure).
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      const elapsed = Date.now() - this.lastFailureAt;
      if (elapsed > this.opts.resetTimeoutMs) {
        // Transition open -> half-open. We allow ONE probe call through.
        // If it succeeds, we close. If it fails, we re-open and reset the
        // clock.
        this.state = 'half-open';
        this.halfOpenInFlight = true;
        logger.warn('Circuit breaker half-open (probe)', {
          breaker: this.opts.name,
          elapsedMs: elapsed,
        });
      } else {
        // Fail fast — don't even touch the network.
        throw new CircuitBreakerError(this.opts.name);
      }
    } else if (this.state === 'half-open') {
      // REL2-P1-1 — only one probe at a time. If a probe is in flight,
      // fail-fast so concurrent callers don't stampede the still-degraded
      // dependency. Without this guard, 50 concurrent chat requests
      // arriving just as the breaker opens would ALL go through to the
      // (still-recovering) LLM, defeating the breaker's purpose.
      if (this.halfOpenInFlight) {
        throw new CircuitBreakerProbeInFlightError(this.opts.name);
      }
      // We are the probe — claim the slot.
      this.halfOpenInFlight = true;
    }

    try {
      const result = await fn();
      // Success — reset the failure counter and close (whether we were
      // closed or half-open). Only successful calls close the circuit so
      // a single probe succeeding doesn't reset the threshold count if a
      // subsequent failure arrives (half-open -> closed -> failure starts
      // a fresh failureCount).
      if (this.state !== 'closed') {
        logger.info('Circuit breaker closed (recovered)', {
          breaker: this.opts.name,
          previousState: this.state,
        });
      }
      this.failureCount = 0;
      this.state = 'closed';
      this.halfOpenInFlight = false;
      return result;
    } catch (e) {
      this.failureCount++;
      this.lastFailureAt = Date.now();
      // In half-open, ANY failure re-opens the circuit immediately so
      // we don't bleed traffic into a still-degraded dependency.
      if (this.state === 'half-open') {
        this.state = 'open';
        this.halfOpenInFlight = false;
        logger.warn('Circuit breaker re-opened (probe failed)', {
          breaker: this.opts.name,
        });
      } else if (this.failureCount >= this.opts.failureThreshold) {
        this.state = 'open';
        logger.error('Circuit breaker opened (failure threshold reached)', {
          breaker: this.opts.name,
          failureCount: this.failureCount,
          threshold: this.opts.failureThreshold,
        });
      }
      throw e;
    }
  }

  get status(): CircuitState {
    return this.state;
  }

  get failures(): number {
    return this.failureCount;
  }

  /**
   * Test-only / admin escape hatch. Not used in the hot path.
   */
  reset(): void {
    this.failureCount = 0;
    this.lastFailureAt = 0;
    this.state = 'closed';
    this.halfOpenInFlight = false;
  }
}

/**
 * Singleton circuit breaker for the LLM client. Imported by
 * `chismoso/src/orchestrator/llm.ts` so every LLM call goes through it
 * (planner / analyzer / synthesizer / chat / scheduler — all of them).
 *
 * Defaults: 5 consecutive failures → open; 60s reset window → half-open.
 */
export const llmCircuitBreaker = new CircuitBreaker({
  name: 'llm',
  failureThreshold: 5,
  resetTimeoutMs: 60_000,
});
