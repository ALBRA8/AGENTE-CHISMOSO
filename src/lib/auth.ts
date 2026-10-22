/**
 * CHISMOSO V1.5 — Auth middleware (Task IMP-PROD-SEC, audit C-1, C-2)
 *
 * Two-tier authentication:
 *
 *   1. **Session-based (human operators via the dashboard)** — `POST /api/auth/login`
 *      with `{username, password}` returns a signed JWT in an
 *      `HttpOnly; Secure; SameSite=Strict` cookie, 24h expiry. The session
 *      carries `sub` (user id), `username`, `role`, and `csrf` (the per-user
 *      CSRF token bound to this session).
 *
 *   2. **Shared-secret (machine-to-machine mesh agents)** — the
 *      `X-Chismoso-Agent` header carries a token whose SHA-256 matches one
 *      of the hashes in `CHISMOSO_AUTH_TOKENS`. Machine callers are CSRF-
 *      exempt (they have no browser origin to defend against).
 *
 * Auth posture: **fail-closed by default in production**. When
 * `NODE_ENV=production` and `CHISMOSO_AUTH_ENABLED` is unset, auth is
 * **on**. When auth is on and no tokens / users are configured, every
 * request is rejected. In dev (`NODE_ENV != 'production'`), the default
 * is **off** for convenience — set `CHISMOSO_AUTH_ENABLED=true` to test
 * the auth flow locally.
 *
 * CSRF (audit H-2): every state-changing request (POST/PUT/PATCH/DELETE)
 * from a session-cookie caller MUST include `X-CSRF-Token` matching the
 * session's bound token. Machine callers (X-Chismoso-Agent) are exempt.
 *
 * Original shared-secret design (V1.0) is preserved — see
 * `getAuthConfig`, `checkAgentToken`, `hashToken` — and is still used by
 * the `chismoso auth token` CLI command to provision per-agent tokens.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomFillSync } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {
  findUserById,
  findUserByUsername,
  rotateCsrfToken,
  validateCsrfToken,
  clearCsrfToken,
  safeEqual,
  type ChismosoUser,
} from '@/lib/users-db';
import {
  getTraceIdFromHeaders,
  generateTraceId,
  runWithTraceId,
} from '@/lib/trace-id';

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

export interface AuthConfig {
  /** Whether any auth check runs at all. False ⇒ everything is open. */
  enabled: boolean;
  /** Header used by machine-to-machine callers (default X-Chismoso-Agent). */
  headerName: string;
  /** SHA-256 hashes of valid machine tokens (from CHISMOSO_AUTH_TOKENS env). */
  validTokens: string[];
  /** Secret used to sign session JWTs. */
  sessionSecret: string;
  /** Session TTL in seconds (default 24h). */
  sessionTtlSec: number;
  /** Cookie name carrying the JWT session. */
  cookieName: string;
}

export const AUTH_HEADER_DEFAULT = 'X-Chismoso-Agent';
export const SESSION_COOKIE_DEFAULT = 'chismoso_session';
export const CSRF_HEADER = 'X-CSRF-Token';
export const SESSION_TTL_SEC_DEFAULT = 24 * 60 * 60; // 24h

/**
 * Reads the auth config from env on every call (so a `process.env` mutation
 * during tests takes effect without a module reload).
 *
 *   CHISMOSO_AUTH_ENABLED  = 'true' | 'false'
 *                            Default: 'true' in production, 'false' in dev.
 *   CHISMOSO_AUTH_HEADER   = header name (default: 'X-Chismoso-Agent')
 *   CHISMOSO_AUTH_TOKENS   = comma-separated SHA-256 hashes of valid
 *                            machine tokens (for X-Chismoso-Agent callers)
 *   CHISMOSO_SESSION_SECRET = secret used to sign session JWTs (REQUIRED in
 *                            production; auto-generated in dev per-process)
 *   CHISMOSO_SESSION_TTL   = session TTL in seconds (default: 86400 = 24h)
 *   CHISMOSO_SESSION_COOKIE = cookie name (default: chismoso_session)
 */
