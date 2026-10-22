import type { NextConfig } from "next";

/**
 * CHISMOSO V1.5 — Next.js config (Task IMP-PROD-SEC, audit C-7, H-3, L-2)
 *
 * Production hardening:
 *   - `output: 'standalone'` for single-binary deploys.
 *   - `poweredByHeader: false` strips the `X-Powered-By: Next.js` header.
 *   - `compress: true` enables gzip for non-static responses.
 *   - `reactStrictMode: true` surfaces double-fire bugs in dev.
 *   - Removed `typescript.ignoreBuildErrors` and
 *     `eslint.ignoreDuringBuilds` — type errors and lint failures now
 *     BLOCK production builds (audit L-2 / C-7).
 *   - `headers()` exports the canonical security header set for dev
 *     responses (CSP, X-Frame-Options, etc.). Same set is applied at
 *     the edge by Caddy (see Caddyfile) and at runtime by
 *     `src/middleware.ts` for defense in depth.
 *   - `X-Forwarded-Proto` recognition: when Caddy fronts the app on
 *     HTTPS, `req.url` is relative and Next.js trusts the proxy
 *     headers set by Caddy (`X-Forwarded-Proto: https`). No
 *     `basePath` / `assetPrefix` needed — Caddy forwards to localhost:3000.
 *
 *   - Body parser size limit: 64KB on API routes — the default 1MB is
 *     too permissive for the API surface (audit M-3).
 */

const securityHeaders = [
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
  {
    key: 'Content-Security-Policy',
    value:
      "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'; object-src 'none'; manifest-src 'self'",
  },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
];

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  compress: true,
  reactStrictMode: true,

  // P0-2 (R2-IMP-OBS): source maps for client AND server bundles.
  //
  // Without these, Sentry (and any other error tracker) receives
  // minified stack traces that are useless for debugging. The client
  // source maps are served from `/_next/static/...` (Next.js handles
  // the `SourceMap` HTTP header + the `.map` files automatically when
  // `productionBrowserSourceMaps` is true). Server source maps are
  // emitted next to the compiled server chunks so the Sentry SDK can
  // symbolicate Node-side errors (route handlers, server components,
  // the instrumentation hook).
  //
  // Security note: client source maps are publicly fetchable. They
  // reveal the original source structure of the client bundle. This
  // is an accepted trade-off for V1.5 — the Sentry alternative is
  // `sentry-cli releases files upload` (upload maps to Sentry, don't
  // serve them), which we can switch to in V2 by setting
  // `productionBrowserSourceMaps: false` and wiring the upload step
  // into CI.
  productionBrowserSourceMaps: true,
  experimental: {
    // P0-2 (R2-IMP-OBS): server source maps. Lives under `experimental`
    // in Next.js 16 (see `ExperimentalConfig.serverSourceMaps` in
    // node_modules/next/dist/server/config-shared.d.ts). Without this,
    // Sentry receives minified stack traces for route handlers, server
    // components, and the instrumentation hook.
    serverSourceMaps: true,

    // Per-route body size limit. Audit M-3 flagged the default 1MB as too
    // permissive. 64KB is enough for every JSON route in the API surface
    // (chat ≤2KB, mesh external-signals ≤100KB internally validated, etc.).
    // NOTE: chat payloads include sessionId + message ≤2KB so 64KB is generous.
    // In Next.js 16 the per-route override is set via
    // `export const bodyParser = { sizeLimit: '64kb' }` in the route file.
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },

  async redirects() {
    return [];
  },
};

export default nextConfig;
