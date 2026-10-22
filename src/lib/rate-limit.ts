/**
 * CHISMOSO V1.5 — Rate limiter with Redis + in-memory backends
 * (Task R2-IMP-SEC, audit H-1 + R2-6/M-1)
 *
 * Two backends, picked automatically based on whether Redis is configured:
 *
 *   1. **Redis (preferred)** — sliding-window INCR + EXPIRE against
 *      `process.env.REDIS_URL` via `src/lib/redis.ts`. State persists
 *      across Next.js restarts and is shared across instances, so a
 *      load-balanced pair of Next.js servers sees the same counter.
 *      Available via the async `rateLimitAsync(key, config)` entrypoint
 *      (Redis calls are fundamentally async; we cannot `await` inside a
 *      sync function, so the async surface is separate).
 *
 *   2. **In-memory (fallback)** — plain `Map<string, RateLimitEntry>`
 *      per-process. Used when `REDIS_URL` is unset OR when the Redis
 *      client is unreachable. Available via the original sync
 *      `rateLimit(key, config)` entrypoint AND via the async wrapper
 *      (which transparently falls back).
 *
 * Why two entrypoints instead of one async? The V1.0 sync API is
 * imported by ~10 routes (chat, semantic-search, mesh/events,
 * auth/login, …). Changing the signature to `Promise<...>` would break
 * every caller's `if (!rl.allowed)` check (a Promise is truthy but
 * `rl.allowed` is undefined → always rate-limited). The sync surface is
 * preserved for backward compat; the security-critical routes
 * (`/api/investigate`, `/api/memory`, `/api/mesh/external-signals`) opt
 * into the Redis-backed async limiter.
 *
 * Per-user / per-agent keying (audit H-1 "per-token cap"):
 *   - `getRateLimitKey(req, prefix)` reads the auth subject attached by
 *     `withAuth` and prefers `user:<id>` / `agent:<tokenHash>` over the
 *     IP. Anonymous (unauthenticated) callers fall back to IP. This
 *     means a single compromised user identity can't burst through
 *     N IPs' worth of quota, and one IP running 5 mesh agents can't
 *     consume 5× the per-user budget.
 *
 * XFF trust (audit R2-6 / M-1):
 *   - `getClientIP(req)` ONLY honors `X-Forwarded-For` /
 *     `X-Real-IP` when `process.env.TRUST_PROXY === 'true'`. Otherwise
 *     it returns `'unknown'` (Next.js Request doesn't expose the raw
 *     socket IP, so we can't safely distinguish "direct localhost" from
 *     "spoofed XFF"). This closes the XFF-spoofing vector that let an
 *     attacker prepend `X-Forwarded-For: <random>` to rotate the
 *     perceived client IP per request.
 */

import type { NextRequest } from 'next/server';
import { getRedis } from './redis';
import type { AuthSubject } from './auth';

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

// ---------------------------------------------------------------------------
// IN-MEMORY BACKEND (sync — original V1.0 surface)
// ---------------------------------------------------------------------------

const store = new Map<string, RateLimitEntry>();

// Periodic cleanup every 5 minutes to avoid memory leaks from abandoned keys.
// `.unref()`'d so it never keeps the Node event loop alive.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.resetAt < now) store.delete(key);
  }
}, 5 * 60 * 1000).unref();

/**
 * SYNC in-memory rate limit (original V1.0 entrypoint, unchanged signature).
 *
 * Used by routes that aren't owned by R2-IMP-SEC (chat, semantic-search,
 * mesh/events, auth/login, …). Preserved for backward compat so we don't
 * have to touch those routes — they keep calling
 *   `const rl = rateLimit('chat:' + ip, LIMITS.chat); if (!rl.allowed) ...`
 * without modification.
 *
 * NOTE: this backend does NOT close H-1 (it's per-process and resets on
 * restart). Routes that need the distributed Redis backend must call
 * `rateLimitAsync(...)` instead.
 */
