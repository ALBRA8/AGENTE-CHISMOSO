/**
 * CHISMOSO V1.5 — GET /api/auth/me (Task IMP-PROD-SEC, audit C-2)
 *
 * Returns the current authenticated user + the bound CSRF token. Used
 * by the dashboard client on boot to recover the CSRF token after a
 * page refresh / server restart (the JWT cookie is HttpOnly so JS can't
 * read it; this endpoint is the only way for the client to learn its
 * own CSRF token).
 *
 * Response 200:
 *   {
 *     authenticated: true,
 *     user: { id, username, role, createdAt },
 *     csrfToken: string,
 *     expiresAt: number
 *   }
 *
 * Response 200 (unauthenticated, auth enabled):
 *   { authenticated: false }
 *
 * Response 200 (auth disabled in dev):
 *   { authenticated: false, authDisabled: true }
 */

import { NextRequest } from 'next/server';
import { getAuthConfig, getSessionCookie, verifySession } from '@/lib/auth';
import { findUserById } from '@/lib/users-db';
import { apiOk } from '@/lib/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const cfg = getAuthConfig();
  if (!cfg.enabled) {
    return apiOk({ authenticated: false, authDisabled: true });
  }
  const sessionJwt = getSessionCookie(req);
  if (!sessionJwt) {
    return apiOk({ authenticated: false });
  }
  const claims = verifySession(sessionJwt);
  if (!claims) {
    return apiOk({ authenticated: false });
  }
  const user = findUserById(claims.sub);
  if (!user) {
    return apiOk({ authenticated: false });
  }
  return apiOk({
    authenticated: true,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      createdAt: user.createdAt,
    },
    csrfToken: claims.csrf,
    expiresAt: claims.exp * 1000,
  });
}
