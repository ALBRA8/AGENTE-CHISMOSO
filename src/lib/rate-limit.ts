/**
 * In-memory per-IP rate limiter.
 *
 * Design notes:
 *  - Backed by a plain Map keyed by `rateLimitKey` (e.g. `investigate:<ip>`).
 *  - Each entry tracks a counter + resetAt. The first request in a window
 *    seeds the entry; subsequent requests in the same window bump the count.
 *  - The cleanup interval is `.unref()`'d so it never keeps the Node event
 *    loop alive (important for tests and for Next.js dev server shutdown).
 *  - This is intentionally in-memory: it is per-process and will reset on
 *    server restart. That's fine for CHISMOSO's traffic level (low) and
 *    avoids introducing Redis/external state.
 */

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// Periodic cleanup every 5 minutes to avoid memory leaks from abandoned keys.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.resetAt < now) store.delete(key);
  }
}, 5 * 60 * 1000).unref();

export function rateLimit(
  key: string,
  config: RateLimitConfig,
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const existing = store.get(key);
  if (!existing || existing.resetAt < now) {
    store.set(key, { count: 1, resetAt: now + config.windowMs });
    return {
      allowed: true,
      remaining: config.maxRequests - 1,
      resetAt: now + config.windowMs,
    };
  }
  if (existing.count >= config.maxRequests) {
    return { allowed: false, remaining: 0, resetAt: existing.resetAt };
  }
  existing.count++;
  return {
    allowed: true,
    remaining: config.maxRequests - existing.count,
    resetAt: existing.resetAt,
  };
}

/**
 * Extracts the client IP from a Next.js / Web Request.
 *
 * - Tries `x-forwarded-for` (Caddy / most proxies set this).
 * - Falls back to `x-real-ip`.
 * - Returns 'unknown' if neither is present (e.g. direct localhost hits
 *   in dev). Callers should accept this; rate-limiting still applies with
 *   the literal key 'unknown' which is fine for dev.
 */
export function getClientIP(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}

/**
 * Pre-configured limiters per endpoint family.
 *
 *  - investigate   : expensive (spawns a long-running CLI process) — 5/min/IP
 *  - stream        : same as investigate (also spawns the CLI) — 5/min/IP
 *  - semanticSearch: cheap DB read but unbounded queries hurt — 30/min/IP
 *  - meshPost      : external agents pushing signals — 60/min/IP
 */
export const LIMITS = {
  investigate: { windowMs: 60_000, maxRequests: 5 },
  stream: { windowMs: 60_000, maxRequests: 5 },
  semanticSearch: { windowMs: 60_000, maxRequests: 30 },
  meshPost: { windowMs: 60_000, maxRequests: 60 },
} as const;

/**
 * Test-only helper. Not exported through the public surface — only used by
 * the rate-limit unit tests to deterministically reset the in-memory store
 * between cases.
 */
export function __resetRateLimitStoreForTests(): void {
  store.clear();
}