export function rateLimit(
  key: string,
  config: RateLimitConfig,
): RateLimitResult {
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

// ---------------------------------------------------------------------------
// REDIS-BACKED BACKEND (async — closes H-1)
// ---------------------------------------------------------------------------

/**
 * ASYNC distributed rate limit. Sliding-window INCR + EXPIRE pattern:
 *
 *   1. `INCR ratelimit:<key>` — atomic increment on Redis.
 *   2. If the result is 1 (first request in window), `PEXPIRE` the key
 *      with `windowMs` so it auto-expires; otherwise re-read the TTL
 *      to compute the precise resetAt.
 *   3. If `count > maxRequests` → `allowed:false`. Else `allowed:true`.
 *
 * Atomicity: INCR + PEXPIRE are NOT a single transaction, but the worst
 * race is a few extra requests in the first window (no under-counting —
 * INCR is atomic, so a count can never go DOWN). For our 5-60/min limits
 * the imprecision is negligible.
 *
 * Fallback: if Redis is not configured (`REDIS_URL` unset) OR the
 * underlying client threw an error, falls back to the in-memory
 * `rateLimit(...)` sync implementation wrapped in a Promise. This
 * guarantees the limiter ALWAYS returns a verdict, never 500s.
 */
export async function rateLimitAsync(
  key: string,
  config: RateLimitConfig,
): Promise<RateLimitResult> {
  const redis = getRedis();
  if (!redis) {
    // No Redis — transparent in-memory fallback. Wrap in a Promise so
    // the caller's `await rateLimitAsync(...)` keeps working whether
    // Redis is configured or not.
    return rateLimit(key, config);
  }

  const redisKey = `ratelimit:${key}`;
  try {
    // Atomic INCR returns the new count.
    const count = await redis.incr(redisKey);
    let ttlMs: number;
    if (count === 1) {
      // First request in window — seed the TTL so the key expires.
      await redis.pexpire(redisKey, config.windowMs);
      ttlMs = config.windowMs;
    } else {
      // Subsequent request — read the remaining TTL.
      const ttl = await redis.pttl(redisKey);
      // pttl returns -1 (no expiry), -2 (no key). Treat both as
      // "expired" → use the full window as the reset window.
      ttlMs = ttl > 0 ? ttl : config.windowMs;
    }
    const resetAt = Date.now() + ttlMs;
    if (count > config.maxRequests) {
      return { allowed: false, remaining: 0, resetAt };
    }
    return {
      allowed: true,
      remaining: Math.max(0, config.maxRequests - count),
      resetAt,
    };
  } catch {
    // Redis hiccup (network blip, restart). Fall back to in-memory for
    // THIS request so a Redis outage can never 500 a route. The in-memory
    // store has its own per-key state, so the next call may see a
    // different counter — but the safety property holds (each request
    // is rate-limited by SOMETHING, even during a Redis flap).
    return rateLimit(key, config);
  }
}

// ---------------------------------------------------------------------------
// CLIENT IP — TRUSTED PROXY GATING (audit R2-6 / M-1)
// ---------------------------------------------------------------------------

/**
 * Extracts the client IP from a Next.js Request, respecting proxy trust.
 *
 * Posture (audit R2-6 / M-1 close):
 *   - When `process.env.TRUST_PROXY === 'true'`: the request is presumed
 *     to come via a trusted edge proxy (Caddyfile) that sets both
 *     `X-Real-IP` (the actual TCP peer as observed by the proxy) and
 *     appends to `X-Forwarded-For` (the proxy-chain append log). We
 *     prefer `X-Real-IP` (single hop, cannot be spoofed by the client).
 *     When X-Real-IP is absent, we take the LAST entry in XFF (the one
 *     appended by our trusted edge) — earlier entries are client-
 *     supplied and may be spoofed.
 *   - When `TRUST_PROXY` is unset / not 'true': the request is presumed
 *     to come directly from the network, and we MUST NOT honor any
 *     client-supplied IP headers (an attacker can set XFF to anything).
 *     Next.js's Web Request doesn't expose the raw socket address, so
 *     we return `'unknown'`. The rate limiter still applies with the
 *     literal key 'unknown' — that's fine for single-tenant dev where
 *     no proxy is in front.
 *
 * Default: TRUST_PROXY unset → 'unknown'. Production operators MUST
 * set `TRUST_PROXY=true` in `.env.production` if Caddy (or another
 * trusted edge) is in front, otherwise every external client appears
 * as 'unknown' and shares one rate-limit budget.
 */
export function getClientIP(req: Request): string {
  const trustProxy = process.env.TRUST_PROXY === 'true';
  if (trustProxy) {
    // Prefer X-Real-IP — set by Caddy's `header_up X-Real-IP {remote_host}`
    // (or equivalent reverse_proxy header). Single hop, unspoofable by
    // the client (the proxy overwrites whatever the client sent).
    const xrip = req.headers.get('x-real-ip');
    if (xrip && xrip.length > 0) return xrip.trim();

    // Fall back to the LAST X-Forwarded-For entry — our trusted proxy
    // appends the actual peer IP at the end. Earlier entries are
    // client-supplied and may be spoofed.
    const xff = req.headers.get('x-forwarded-for');
    if (xff) {
      const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length > 0) return parts[parts.length - 1];
    }
  }

  // No trusted proxy header to consult OR the operator hasn't opted in
  // to TRUST_PROXY. We can't safely determine the client IP, so we
  // return 'unknown'. The rate limiter uses this as the key suffix —
  // all anonymous-direct clients share a single 'unknown' bucket.
  // For dev (no proxy in front) this is the right behavior: every
  // local curl shares one bucket, which is what you want when iterating
  // on the dashboard. For prod behind Caddy, the operator MUST set
  // TRUST_PROXY=true so the X-Real-IP set by Caddyfile is honored.
  return 'unknown';
}

