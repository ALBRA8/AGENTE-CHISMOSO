/**
 * CHISMOSO V1.5 — CSRF helper (Task IMP-PROD-SEC, audit H-2)
 *
 * Tiny standalone helpers for CSRF token issuance + validation. The actual
 * enforcement is wired into `src/lib/auth.ts::checkAuth` (state-changing
 * methods must carry `X-CSRF-Token` matching the per-user bound token).
 *
 * Lifecycle:
 *   1. User logs in via `POST /api/auth/login` → server mints a CSRF
 *      token (32-byte CSPRNG) bound to the user record (see
 *      `rotateCsrfToken` in `users-db.ts`), embeds it in the session JWT
 *      claims, and returns it in the JSON response body so client JS
 *      can stash it in `localStorage` / a memory store.
 *   2. On every state-changing request, the client must echo the token
 *      in the `X-CSRF-Token` header. The server re-validates against the
 *      DB (so logging out kills the token immediately).
 *   3. `GET /api/auth/me` returns the current CSRF token so a tab opened
 *      after a server restart can recover its token without re-login.
 *
 * Machine callers (X-Chismoso-Agent bearer tokens) are CSRF-exempt:
 * they have no browser origin to defend against and they don't carry
 * the session cookie, so the auth check never enters the CSRF path.
 *
 * See `src/lib/auth.ts::isStateChanging` for the list of methods that
 * require a CSRF token.
 */

import type { NextRequest } from 'next/server';
import { CSRF_HEADER } from '@/lib/auth';

export { CSRF_HEADER };

/**
 * Read the CSRF token from the incoming request's `X-CSRF-Token` header.
 * Returns null if absent.
 */
export function getCsrfTokenFromRequest(req: NextRequest): string | null {
  const v = req.headers.get(CSRF_HEADER);
  if (!v) return null;
  return v.trim();
}

/**
 * Returns true iff `method` requires CSRF enforcement per the auth
 * middleware (POST / PUT / PATCH / DELETE).
 */
export function isStateChangingMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';
}
