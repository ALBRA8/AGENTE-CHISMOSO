import { describe, it, expect, beforeEach } from 'vitest';
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

  it('blocks the (N+1)th request within the window', () => {
    const cfg = { windowMs: 60_000, maxRequests: 2 };
    const k = 'key-blocks';

    rateLimit(k, cfg);
    rateLimit(k, cfg);

    const r3 = rateLimit(k, cfg);
    expect(r3.allowed).toBe(false);
    expect(r3.remaining).toBe(0);
    // resetAt must be in the future (the original window end).
    expect(r3.resetAt).toBeGreaterThan(Date.now());
  });

  it('keeps the same resetAt across the window', () => {
    const cfg = { windowMs: 60_000, maxRequests: 5 };
    const k = 'key-reset-stable';

    const r1 = rateLimit(k, cfg);
    const r2 = rateLimit(k, cfg);
    const r3 = rateLimit(k, cfg);

    expect(r1.resetAt).toBe(r2.resetAt);
    expect(r2.resetAt).toBe(r3.resetAt);
  });

  it('resets after windowMs elapses', async () => {
    const cfg = { windowMs: 80, maxRequests: 2 };
    const k = 'key-reset-after';

    const r1 = rateLimit(k, cfg);
    const r2 = rateLimit(k, cfg);
    const r3 = rateLimit(k, cfg);
    expect(r1.allowed && r2.allowed).toBe(true);
    expect(r3.allowed).toBe(false);

    // Wait for the window to expire (80ms window + small grace).
    await sleep(120);

    const r4 = rateLimit(k, cfg);
    expect(r4.allowed).toBe(true);
    // New window means a fresh resetAt, later than the previous one.
    expect(r4.resetAt).toBeGreaterThan(r1.resetAt);
    expect(r4.remaining).toBe(cfg.maxRequests - 1);
  });

  it('isolates keys from each other', () => {
    const cfg = { windowMs: 60_000, maxRequests: 1 };
    const a = rateLimit('userA', cfg);
    const b = rateLimit('userB', cfg);
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
    // userA second hit must be blocked, userB second hit must be blocked too.
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
  it('extracts the first IP from x-forwarded-for', () => {
    const req = new Request('https://x/', {
      headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' },
    });
    expect(getClientIP(req)).toBe('203.0.113.5');
  });

  it('falls back to x-real-ip when x-forwarded-for is absent', () => {
    const req = new Request('https://x/', {
      headers: { 'x-real-ip': '198.51.100.42' },
    });
    expect(getClientIP(req)).toBe('198.51.100.42');
  });

  it('returns "unknown" when no proxy headers are present', () => {
    const req = new Request('https://x/');
    expect(getClientIP(req)).toBe('unknown');
  });

  it('trims whitespace around the x-forwarded-for entry', () => {
    const req = new Request('https://x/', {
      headers: { 'x-forwarded-for': '  203.0.113.7  , 10.0.0.1' },
    });
    expect(getClientIP(req)).toBe('203.0.113.7');
  });
});
