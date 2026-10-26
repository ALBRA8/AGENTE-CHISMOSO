/**
 * CHISMOSO V1.5 — Concurrency cap for investigations (REL-P0-003).
 *
 * Why: every `/api/investigate` and `/api/investigate/stream` request
 * spawns a long-running child Node process (`spawn('node', ['dist/cli.js',
 * 'investigate', ...])`) that allocates ~80–150 MB RSS, opens a SQLite
 * writer connection, and makes several LLM calls over 30–60 seconds.
 * Without a global concurrency cap, 50 concurrent users = ~4–7 GB RSS,
 * 50 contending SQLite writers, and OS-level fork storms. The per-IP
 * rate limit (`LIMITS.investigate = 5/min/IP`) does NOT bound global
 * concurrency — a botnet of N IPs can fork N×5 children.
 *
 * This module exports a single `investigateSemaphore` — a counting
 * semaphore that caps concurrent in-flight investigations process-wide.
 * API routes call `acquire()` at the top of the handler; if no slot is
 * available they short-circuit with HTTP 429 + `Retry-After` so the
 * client gets a fast, clear failure instead of a 5-minute hang.
 *
 * Default: `CHISMOSO_MAX_CONCURRENT_INVESTIGATIONS ?? 3`. Three is the
 * safe ceiling on a single-host SQLite deployment (WAL gives us N readers
 * + 1 writer — three children fighting over the writer lock with
 * `busy_timeout=5000` will succeed; ten will not).
 *
 * Module is process-global (Node single-process, single-port). If you
 * ever scale to multiple Next.js instances behind Caddy, move this state
 * to Redis.
 */

/**
 * A counting semaphore. `acquire()` resolves with a `release()` callback
 * when a slot frees up. `available` and `waiting` are exposed for
 * /api/readyz and for observability.
 *
 * Implementation notes:
 *  - Backed by a simple FIFO queue of pending `Promise` resolvers. No
 *    timer, no allocation per tick.
 *  - The semaphore is intentionally NOT unref'd — long-running in-flight
 *    investigations SHOULD keep the Node event loop alive during graceful
 *    shutdown so the `graceful-shutdown.ts` handler can wait for them.
 */
export class Semaphore {
  private current = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {
    if (!Number.isFinite(max) || max < 1) {
      throw new Error(`Semaphore.max must be >= 1, got ${max}`);
    }
  }

  /**
   * Resolves when a slot is available. The returned function MUST be
   * called exactly once when the caller is done (success OR failure) to
   * release the slot back to the next waiter.
   *
   * Usage:
   *   const release = await sem.acquire();
   *   try { ... } finally { release(); }
   */
  async acquire(): Promise<() => void> {
    if (this.current < this.max) {
      this.current++;
      return () => this.release();
    }
    // Queue behind existing waiters — FIFO.
    return new Promise<() => void>((resolve) => {
      this.waiters.push(() => {
        this.current++;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    if (this.current === 0) {
      // Defensive — should never happen if callers behave, but better to
      // drop a spurious release than to crash the Next.js process.
      return;
    }
    this.current--;
    const next = this.waiters.shift();
    if (next) {
      // Hand the freed slot straight to the next waiter. We don't
      // decrement-and-increment — we hand off our slot.
      next();
    }
  }

  /**
   * Slots currently free (0..max). When this hits 0 the API routes
   * return 429 instead of queuing — we'd rather fail fast and let the
   * client retry after a backoff than queue 50 requests behind 3
   * in-flight 5-minute investigations.
   */
  get available(): number {
    return Math.max(0, this.max - this.current);
  }

  /**
   * Number of requests currently blocked in `acquire()`. Exposed for
   * observability — if this number grows over time, the operator should
   * raise CHISMOSO_MAX_CONCURRENT_INVESTIGATIONS (or, better, move to a
   * real job queue).
   */
  get waiting(): number {
    return this.waiters.length;
  }

  get capacity(): number {
    return this.max;
  }

  get inFlight(): number {
    return this.current;
  }
}

/**
 * Process-wide semaphore for `/api/investigate` and `/api/investigate/stream`.
 *
 * Both routes share the same semaphore — they spawn the same child process
 * and contend for the same SQLite writer lock. Treating them as one pool
 * prevents a client from bypassing the cap by using both endpoints at
 * once.
 *
 * Tuning: `CHISMOSO_MAX_CONCURRENT_INVESTIGATIONS` (default 3). On a
 * single-host SQLite deployment the safe range is 1–5. Above that you
 * should be on Postgres.
 */
export const investigateSemaphore = new Semaphore(
  Math.max(1, parseInt(process.env.CHISMOSO_MAX_CONCURRENT_INVESTIGATIONS ?? '3', 10)),
);
