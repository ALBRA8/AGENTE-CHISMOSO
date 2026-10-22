/**
 * CHISMOSO V1.5 — CORS allowlist (Task IMP-PROD-SEC, audit H-4)
 *
 * Default-deny CORS posture. Cross-origin requests are accepted only
 * when the `Origin` header matches one of the origins in
 * `CHISMOSO_CORS_ORIGINS` (comma-separated). In production, this MUST
 * be set to the dashboard's own origin (so a logged-in browser on
 * `chismoso.example.com` can call its own API). When the env var is
 * empty/absent, only same-origin requests are allowed.
 *
 * Usage (in any API route):
 *
 *   import { corsHeadersForOrigin } from '@/lib/cors';
 *   const corsHeaders = corsHeadersForOrigin(req.headers.get('origin'));
 *   if (!corsHeaders) return new Response('CORS denied', { status: 403 });
 *   return new Response(JSON.stringify(data), {
 *     headers: { 'Content-Type': 'application/json', ...corsHeaders },
 *   });
 *
 * The Next.js middleware (`src/middleware.ts`) handles OPTIONS preflight
 * centrally so individual routes don't need an `OPTIONS` handler.
 */

/**
 * Returns true iff `origin` is allowed. When no allowlist is configured,
 * returns true only for null/empty origin (i.e. same-origin requests).
 */
export function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return true; // same-origin or non-browser request
  const allowlist = getAllowlist();
  if (allowlist.length === 0) {
    // No allowlist configured: same-origin only (i.e. the request must
    // have a null Origin — handled above). Cross-origin is denied.
    return false;
  }
  for (const allowed of allowlist) {
    if (origin === allowed) return true;
  }
  return false;
}

/**
 * Returns the CORS response headers to attach when `origin` is allowed,
 * or `null` if the origin is NOT allowed (caller should 403).
 */
export function corsHeadersForOrigin(
  origin: string | null,
): Record<string, string> | null {
  if (!isOriginAllowed(origin)) return null;
  if (!origin) return {}; // same-origin — no CORS headers needed
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, X-Chismoso-Agent, X-CSRF-Token',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/**
 * Returns the list of allowed origins from env. Empty array ⇒ same-origin
 * only.
 */
export function getAllowlist(): string[] {
  const raw = process.env.CHISMOSO_CORS_ORIGINS ?? '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
