/**
 * CHISMOSO V1.5 — POST /api/auth/logout (Task IMP-PROD-SEC, audit C-2)
 *
 * Invalidates the current session: clears the per-user CSRF token and
 * expires the session cookie. The JWT itself is stateless so it can't be
 * revoked without a denylist — but with the CSRF token gone, no
 * state-changing request from the residual cookie can pass the CSRF
 * check, so the practical effect is equivalent to logout.
 *
 * For a future hardening pass: add a `revoked_sessions` table and check
 * it in `verifySession` to make logout fully revocative.
 *
 * CSRF: this endpoint is intentionally CSRF-exempt (the logout request
 * must succeed even if the client has somehow lost the CSRF token —
 * e.g. after a server restart rotated the per-user token). The session
 * cookie + SameSite=Strict is enough CSRF defense here.
 *
 * Request: empty body OR any body (ignored).
 * Response 200: `{ ok: true }`
 */

import { NextRequest } from 'next/server';
import { getAuthConfig, getSessionCookie, verifySession, invalidateSession, buildExpiredSessionCookie } from '@/lib/auth';
import { findUserById } from '@/lib/users-db';
import { apiOk } from '@/lib/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const cfg = getAuthConfig();
  const sessionJwt = getSessionCookie(req);
  if (sessionJwt && cfg.sessionSecret) {
    const claims = verifySession(sessionJwt);
    if (claims) {
      // Best-effort invalidation: clear the per-user CSRF token if the
      // user still exists.
      const user = findUserById(claims.sub);
      if (user) {
        try {
          invalidateSession(user.id);
        } catch {
          /* ignore — best-effort */
        }
      }
    }
  }
  const response = apiOk({ ok: true });
  response.headers.set('Set-Cookie', buildExpiredSessionCookie());
  return response;
}