// ---------------------------------------------------------------------------
// PER-USER / PER-AGENT KEY (audit H-1 "per-token cap")
// ---------------------------------------------------------------------------

/**
 * Build a rate-limit key that prefers the authenticated subject over IP.
 *
 * When `withAuth` has run (i.e. the route is wrapped with `authedPOST`
 * / `authedPUT` / `authedRoute`), the auth subject is attached to the
 * request as `(req as any).__authSubject`. We use it to key the limiter:
 *
 *   - Session cookie caller (operator) → `prefix:user:<user.id>`
 *   - X-Chismoso-Agent caller (machine) → `prefix:agent:<tokenHash[0..12]>`
 *   - Anonymous / dev (auth disabled) → falls back to `prefix:ip:<ip>`
 *
 * Why the truncated tokenHash for agents: a 12-char SHA-256 prefix is
 * ~48 bits of entropy — collision-resistant up to ~16 million tokens,
 * which is orders of magnitude above CHISMOSO's expected agent count.
 * Truncating keeps the Redis key short (key-prefix bloat adds memory +
 * bandwidth on a busy limiter).
 *
 * Note: this reads the auth subject ATTACHED by `withAuth` — it does NOT
 * re-run `checkAuth`. That means it works whether auth is on or off;
 * in the auth-disabled case the subject is `{ kind: 'anonymous' }` and
 * we fall through to IP keying.
 */
export function getRateLimitKey(req: NextRequest, prefix: string): string {
  const subject = (req as unknown as { __authSubject?: AuthSubject }).__authSubject;
  if (subject?.kind === 'user') {
    return `${prefix}:user:${subject.user.id}`;
  }
  if (subject?.kind === 'agent') {
    const th = subject.tokenHash ?? '';
    return `${prefix}:agent:${th.slice(0, 12)}`;
  }
  return `${prefix}:ip:${getClientIP(req)}`;
}

// ---------------------------------------------------------------------------
// PRE-CONFIGURED LIMITERS
// ---------------------------------------------------------------------------

/**
 * Pre-configured limiters per endpoint family.
 *
 *  - investigate   : expensive (spawns a long-running CLI process) — 5/min
 *  - stream        : same as investigate (also spawns the CLI) — 5/min
 *  - semanticSearch: cheap DB read but unbounded queries hurt — 30/min
 *  - meshPost      : external agents pushing signals — 60/min
 */
export const LIMITS = {
  investigate: { windowMs: 60_000, maxRequests: 5 },
  stream: { windowMs: 60_000, maxRequests: 5 },
  semanticSearch: { windowMs: 60_000, maxRequests: 30 },
  meshPost: { windowMs: 60_000, maxRequests: 60 },
} as const;

// ---------------------------------------------------------------------------
// TEST HELPERS
// ---------------------------------------------------------------------------

/**
 * Test-only helper. Clears the in-memory store. NOT used by the Redis
 * backend — Redis state survives between tests (call `__resetRedisForTests`
 * in `src/lib/redis.ts` to reset the client too).
 */
export function __resetRateLimitStoreForTests(): void {
  store.clear();
}
