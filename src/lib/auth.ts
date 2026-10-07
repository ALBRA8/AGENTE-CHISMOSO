/**
 * CHISMOSO V1.0 — Auth middleware (spec §34, audit C2)
 *
 * Provides shared-secret token authentication for write API endpoints.
 *
 * The token is sent by the client in the `X-Chismoso-Agent` header (configurable
 * via `CHISMOSO_AUTH_HEADER`). The server hashes the incoming token with
 * SHA-256 and compares it against the list of valid token hashes stored in
 * the `CHISMOSO_AUTH_TOKENS` env var (comma-separated).
 *
 * Auth is OPT-IN: when `CHISMOSO_AUTH_ENABLED != 'true'`, all requests are
 * allowed (the default for dev). When enabled, requests without a valid
 * `X-Chismoso-Agent` header receive a 401 with the canonical
 * `{ error, details }` shape.
 *
 * Usage:
 *   import { withAuth } from '@/lib/auth';
 *   export const POST = withAuth(async (req, ctx) => { ... });
 *
 * Or call `checkAuth(req)` directly inside a handler for finer control
 * (e.g. to allow GET through but protect POST).
 */

import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomFillSync } from 'node:crypto';

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

export interface AuthConfig {
  enabled: boolean;
  headerName: string;        // default 'X-Chismoso-Agent'
  validTokens: string[];     // SHA-256 hashes of valid tokens
}

export const AUTH_HEADER_DEFAULT = 'X-Chismoso-Agent';

/**
 * Reads the auth config from env vars on every call (so a `process.env`
 * mutation during tests takes effect without a module reload).
 *
 *   CHISMOSO_AUTH_ENABLED  = 'true' | 'false' (default: 'false')
 *   CHISMOSO_AUTH_HEADER   = header name (default: 'X-Chismoso-Agent')
 *   CHISMOSO_AUTH_TOKENS   = comma-separated SHA-256 hashes of valid tokens
 */
export function getAuthConfig(): AuthConfig {
  const enabled = process.env.CHISMOSO_AUTH_ENABLED === 'true';
  const headerName = process.env.CHISMOSO_AUTH_HEADER ?? AUTH_HEADER_DEFAULT;
  const rawTokens = process.env.CHISMOSO_AUTH_TOKENS ?? '';
  const validTokens = rawTokens
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return { enabled, headerName, validTokens };
}

// ---------------------------------------------------------------------------
// HASHING
// ---------------------------------------------------------------------------

/**
 * SHA-256 hex hash of a token. Used both for the validTokens list (operators
 * store hashes, never plaintext) and for the incoming request token (so we
 * compare hash-to-hash in constant time).
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant-time string compare to avoid timing-side-channel leaks.
 * Returns true iff `a === b` (length-equal + content-equal).
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// CHECK
// ---------------------------------------------------------------------------

export interface AuthCheckResult {
  ok: boolean;
  reason?: 'auth_disabled' | 'missing_header' | 'invalid_token';
}

/**
 * Checks whether the request is authenticated. When auth is disabled
 * (`CHISMOSO_AUTH_ENABLED != 'true'`), returns `{ ok: true }` unconditionally.
 */
export function checkAuth(req: NextRequest): AuthCheckResult {
  const cfg = getAuthConfig();
  if (!cfg.enabled) return { ok: true, reason: 'auth_disabled' };

  const token = req.headers.get(cfg.headerName);
  if (!token || token.length === 0) {
    return { ok: false, reason: 'missing_header' };
  }

  const hashed = hashToken(token);
  // Constant-time compare against each known valid hash.
  for (const valid of cfg.validTokens) {
    if (safeEqual(hashed, valid)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: 'invalid_token' };
}

// ---------------------------------------------------------------------------
// WRAPPER
// ---------------------------------------------------------------------------

type RouteHandler = (
  req: NextRequest,
  ctx: any,
) => Promise<NextResponse | Response> | NextResponse | Response;

/**
 * Wraps a Next.js route handler with auth. If auth is enabled and the
 * request fails the check, returns a 401 with the canonical error shape:
 *   { error: 'Unauthorized', details: { reason: '<reason>' } }
 *
 * When auth is disabled, the handler is invoked unchanged.
 *
 * Works for both App Router route handlers and the older pattern where
 * the handler takes (req, ctx) — `ctx` is forwarded verbatim.
 */
export function withAuth(handler: RouteHandler): RouteHandler {
  return async (req, ctx) => {
    const auth = checkAuth(req);
    if (!auth.ok) {
      return NextResponse.json(
        { error: 'Unauthorized', details: { reason: auth.reason ?? 'unknown' } },
        { status: 401 },
      );
    }
    return handler(req, ctx);
  };
}

/**
 * Generates a fresh random token (32 bytes, URL-safe base64) and its
 * SHA-256 hash. Used by the `chismoso auth token` CLI command.
 *
 * The caller should:
 *   1. Print the plaintext token ONCE (so the operator can hand it to
 *      the agent client).
 *   2. Store the hash in `CHISMOSO_AUTH_TOKENS` (comma-separated).
 */
export function generateToken(): { token: string; hash: string } {
  const bytes = new Uint8Array(32);
  // Use Node's crypto.randomFillSync — available in both Node 18+ and
  // the Next.js runtime. We avoid `globalThis.crypto` to stay portable
  // to older Next.js runtimes that don't expose WebCrypto on `globalThis`.
  randomFillSync(bytes);
  // Convert to URL-safe base64 (no `+/=` so it can sit in a header value
  // without escaping).
  const b64 = Buffer.from(bytes).toString('base64url');
  return { token: b64, hash: hashToken(b64) };
}
