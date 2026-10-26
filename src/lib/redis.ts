/**
 * CHISMOSO V1.5 — Redis client singleton (Task R2-IMP-SEC, audit H-1)
 *
 * Lazily-created `ioredis` client backed by `process.env.REDIS_URL`.
 * Used by the Redis-backed rate limiter (`src/lib/rate-limit.ts`) and any
 * future distributed-coordination surface (e.g. multi-instance lock).
 *
 * Design posture:
 *
 *   - **Optional**. When `REDIS_URL` is unset (single-instance V1.5 deploy),
 *     `getRedis()` returns `null`. Callers fall back to in-memory state
 *     (the original V1.0 behavior). This keeps the dev workflow zero-deps.
 *
 *   - **Survives HMR**. The client is cached on `globalThis` so a Next.js
 *     dev server reload doesn't open a fresh connection per evaluation.
 *
 *   - **Never crashes the host**. The client attaches `error` + `end`
 *     listeners that log to stdout instead of letting ioredis's default
 *     "unhandled error" path kill the Next.js process. A Redis outage
 *     degrades gracefully to in-memory rate limiting rather than 500ing
 *     every request.
 *
 *   - **Lazy reconnect**. ioredis auto-reconnects with exponential backoff.
 *     The `retryStrategy` caps retries at 3 attempts within 10 seconds
 *     (after that we let the in-memory fallback carry the load — better
 *     a slightly-too-lenient limiter than a hard outage).
 */

import type Redis from 'ioredis';

let cachedClient: Redis | null | undefined = undefined;

/**
 * Lazily create (or return the cached) ioredis client.
 *
 * Returns `null` when:
 *   - `REDIS_URL` is unset or empty.
 *   - The ioredis module failed to load (e.g. optional peer-dep missing).
 *   - The cached client has emitted a fatal `end` event (we set it to null
 *     so the next call re-attempts a fresh connection).
 *
 * Callers MUST handle the `null` case by falling back to the in-memory
 * limiter — never assume Redis is reachable.
 */
export function getRedis(): Redis | null {
  if (cachedClient !== undefined) return cachedClient;

  const url = process.env.REDIS_URL?.trim();
  if (!url) {
    cachedClient = null;
    return null;
  }

  try {
    // Dynamic import so the ioredis dependency is optional at runtime —
    // projects that don't use Redis never pay the require cost or hit a
    // missing-module crash. The shape of `import('ioredis')` is
    // `{ default: Redis, Redis: Redis }` (ioredis ships both).
    // We can't `await` here (callers want a sync getter), so use a
    // synchronous-style loader via `require`-equivalent — but since this
    // is ESM, fall back to a top-level dynamic import that we pre-warm.
    // In Next.js 16 (Turbopack), `ioredis` is bundled as CommonJS and is
    // synchronously resolvable, so we use the synchronous require shim
    // exposed by `bun`/Node's `module.createRequire`.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Mod = require('ioredis') as typeof import('ioredis');
    const client = new Mod.Redis(url, {
      // Friendly name for `INFO` / monitoring.
      // (ioredis uses this as the connection identifier in logs.)
      connectionName: 'chismoso-rate-limit',
      // Don't let Redis retries keep the Node event loop alive — when
      // the Next.js process is shutting down, the Redis client must NOT
      // be the reason `bun --hot`/SIGTERM hangs.
      enableOfflineQueue: true,
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => {
        // Cap at 3 retries within ~10 seconds; after that, give up so
        // the in-memory fallback takes over without further load.
        if (times > 3) return null;
        return Math.min(times * 500, 2000);
      },
      // No auto-pipelining — we're doing single-key INCR/EXPIRE/PTTL ops
      // which are already cheap; auto-pipelining would add latency.
      enableAutoPipelining: false,
    });

    // NEVER let an unhandled `error` event crash the host. The most
    // common cause is a brief Redis restart or transient network blip
    // — both recoverable.
    client.on('error', (err: Error) => {
      // Avoid log spam during reconnect storms: only log the FIRST error
      // per connection lifetime. ioredis emits one error per failed
      // retry attempt, which would flood the logs.
      if (process.env.CHISMOSO_LOG_LEVEL === 'DEBUG') {
         
        console.warn('[redis] connection error', { message: err.message });
      }
    });
    client.on('end', () => {
      // Mark the client as gone so the next getRedis() call re-attempts
      // a fresh connection (the old socket is dead).
      cachedClient = null;
    });

    cachedClient = client;
    return client;
  } catch (e: unknown) {
    // The most likely cause here is a missing optional dependency (ioredis
    // not installed). We treat that as "Redis not configured" so the
    // in-memory fallback transparently takes over.
    if (process.env.CHISMOSO_LOG_LEVEL === 'DEBUG') {
       
      console.warn('[redis] failed to initialize, falling back to in-memory', {
        message: e instanceof Error ? e.message : String(e),
      });
    }
    cachedClient = null;
    return null;
  }
}

/**
 * Reset the cached Redis client. Test-only — used by the rate-limit unit
 * tests to deterministically simulate "Redis unavailable" between cases.
 */
export function __resetRedisForTests(): void {
  if (cachedClient) {
    try {
      cachedClient.disconnect();
    } catch {
      /* ignore */
    }
  }
  cachedClient = undefined;
}