export function getAuthConfig(): AuthConfig {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const enabledEnv = process.env.CHISMOSO_AUTH_ENABLED;
  // Fail-closed in production: when the operator hasn't explicitly said
  // CHISMOSO_AUTH_ENABLED=false, default to TRUE in production builds.
  const enabled =
    enabledEnv !== undefined
      ? enabledEnv === 'true'
      : nodeEnv === 'production';

  const headerName = process.env.CHISMOSO_AUTH_HEADER ?? AUTH_HEADER_DEFAULT;
  const rawTokens = process.env.CHISMOSO_AUTH_TOKENS ?? '';
  const validTokens = rawTokens
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  // Session secret — required in production, auto-generated in dev.
  // Priority: CHISMOSO_SESSION_SECRET (legacy alias from V1.5 dev preview)
  //          → CHISMOSO_JWT_SECRET (canonical name from audit IMP-PROD-SEC).
  let sessionSecret =
    process.env.CHISMOSO_SESSION_SECRET ??
    process.env.CHISMOSO_JWT_SECRET ??
    '';
  if (!sessionSecret) {
    if (nodeEnv === 'production') {
      // Fail loud at startup — the request below will reject every call
      // with `no_session_secret` so the operator sees the misconfig fast.
    } else {
      // Dev: derive a per-process secret so login works without setup.
      // Persisted via globalThis to survive HMR.
      const g = globalThis as unknown as { __chismosoDevSessionSecret?: string };
      if (!g.__chismosoDevSessionSecret) {
        const bytes = new Uint8Array(48);
        randomFillSync(bytes);
        g.__chismosoDevSessionSecret = Buffer.from(bytes).toString('base64url');
      }
      sessionSecret = g.__chismosoDevSessionSecret;
    }
  }

  const sessionTtlSec = Number.parseInt(
    process.env.CHISMOSO_SESSION_TTL ?? String(SESSION_TTL_SEC_DEFAULT),
    10,
  );
  const cookieName = process.env.CHISMOSO_SESSION_COOKIE ?? SESSION_COOKIE_DEFAULT;

  return {
    enabled,
    headerName,
    validTokens,
    sessionSecret,
    sessionTtlSec: Number.isFinite(sessionTtlSec) && sessionTtlSec > 0
      ? sessionTtlSec
      : SESSION_TTL_SEC_DEFAULT,
    cookieName,
  };
}

// ---------------------------------------------------------------------------
// TOKEN HASHING (machine tokens — unchanged from V1.0)
// ---------------------------------------------------------------------------

/**
 * SHA-256 hex hash of a token. Used for the validTokens list (operators
 * store hashes, never plaintext) and for the incoming request token (so we
 * compare hash-to-hash in constant time).
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// PASSWORD HASHING (user accounts)
// ---------------------------------------------------------------------------

const BCRYPT_ROUNDS = 12;

/** Hash a plaintext password with bcrypt (cost factor 12). */
export function hashPassword(plaintext: string): string {
  return bcrypt.hashSync(plaintext, BCRYPT_ROUNDS);
}

