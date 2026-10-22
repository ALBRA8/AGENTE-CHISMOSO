/**
 * CHISMOSO V1.5 — POST /api/auth/login (Task IMP-PROD-SEC, audit C-2)
 *
 * Authenticates a username/password pair and sets a session JWT in an
 * HttpOnly+Secure+SameSite=Strict cookie. Returns the CSRF token in the
 * response body so the dashboard client can stash it in memory and echo
 * it back on state-changing requests.
 *
 * Request body:
 *   { username: string, password: string }
 *
 * Response 200:
 *   {
 *     user: { id, username, role, createdAt },
 *     csrfToken: string,        // 32-byte URL-safe base64
 *     expiresAt: number         // epoch ms
 *   }
 *
 * Response 401:
 *   { error: 'Unauthorized', details: { reason: 'invalid_credentials' } }
 *
 * Response 503:
 *   { error: 'auth_unavailable', details: { reason: 'no_session_secret' } }
 *
 * Brute-force defense: per-IP rate limit (5 attempts / min) — see
 * `src/lib/rate-limit.ts` LIMITS.investigate. (Login is more sensitive
 * than investigate; we reuse the 5/min bucket for now. Could tighten to
 * a dedicated bucket — out of scope for this hardening pass.)
 *
 * Cookies: the session JWT is in `chismoso_session`. The CSRF token is
 * NOT in a cookie — it is in the response body so the dashboard client
 * can read it (cookies are HttpOnly so JS can't read them).
 */

import { NextRequest } from 'next/server';
import { login, buildSessionCookie } from '@/lib/auth';
import { getClientIP, rateLimit, LIMITS } from '@/lib/rate-limit';
import { apiBadRequest, apiError, apiOk, apiUnavailable } from '@/lib/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  // --- Rate limit (per-IP, 5/min — same bucket as investigate) ---------
  const ip = getClientIP(req);
  const rl = rateLimit(`login:${ip}`, LIMITS.investigate);
  if (!rl.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
    return apiError(429, 'Rate limit exceeded', { retryAfterSec: retryAfter });
  }

  // --- Parse body ------------------------------------------------------
  let body: { username?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return apiBadRequest('Invalid JSON body', { code: 'invalid_json' });
  }
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!username || !password) {
    return apiBadRequest('Missing `username` or `password`', {
      code: 'missing_credentials',
    });
  }
  if (username.length > 64 || password.length > 256) {
    return apiBadRequest('Credential too long', { code: 'invalid_length' });
  }

  // --- Authenticate + mint session ------------------------------------
  const result = login(username, password);
  if (!result.ok) {
    if (result.reason === 'no_session_secret') {
      return apiUnavailable('auth_unavailable', { reason: 'no_session_secret' });
    }
    return apiError(401, 'Unauthorized', { reason: 'invalid_credentials' });
  }

  const { user, jwt, csrfToken, expiresAt } = result;
  // Set the session cookie + return the CSRF token (NOT in a cookie — JS
  // needs to read it).
  const response = apiOk({
    user: {
      id: user!.id,
      username: user!.username,
      role: user!.role,
      createdAt: user!.createdAt,
    },
    csrfToken,
    expiresAt,
  });
  response.headers.set('Set-Cookie', buildSessionCookie(jwt!, expiresAt!));
  return response;
}
