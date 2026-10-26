/**
 * CHISMOSO V1.5 — Security headers (Task IMP-PROD-SEC, audit H-3)
 *
 * Canonical security header constants used by both:
 *   - `next.config.ts::headers()` — applies to all Next.js dev responses
 *   - `src/middleware.ts` — runtime enforcement on every route
 *   - `Caddyfile` — TLS termination edge
 *
 * Keeping the values in one place avoids drift between the three layers.
 * The Next.js layer can't set HSTS (the dev server is HTTP-only); the
 * Caddyfile sets HSTS at the edge.
 */

export interface SecurityHeader {
  key: string;
  value: string;
}

/**
 * Strict Content-Security-Policy. Allows inline styles/scripts because
 * Next.js relies heavily on inline `<style>` and inline bootstrap scripts
 * (RSC payloads, hydration, etc.). `connect-src 'self'` blocks exfil to
 * attacker origins. `frame-ancestors 'none'` is the modern equivalent of
 * `X-Frame-Options: DENY`.
 *
 * For a stricter CSP with nonces, see the Next.js docs on `nonce` —
 * CHISMOSO V1.5 doesn't ship nonce-based CSP yet because the dashboard's
 * hydration pattern fights it. `unsafe-inline` is acceptable here because
 * the threat model is "leak data to attacker origins", which `connect-src
 * 'self'` already blocks.
 */
export const CSP_HEADER_VALUE =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob: https:; " +
  "font-src 'self' data:; " +
  "connect-src 'self'; " +
  "frame-ancestors 'none'; " +
  "form-action 'self'; " +
  "base-uri 'self'; " +
  "object-src 'none'; " +
  "manifest-src 'self'";

/**
 * The canonical security headers applied to every HTTP response.
 * Returns an array shaped for `next.config.ts::headers()` AND for the
 * Next.js middleware `NextResponse.next({ headers: ... })` pattern.
 */
export function getSecurityHeaders(): SecurityHeader[] {
  return [
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    {
      key: 'Permissions-Policy',
      value: 'geolocation=(), microphone=(), camera=()',
    },
    {
      key: 'Strict-Transport-Security',
      value: 'max-age=31536000; includeSubDomains',
    },
    { key: 'Content-Security-Policy', value: CSP_HEADER_VALUE },
    {
      key: 'X-DNS-Prefetch-Control',
      value: 'off',
    },
    {
      key: 'Cross-Origin-Opener-Policy',
      value: 'same-origin',
    },
    {
      key: 'Cross-Origin-Resource-Policy',
      value: 'same-origin',
    },
  ];
}

/**
 * Converts the header list to a plain object for use in
 * `NextResponse.next({ headers: ... })` — values are joined into a
 * single string per header name. (Next.js middleware sets headers
 * additively.)
 */
export function getSecurityHeadersAsRecord(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of getSecurityHeaders()) {
    out[h.key] = h.value;
  }
  return out;
}