/** Verify a plaintext password against a bcrypt hash. Constant-time. */
export function verifyPassword(plaintext: string, hash: string): boolean {
  try {
    return bcrypt.compareSync(plaintext, hash);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// SESSION JWT
// ---------------------------------------------------------------------------

export interface SessionClaims {
  sub: string;         // user id
  username: string;
  role: 'operator' | 'admin';
  csrf: string;        // CSRF token bound to this session
  iat: number;         // issued-at (seconds)
  exp: number;         // expiry (seconds)
}

/**
 * Mint a signed session JWT for the given user. Atomically rotates the
 * user's CSRF token and binds it to the session. Returns the encoded JWT
 * and the CSRF token (so the login handler can hand the CSRF token to the
 * client in the response body).
 */
export function createSession(user: ChismosoUser): { jwt: string; csrfToken: string; expiresAt: number } {
  const cfg = getAuthConfig();
  if (!cfg.sessionSecret) {
    throw new Error('CHISMOSO_SESSION_SECRET is not configured');
  }
  const csrfToken = rotateCsrfToken(user.id);
  const now = Math.floor(Date.now() / 1000);
  const exp = now + cfg.sessionTtlSec;
  const claims: SessionClaims = {
    sub: user.id,
    username: user.username,
    role: user.role,
    csrf: csrfToken,
    iat: now,
    exp,
  };
  const token = jwt.sign(claims, cfg.sessionSecret, {
    algorithm: 'HS256',
    // NOTE: do NOT pass `expiresIn` here — we already set `exp` in the
    // payload. `jsonwebtoken` rejects the call when both are present
    // ("Bad options.expiresIn option the payload already has an exp
    // property"). The `exp` claim alone is enough for JWT verification
    // to enforce the 24h expiry.
  });
  return { jwt: token, csrfToken, expiresAt: exp * 1000 };
}

/**
 * Verify a session JWT. Returns the decoded claims if the signature is
 * valid and the token has not expired; otherwise returns null.
 */
export function verifySession(token: string): SessionClaims | null {
  const cfg = getAuthConfig();
  if (!cfg.sessionSecret || token.length === 0) return null;
  try {
    const decoded = jwt.verify(token, cfg.sessionSecret, {
      algorithms: ['HS256'],
    }) as SessionClaims;
    if (typeof decoded.sub !== 'string' || typeof decoded.csrf !== 'string') {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Build the Set-Cookie header value for a session JWT.
 *
 *   HttpOnly  — JS cannot read it (mitigates XSS-driven exfiltration)
 *   Secure    — only sent over HTTPS (no-ops on localhost in dev)
 *   SameSite=Strict — never sent on cross-origin requests (CSRF defense)
 *   Path=/    — covers the whole app
 */
export function buildSessionCookie(jwt: string, expiresAt: number): string {
  const cfg = getAuthConfig();
  const expires = new Date(expiresAt).toUTCString();
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${cfg.cookieName}=${jwt}; HttpOnly${secure}; SameSite=Strict; Path=/; Expires=${expires}`;
}

/**
 * Build a Set-Cookie header that immediately expires the session cookie
 * (used by /api/auth/logout).
 */
export function buildExpiredSessionCookie(): string {
  const cfg = getAuthConfig();
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${cfg.cookieName}=; HttpOnly${secure}; SameSite=Strict; Path=/; Max-Age=0`;
}

/**
 * Extract the session JWT from the request cookie. Returns null if no
 * session cookie is present.
 */
export function getSessionCookie(req: NextRequest): string | null {
  const cfg = getAuthConfig();
  const cookieHeader = req.headers.get('cookie') ?? '';
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (name === cfg.cookieName) return value;
  }
  return null;
}

/**
 * Invalidate the per-user CSRF token (called on logout so a logged-out
 * browser's residual X-CSRF-Token is dead).
 */
export function invalidateSession(userId: string): void {
  clearCsrfToken(userId);
}

// ---------------------------------------------------------------------------
// AUTH CHECK — single entry point
// ---------------------------------------------------------------------------

export type AuthSubject =
  | { kind: 'user'; user: ChismosoUser; claims: SessionClaims }
  | { kind: 'agent'; tokenHash: string }
  | { kind: 'anonymous' };

export interface AuthCheckResult {
  ok: boolean;
  reason?:
    | 'auth_disabled'
    | 'missing_session'
    | 'invalid_session'
    | 'user_not_found'
    | 'missing_header'
    | 'invalid_token'
    | 'no_tokens_configured'
    | 'no_session_secret'
    | 'missing_csrf'
    | 'invalid_csrf';
  subject?: AuthSubject;
}

/**
 * Authenticate a request. Two paths:
 *
 *   1. Session cookie present and valid JWT ⇒ user caller (subject=user).
 *      For state-changing methods, also enforce CSRF.
 *   2. `X-Chismoso-Agent` header present and matches a valid hash ⇒
 *      machine caller (subject=agent). CSRF exempt.
 *
 * When `enabled` is false (dev default), returns `{ ok: true, reason:
 * 'auth_disabled' }` — the original V1.0 behavior — so the dashboard can
 * be opened locally without provisioning users.
 */
export function checkAuth(req: NextRequest, method: string = req.method.toUpperCase()): AuthCheckResult {
  const cfg = getAuthConfig();
  if (!cfg.enabled) return { ok: true, reason: 'auth_disabled', subject: { kind: 'anonymous' } };

  // --- Path 1: session cookie (human operator) ----------------------------
  const sessionJwt = getSessionCookie(req);
  if (sessionJwt) {
    if (!cfg.sessionSecret) {
      return { ok: false, reason: 'no_session_secret' };
    }
    const claims = verifySession(sessionJwt);
    if (!claims) {
      return { ok: false, reason: 'invalid_session' };
    }
    const user = findUserById(claims.sub);
    if (!user) {
      return { ok: false, reason: 'user_not_found' };
    }
    // CSRF enforcement for state-changing methods. The per-user CSRF
    // token is bound to the session — re-validate against the DB so a
    // logged-out browser's residual token is dead.
    if (isStateChanging(method)) {
      const headerToken = req.headers.get(CSRF_HEADER);
      if (!headerToken) {
        return { ok: false, reason: 'missing_csrf' };
      }
      if (!validateCsrfToken(user.id, headerToken)) {
        return { ok: false, reason: 'invalid_csrf' };
      }
    }
    return {
      ok: true,
      subject: { kind: 'user', user, claims },
    };
  }

  // --- Path 2: machine token (X-Chismoso-Agent) --------------------------
  const agentToken = req.headers.get(cfg.headerName);
  if (agentToken && agentToken.length > 0) {
    if (cfg.validTokens.length === 0) {
      // Fail closed — if auth is enabled but no machine tokens are
      // configured, even a header-bearing request is rejected.
      return { ok: false, reason: 'no_tokens_configured' };
    }
    const hashed = hashToken(agentToken);
    for (const valid of cfg.validTokens) {
      if (safeEqual(hashed, valid)) {
        return {
          ok: true,
          subject: { kind: 'agent', tokenHash: hashed },
        };
      }
    }
    return { ok: false, reason: 'invalid_token' };
  }

  // --- No credentials at all ---------------------------------------------
  // Distinguish the reason so a 401 response can guide the caller.
  return { ok: false, reason: 'missing_header' };
}

function isStateChanging(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

// ---------------------------------------------------------------------------
// WRAPPER — `withAuth` (used by `authedPOST`, `authedPUT`, etc.)
// ---------------------------------------------------------------------------

type RouteHandler = (
  req: NextRequest,
  ctx: any,
) => Promise<NextResponse | Response> | NextResponse | Response;

/**
 * Wraps a Next.js route handler with auth. If auth is enabled and the
 * request fails the check, returns the canonical error shape:
 *   { error: 'Unauthorized'|'Forbidden', details: { reason: '<reason>' } }
 *
 * Status code mapping (audit IMP-PROD-SEC verify spec):
 *   - 401 Unauthorized  — no session, bad session, no token, bad token,
 *                          no session secret, no tokens configured.
 *   - 403 Forbidden      — caller IS authenticated (valid session cookie)
 *                          but the state-changing request is missing or
 *                          has an invalid `X-CSRF-Token` header. The spec
 *                          calls for 403 here because the user is logged
 *                          in — they just failed the CSRF defense.
 *
 * The wrapped handler can read the auth subject via `getAuthSubject(req)`.
 */
const CSRF_FAILURE_REASONS: ReadonlySet<string> = new Set([
  'missing_csrf',
  'invalid_csrf',
]);

export function withAuth(handler: RouteHandler): RouteHandler {
  return async (req, ctx) => {
    const auth = checkAuth(req);
    (req as any).__authSubject = auth.subject ?? { kind: 'anonymous' };
    if (!auth.ok) {
      const reason = auth.reason ?? 'unknown';
      const isCsrfFailure = CSRF_FAILURE_REASONS.has(reason);
      const status = isCsrfFailure ? 403 : 401;
      const error = isCsrfFailure ? 'Forbidden' : 'Unauthorized';
      return NextResponse.json(
        { error, details: { reason } },
        { status },
      );
    }
    // P0-1 (R2-IMP-OBS): wrap the handler in `runWithTraceId` so
    // `getCurrentTraceId()` inside the handler (and any downstream
    // code — audit-log-server, sentry, the chismoso CLI subprocess)
    // returns the request's trace ID. The Next.js middleware sets
    // `X-Trace-Id` on the forwarded request headers; we read it here
    // (with a fresh-UUID fallback for the rare case where middleware
    // didn't run, e.g. direct-to-route tests).
    //
    // This is the RELIABLE fix: AsyncLocalStorage set inside the
    // route handler's call stack propagates to all awaited callees.
    // The Next.js middleware's own `runWithTraceId` wrap (see
    // `src/middleware.ts`) does NOT reliably cross the middleware →
    // route-handler boundary, so we install the scope here too.
    const traceId = getTraceIdFromHeaders(req.headers) ?? generateTraceId();
    return runWithTraceId(traceId, () => handler(req, ctx));
  };
}

/**
 * Look up the auth subject attached by `withAuth`. Returns
 * `{ kind: 'anonymous' }` when no auth check ran (e.g. unprotected GET).
 */
export function getAuthSubject(req: NextRequest): AuthSubject {
  return (
    (req as any).__authSubject ?? {
      kind: 'anonymous' as const,
    }
  );
}

/**
 * R2-IMP-SEC (audit R2-8 / requireRole): returns the `ChismosoUser` for
 * the session-cookie caller, or `null` when the request is:
 *   - anonymous (no auth ran / auth disabled in dev)
 *   - a machine caller (X-Chismoso-Agent — subject.kind === 'agent')
 *   - from a session cookie whose subject was never attached by `withAuth`
 *
 * Used by `requireRole('admin')` (src/lib/require-role.ts) to enforce
 * per-route RBAC: if `getSessionUser(req)?.role !== 'admin'`, the
 * wrapper returns 403. Machine callers (no `role` claim) are rejected —
 * admin-only routes are operator-only by design.
 *
 * Reads the auth subject attached by `withAuth` — does NOT re-run
 * `checkAuth` (which would re-validate the JWT + CSRF on every call).
 * The subject is set once per request in `withAuth` and is the
 * authoritative identity for the rest of the handler chain.
 */
export function getSessionUser(req: NextRequest): ChismosoUser | null {
  const subject = (req as any).__authSubject as AuthSubject | undefined;
  if (!subject) return null;
  if (subject.kind !== 'user') return null;
  return subject.user ?? null;
}

// ---------------------------------------------------------------------------
// LEGACY — kept for backward compat with the V1.0 `checkAuth` surface
// (older code in the codebase calls `checkAuth(req)` and reads `.ok`).
// Now funnels through the unified check above.
// ---------------------------------------------------------------------------

export { checkAuth as checkAuthLegacy };

// ---------------------------------------------------------------------------
// TOKEN GENERATION (CLI helper — also used by `chismoso auth token`)
// ---------------------------------------------------------------------------

/**
 * Generates a fresh random machine token (32 bytes, URL-safe base64) and
 * its SHA-256 hash. Used by the `chismoso auth token` CLI command.
 *
 * The caller should:
 *   1. Print the plaintext token ONCE (so the operator can hand it to
 *      the agent client).
 *   2. Append the hash to `CHISMOSO_AUTH_TOKENS` in .env.
 */
export function generateToken(): { token: string; hash: string } {
  const bytes = new Uint8Array(32);
  randomFillSync(bytes);
  const b64 = Buffer.from(bytes).toString('base64url');
  return { token: b64, hash: hashToken(b64) };
}

// ---------------------------------------------------------------------------
// LOGIN / LOGOUT HIGH-LEVEL HELPERS (used by /api/auth/*)
// ---------------------------------------------------------------------------

export interface LoginResult {
  ok: boolean;
  user?: ChismosoUser;
  jwt?: string;
  csrfToken?: string;
  expiresAt?: number;
  reason?: 'invalid_credentials' | 'no_session_secret';
}

/**
 * Authenticate a username/password pair. On success, mints a fresh
 * session JWT and rotates the per-user CSRF token. On failure, returns
 * a generic `invalid_credentials` reason — never distinguish
 * "no such user" from "wrong password" to avoid user enumeration.
 */
export function login(username: string, password: string): LoginResult {
  const cfg = getAuthConfig();
  if (!cfg.sessionSecret) {
    return { ok: false, reason: 'no_session_secret' };
  }
  const user = findUserByUsername(username.trim());
  if (!user) {
    // Run a dummy bcrypt.compare to keep timing roughly uniform.
    bcrypt.compareSync(password, '$2a$12$000000000000000000000000000000000000000000000000000000000000');
    return { ok: false, reason: 'invalid_credentials' };
  }
  if (!verifyPassword(password, user.passwordHash)) {
    return { ok: false, reason: 'invalid_credentials' };
  }
  const { jwt, csrfToken, expiresAt } = createSession(user);
  return { ok: true, user, jwt, csrfToken, expiresAt };
}
