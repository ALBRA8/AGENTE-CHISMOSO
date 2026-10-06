/**
 * Minimal in-process TTL cache (FIX-3, AUDIT-PERF #4).
 *
 * Why: routes like /api/providers spawn a child process per call (~600-1200ms)
 * for data that rarely changes. Caching for 5 min turns the hot path into <1ms.
 *
 * Scope: process-local only (no Redis). Sufficient for Next.js single-instance
 * dev server. For multi-instance prod, swap this for a shared cache.
 *
 * Memory bound: the periodic sweep (every 5 min) drops expired entries. We
 * rely on entries being small JSON payloads — there is no LRU eviction here.
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();

// Periodic cleanup every 5 minutes — `.unref()` so it never keeps the process
// alive on its own (important for graceful Next.js shutdown).
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.expiresAt < now) store.delete(key);
  }
}, 5 * 60 * 1000).unref();

export function getCached<T>(key: string): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    store.delete(key);
    return undefined;
  }
  return entry.value as T;
}

export function setCached<T>(key: string, value: T, ttlMs: number): void {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export function invalidate(key: string): void {
  store.delete(key);
}

/** Drop every entry — used by tests and by admin "flush" endpoints. */
export function invalidateAll(): void {
  store.clear();
}
