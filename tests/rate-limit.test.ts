import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  rateLimit,
  getClientIP,
  LIMITS,
  __resetRateLimitStoreForTests,
} from '../src/lib/rate-limit';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('rateLimit', () => {
  beforeEach(() => {
    __resetRateLimitStoreForTests();
  });

  it('allows up to maxRequests requests per window', () => {
    const cfg = { windowMs: 60_000, maxRequests: 3 };
    const k = 'key-allows';

    const r1 = rateLimit(k, cfg);
    const r2 = rateLimit(k, cfg);
    const r3 = rateLimit(k, cfg);

    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);
  });

  it('blocks the (N+1)th request in the same window', () => {
    const cfg = { windowMs: 60_000, maxRequests: 2 };
    const k = 'key-block';

    rateLimit(k, cfg);
    rateLimit(k, cfg);
    const r3 = rateLimit(k, cfg);
    expect(r3.allowed).toBe(false);
    expect(r3.remaining).toBe(0);
  });

  it('resets after windowMs elapses', async () => {
    const cfg = { windowMs: 80, maxRequests: 2 };
    const k = 'key-reset-after';

    const r1 = rateLimit(k, cfg);
    const r2 = rateLimit(k, cfg);
    const r3 = rateLimit(k, cfg);
    expect(r1.allowed && r2.allowed).toBe(true);
    expect(r3.allowed).toBe(false);

    await sleep(120);

    const r4 = rateLimit(k, cfg);
    expect(r4.allowed).toBe(true);
    expect(r4.resetAt).toBeGreaterThan(r1.resetAt);
    expect(r4.remaining).toBe(cfg.maxRequests - 1);
  });

  it('isolates keys from each other', () => {
    const cfg = { windowMs: 60_000, maxRequests: 1 };
    const a = rateLimit('userA', cfg);
    const b = rateLimit('userB', cfg);
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
    const a2 = rateLimit('userA', cfg);
    const b2 = rateLimit('userB', cfg);
    expect(a2.allowed).toBe(false);
    expect(b2.allowed).toBe(false);
  });

  it('exposes pre-configured LIMITS for each endpoint family', () => {
    expect(LIMITS.investigate).toEqual({ windowMs: 60_000, maxRequests: 5 });
    expect(LIMITS.stream).toEqual({ windowMs: 60_000, maxRequests: 5 });
    expect(LIMITS.semanticSearch).toEqual({ windowMs: 60_000, maxRequests: 30 });
    expect(LIMITS.meshPost).toEqual({ windowMs: 60_000, maxRequests: 60 });
  });
});

describe('getClientIP', () => {
  const originalTrustProxy = process.env.TRUST_PROXY;

  afterEach(() => {
    // Restore original env state
    if (originalTrustProxy === undefined) {
      delete (process.env as any).TRUST_PROXY;
    } else {
      (process.env as any).TRUST_PROXY = originalTrustProxy;
    }
  });

  describe('without TRUST_PROXY (default — untrusted proxy headers)', () => {
    beforeEach(() => {
      delete (process.env as any).TRUST_PROXY;
    });

    it('returns "unknown" when no proxy headers are present', () => {
      const req = new Request('https://x/');
      expect(getClientIP(req)).toBe('unknown');
    });

    it('returns "unknown" even when x-forwarded-for is present (untrusted)', () => {
      const req = new Request('https://x/', {
        headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' },
      });
      expect(getClientIP(req)).toBe('unknown');
    });

    it('returns "unknown" even when x-real-ip is present (untrusted)', () => {
      const req = new Request('https://x/', {
        headers: { 'x-real-ip': '198.51.100.42' },
      });
      expect(getClientIP(req)).toBe('unknown');
    });
  });

  describe('with TRUST_PROXY=true (behind Caddy/nginx)', () => {
    beforeEach(() => {
      (process.env as any).TRUST_PROXY = 'true';
    });

    it('prefers x-real-ip over x-forwarded-for', () => {
      const req = new Request('https://x/', {
        headers: {
          'x-real-ip': '198.51.100.42',
          'x-forwarded-for': '203.0.113.5, 10.0.0.1',
        },
      });
      expect(getClientIP(req)).toBe('198.51.100.42');
    });

    it('falls back to the LAST x-forwarded-for entry when x-real-ip is absent', () => {
      const req = new Request('https://x/', {
        headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' },
      });
      // Implementation uses the LAST entry (trusted proxy appends actual IP)
      expect(getClientIP(req)).toBe('10.0.0.1');
    });

    it('trims whitespace around x-forwarded-for entries', () => {
      const req = new Request('https://x/', {
        headers: { 'x-forwarded-for': '  203.0.113.7  ,  10.0.0.1  ' },
      });
      const ip = getClientIP(req);
      // No leading/trailing whitespace
      expect(ip).toBe(ip.trim());
    });

    it('returns "unknown" when no proxy headers are present even with TRUST_PROXY', () => {
      const req = new Request('https://x/');
      expect(getClientIP(req)).toBe('unknown');
    });
  });
});
