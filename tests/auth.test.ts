/**
 * Unit tests — Auth middleware (Task IMP-6, spec §34, audit C2)
 *
 * Verifies the shared-secret `X-Chismoso-Agent` auth middleware:
 *
 *   - When auth is DISABLED (default), `checkAuth` always returns ok:true.
 *   - When auth is ENABLED:
 *       - missing header           → ok:false, reason:'missing_header'
 *       - valid token in header    → ok:true
 *       - invalid token in header  → ok:false, reason:'invalid_token'
 *
 * Env vars consumed (read on every call so tests can mutate freely):
 *   - CHISMOSO_AUTH_ENABLED   = 'true' | 'false'
 *   - CHISMOSO_AUTH_HEADER    = header name (default 'X-Chismoso-Agent')
 *   - CHISMOSO_AUTH_TOKENS    = comma-separated SHA-256 hashes of valid tokens
 *
 * Token lifecycle:
 *   - Operators store HASHES (never plaintext) in CHISMOSO_AUTH_TOKENS.
 *   - Clients send the PLAINTEXT token in the X-Chismoso-Agent header.
 *   - The middleware hashes the incoming token (SHA-256) and constant-time
 *     compares against the env-var list.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  checkAuth,
  withAuth,
  hashToken,
  generateToken,
  getAuthConfig,
  AUTH_HEADER_DEFAULT,
} from '../src/lib/auth';
import { apiOk } from '../src/lib/api-response';

const TEST_TOKEN = 'test-token-super-secret-value-1234567890abcdef';
const TEST_TOKEN_HASH = hashToken(TEST_TOKEN);
const ALT_TOKEN = 'a-completely-different-token-value';
const ALT_TOKEN_HASH = hashToken(ALT_TOKEN);

function makeReq(headers: Record<string, string> = {}): NextRequest {
  // NextRequest extends Request — passing a URL + init.headers is enough.
  return new NextRequest('https://chismoso.local/api/test', {
    method: 'POST',
    headers,
  });
}

describe('auth middleware — env wiring', () => {
  beforeEach(() => {
    // Clean slate — no auth env vars set.
    delete process.env.CHISMOSO_AUTH_ENABLED;
    delete process.env.CHISMOSO_AUTH_HEADER;
    delete process.env.CHISMOSO_AUTH_TOKENS;
  });

  afterEach(() => {
    // Restore clean state after each test so leakage is impossible.
    delete process.env.CHISMOSO_AUTH_ENABLED;
    delete process.env.CHISMOSO_AUTH_HEADER;
    delete process.env.CHISMOSO_AUTH_TOKENS;
  });

  describe('checkAuth', () => {
    it('returns ok:true when auth is disabled (default)', () => {
      // No env vars set → enabled=false → all requests pass.
      const req = makeReq({});
      const result = checkAuth(req);
      expect(result.ok).toBe(true);
      expect(result.reason).toBe('auth_disabled');
    });

    it('returns ok:true when CHISMOSO_AUTH_ENABLED is explicitly "false"', () => {
      process.env.CHISMOSO_AUTH_ENABLED = 'false';
      process.env.CHISMOSO_AUTH_TOKENS = TEST_TOKEN_HASH;
      const req = makeReq({});
      const result = checkAuth(req);
      expect(result.ok).toBe(true);
    });

    it('returns ok:false with reason=missing_header when auth is enabled and no header is present', () => {
      process.env.CHISMOSO_AUTH_ENABLED = 'true';
      process.env.CHISMOSO_AUTH_TOKENS = TEST_TOKEN_HASH;
      const req = makeReq({});
      const result = checkAuth(req);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('missing_header');
    });

    it('returns ok:false with reason=missing_header when the header is present but empty', () => {
      process.env.CHISMOSO_AUTH_ENABLED = 'true';
      process.env.CHISMOSO_AUTH_TOKENS = TEST_TOKEN_HASH;
      const req = makeReq({ [AUTH_HEADER_DEFAULT]: '' });
      const result = checkAuth(req);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('missing_header');
    });

    it('returns ok:true when auth is enabled and the header carries the valid plaintext token', () => {
      process.env.CHISMOSO_AUTH_ENABLED = 'true';
      process.env.CHISMOSO_AUTH_TOKENS = TEST_TOKEN_HASH;
      const req = makeReq({ [AUTH_HEADER_DEFAULT]: TEST_TOKEN });
      const result = checkAuth(req);
      expect(result.ok).toBe(true);
    });

    it('returns ok:false with reason=invalid_token when auth is enabled and the header carries an invalid token', () => {
      process.env.CHISMOSO_AUTH_ENABLED = 'true';
      process.env.CHISMOSO_AUTH_TOKENS = TEST_TOKEN_HASH;
      const req = makeReq({ [AUTH_HEADER_DEFAULT]: 'not-the-real-token' });
      const result = checkAuth(req);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('invalid_token');
    });

    it('returns ok:false with reason=invalid_token when auth is enabled and no tokens are configured', () => {
      // Edge case: auth is enabled but CHISMOSO_AUTH_TOKENS is empty.
      // Any request — even one with a non-empty header — must be rejected.
      // (Operators who enable auth without configuring tokens get a fail-closed
      // state by design; the CLI `auth status` command warns about this.)
      process.env.CHISMOSO_AUTH_ENABLED = 'true';
      process.env.CHISMOSO_AUTH_TOKENS = '';
      const req = makeReq({ [AUTH_HEADER_DEFAULT]: 'any-token-at-all' });
      const result = checkAuth(req);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('invalid_token');
    });

    it('accepts any one of the configured tokens (multi-token list)', () => {
      process.env.CHISMOSO_AUTH_ENABLED = 'true';
      // Comma-separated list of hashes.
      process.env.CHISMOSO_AUTH_TOKENS = `${TEST_TOKEN_HASH},${ALT_TOKEN_HASH}`;
      // First token.
      const r1 = checkAuth(makeReq({ [AUTH_HEADER_DEFAULT]: TEST_TOKEN }));
      expect(r1.ok).toBe(true);
      // Second token.
      const r2 = checkAuth(makeReq({ [AUTH_HEADER_DEFAULT]: ALT_TOKEN }));
      expect(r2.ok).toBe(true);
      // A third unknown token still fails.
      const r3 = checkAuth(makeReq({ [AUTH_HEADER_DEFAULT]: 'third-unknown' }));
      expect(r3.ok).toBe(false);
      expect(r3.reason).toBe('invalid_token');
    });

    it('tolerates whitespace around tokens in the env var (operator-friendly parsing)', () => {
      process.env.CHISMOSO_AUTH_ENABLED = 'true';
      process.env.CHISMOSO_AUTH_TOKENS = `  ${TEST_TOKEN_HASH}  ,  ${ALT_TOKEN_HASH}  `;
      const r = checkAuth(makeReq({ [AUTH_HEADER_DEFAULT]: TEST_TOKEN }));
      expect(r.ok).toBe(true);
    });

    it('honours a custom CHISMOSO_AUTH_HEADER name when set', () => {
      process.env.CHISMOSO_AUTH_ENABLED = 'true';
      process.env.CHISMOSO_AUTH_HEADER = 'X-Custom-Agent-Header';
      process.env.CHISMOSO_AUTH_TOKENS = TEST_TOKEN_HASH;
      // Default header → not picked up → missing.
      const r1 = checkAuth(makeReq({ [AUTH_HEADER_DEFAULT]: TEST_TOKEN }));
      expect(r1.ok).toBe(false);
      expect(r1.reason).toBe('missing_header');
      // Custom header → picked up.
      const r2 = checkAuth(makeReq({ 'X-Custom-Agent-Header': TEST_TOKEN }));
      expect(r2.ok).toBe(true);
    });

    it('re-reads env on every call (no module-level caching)', () => {
      // First call: auth disabled.
      const r1 = checkAuth(makeReq({}));
      expect(r1.ok).toBe(true);
      // Flip the env mid-test — the next checkAuth must reflect the change.
      process.env.CHISMOSO_AUTH_ENABLED = 'true';
      process.env.CHISMOSO_AUTH_TOKENS = TEST_TOKEN_HASH;
      const r2 = checkAuth(makeReq({}));
      expect(r2.ok).toBe(false);
      // Flip back.
      process.env.CHISMOSO_AUTH_ENABLED = 'false';
      const r3 = checkAuth(makeReq({}));
      expect(r3.ok).toBe(true);
    });
  });

  describe('withAuth wrapper', () => {
    it('invokes the handler unchanged when auth is disabled', async () => {
      // No env set → auth disabled.
      const handler = vi.fn(async () => apiOk({ ok: true }));
      const wrapped = withAuth(handler);
      const req = makeReq({});
      const res = await wrapped(req, {});
      expect(handler).toHaveBeenCalledTimes(1);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true });
    });

    it('returns a 401 with the canonical error shape when auth is enabled and the header is missing', async () => {
      process.env.CHISMOSO_AUTH_ENABLED = 'true';
      process.env.CHISMOSO_AUTH_TOKENS = TEST_TOKEN_HASH;
      const handler = vi.fn(async () => apiOk({ ok: true }));
      const wrapped = withAuth(handler);
      const req = makeReq({});
      const res = await wrapped(req, {});
      expect(handler).not.toHaveBeenCalled();
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toHaveProperty('error', 'Unauthorized');
      expect(body).toHaveProperty('details');
      expect(body.details).toHaveProperty('reason', 'missing_header');
    });

    it('returns a 401 with reason=invalid_token when the token does not match', async () => {
      process.env.CHISMOSO_AUTH_ENABLED = 'true';
      process.env.CHISMOSO_AUTH_TOKENS = TEST_TOKEN_HASH;
      const handler = vi.fn(async () => apiOk({ ok: true }));
      const wrapped = withAuth(handler);
      const req = makeReq({ [AUTH_HEADER_DEFAULT]: 'wrong-token' });
      const res = await wrapped(req, {});
      expect(handler).not.toHaveBeenCalled();
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('Unauthorized');
      expect(body.details.reason).toBe('invalid_token');
    });

    it('invokes the handler when auth is enabled and the token is valid', async () => {
      process.env.CHISMOSO_AUTH_ENABLED = 'true';
      process.env.CHISMOSO_AUTH_TOKENS = TEST_TOKEN_HASH;
      const handler = vi.fn(async () => apiOk({ ok: true }));
      const wrapped = withAuth(handler);
      const req = makeReq({ [AUTH_HEADER_DEFAULT]: TEST_TOKEN });
      const res = await wrapped(req, {});
      expect(handler).toHaveBeenCalledTimes(1);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true });
    });

    it('forwards ctx to the handler verbatim', async () => {
      // Auth disabled — handler should receive the same ctx object.
      const ctx = { params: Promise.resolve({ id: 'abc' }) };
      const handler = vi.fn(async (_req: NextRequest, _ctx: any) => apiOk({ gotCtx: true }));
      const wrapped = withAuth(handler);
      const req = makeReq({});
      const res = await wrapped(req, ctx);
      expect(handler).toHaveBeenCalledTimes(1);
      // The wrapped handler calls handler(req, ctx) — verify it received ctx
      // by inspecting the spy's call arguments.
      const callArgs = handler.mock.calls[0];
      expect(callArgs[1]).toBe(ctx);
      const body = await res.json();
      expect(body).toEqual({ gotCtx: true });
    });
  });

  describe('getAuthConfig', () => {
    it('reflects the default header name when env is unset', () => {
      delete process.env.CHISMOSO_AUTH_HEADER;
      const cfg = getAuthConfig();
      expect(cfg.headerName).toBe(AUTH_HEADER_DEFAULT);
      expect(cfg.headerName).toBe('X-Chismoso-Agent');
    });

    it('reflects CHISMOSO_AUTH_ENABLED="true" correctly', () => {
      process.env.CHISMOSO_AUTH_ENABLED = 'true';
      const cfg = getAuthConfig();
      expect(cfg.enabled).toBe(true);
    });

    it('treats any non-"true" value as disabled (defensive parsing)', () => {
      // Not "true" → disabled.
      process.env.CHISMOSO_AUTH_ENABLED = 'yes';
      expect(getAuthConfig().enabled).toBe(false);
      process.env.CHISMOSO_AUTH_ENABLED = '1';
      expect(getAuthConfig().enabled).toBe(false);
      process.env.CHISMOSO_AUTH_ENABLED = 'TRUE'; // case-sensitive
      expect(getAuthConfig().enabled).toBe(false);
    });

    it('parses multiple comma-separated tokens', () => {
      process.env.CHISMOSO_AUTH_TOKENS = `${TEST_TOKEN_HASH}, ${ALT_TOKEN_HASH},`;
      const cfg = getAuthConfig();
      // Trailing comma + spaces are filtered out.
      expect(cfg.validTokens).toHaveLength(2);
      expect(cfg.validTokens).toContain(TEST_TOKEN_HASH);
      expect(cfg.validTokens).toContain(ALT_TOKEN_HASH);
    });
  });

  describe('hashToken', () => {
    it('produces a deterministic 64-char hex SHA-256 digest', () => {
      const h = hashToken('hello');
      expect(h).toMatch(/^[0-9a-f]{64}$/);
      // Known SHA-256 of "hello":
      // 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
      expect(h).toBe(
        '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      );
    });

    it('is stable for the same input', () => {
      expect(hashToken(TEST_TOKEN)).toBe(hashToken(TEST_TOKEN));
    });

    it('produces different digests for different inputs', () => {
      expect(hashToken(TEST_TOKEN)).not.toBe(hashToken(ALT_TOKEN));
    });
  });

  describe('generateToken', () => {
    it('returns a plaintext token + its SHA-256 hash', () => {
      const { token, hash } = generateToken();
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(20);
      expect(hash).toBe(hashToken(token));
    });

    it('produces URL-safe base64 tokens (no +, /, or = padding)', () => {
      // Run a handful of generations to be confident about the format.
      for (let i = 0; i < 20; i++) {
        const { token } = generateToken();
        expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(token).not.toContain('+');
        expect(token).not.toContain('/');
        expect(token).not.toContain('=');
      }
    });

    it('produces unique tokens across calls (collision resistance)', () => {
      const seen = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const { token } = generateToken();
        expect(seen.has(token)).toBe(false);
        seen.add(token);
      }
    });

    it('round-trips through checkAuth when the hash is added to the env', () => {
      // Generate a fresh token + hash, then verify the auth middleware accepts it.
      const { token, hash } = generateToken();
      process.env.CHISMOSO_AUTH_ENABLED = 'true';
      process.env.CHISMOSO_AUTH_TOKENS = hash;
      const req = makeReq({ [AUTH_HEADER_DEFAULT]: token });
      const result = checkAuth(req);
      expect(result.ok).toBe(true);
    });
  });
});
