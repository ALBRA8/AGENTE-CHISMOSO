/**
 * CHISMOSO V1.5 — Role-enforcement route wrapper (Task R2-IMP-SEC,
 * audit R2-8 / H-8 carryover from R2-AUDIT-SEC)
 *
 * `requireRole(role)` returns a higher-order wrapper that gates a Next.js
 * App Router handler on the caller's session role. Used to enforce
 * admin-only access on operator-surface routes:
 *
 *   - GET  /api/audit-log      → admin-only (audit log is sensitive)
 *   - POST /api/doctor?fix=true → admin-only (mutates the chismoso DB)
 *   - PUT  /api/mesh/config    → admin-only (rewrites webhook subscribers)
 *
 * Usage (compose with `authedPOST` / `authedPUT` / `authedRoute`):
 *
 *   export const PUT = authedPUT(requireRole('admin')(async (req) => {
 *     // ... handler body ...
 *     return apiOk({ ... });
 *   }));
 *
 * The outer `authed*` wrapper runs `checkAuth` first (verifying the
 * session JWT or machine token + CSRF) and attaches the auth subject.
 * `requireRole` then reads the subject via `getSessionUser(req)` and
 * enforces the role. This double-check is defense-in-depth (the outer
 * wrapper already proved the caller is authenticated; the inner one
 * proves they hold the required role).
 *
 * Dev convenience: when `CHISMOSO_AUTH_ENABLED` is unset/false (the dev
 * default), `checkAuth` returns `{ ok: true, reason: 'auth_disabled' }`
 * and the subject is `{ kind: 'anonymous' }`. In that mode, `requireRole`
 * SKIPS the role check — the dashboard opens without provisioning an
 * admin user. This preserves the V1.0 dev posture ("no setup required
 * to open the dashboard locally") documented in auth.ts.
 *
 * Posture for machine callers (`X-Chismoso-Agent`): the subject is
 * `{ kind: 'agent', tokenHash }` — there is no `role` claim. So
 * `getSessionUser(req)` returns `null`, and `requireRole` returns 403.
 * Admin-only routes are operator-only by design. This is a deliberate
 * tightening of the V1.5 surface: previously, any agent token could call
 * these admin endpoints. Operators using machine tokens for automation
 * should use a dedicated CLI (e.g. `chismoso doctor --fix`) instead.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAuth, getSessionUser } from './auth';

type RouteHandler = (
  req: NextRequest,
  ctx: any,
) => Promise<NextResponse | Response> | NextResponse | Response;

/**
 * Wrap a route handler with a role check. Returns 403 Forbidden when the
 * caller is authenticated but doesn't hold `role`. Returns 401 when auth
 * is enabled and the caller failed the outer `checkAuth` (defense in
 * depth — the outer `authed*` wrapper would have already returned 401,
 * but this guards against a future wrapper that skips the auth check).
 *
 * The `role` parameter is constrained to the union of valid roles
 * defined in `ChismosoUser` (currently `'operator' | 'admin'`) so
 * typos are caught at compile time.
 */
export function requireRole(role: 'operator' | 'admin'): (handler: RouteHandler) => RouteHandler {
  return function (handler: RouteHandler): RouteHandler {
    return async (req: NextRequest, ctx: any): Promise<NextResponse | Response> => {
      const auth = checkAuth(req);

      // Dev convenience: when auth is fully disabled, skip the role gate
      // so the dashboard opens without provisioning an admin user.
      // (Matches the V1.0 / V1.5 dev posture documented in auth.ts.)
      if (auth.reason !== 'auth_disabled') {
        if (!auth.ok) {
          return NextResponse.json(
            { error: 'Unauthorized' },
            { status: 401 },
          );
        }
        const user = getSessionUser(req);
        if (!user || user.role !== role) {
          return NextResponse.json(
            {
              error: 'Forbidden',
              details: {
                required_role: role,
                // Never disclose the caller's actual role here — that
                // would be an info leak (an attacker probing roles
                // would learn their own current role). Just say "you
                // don't have the required role".
              },
            },
            { status: 403 },
          );
        }
      }

      return handler(req, ctx);
    };
  };
}
