/**
 * CHISMOSO V1.5 — Next.js middleware
 * (Task IMP-PROD-SEC audit H-3, H-4 + Task IMP-PROD-OBS P0-4)
 *
 * Applied to EVERY route. Four jobs:
 *
 *   1. **CORS** — preflight (`OPTIONS`) requests are answered here with the
 *      allowlist headers from `src/lib/cors.ts`. Non-preflight cross-origin
 *      requests get `Access-Control-Allow-Origin` attached if (and only if)
 *      the origin is in the allowlist. Origin mismatches return 403.
 *
 *   2. **Security headers** — every response gets the canonical set:
 *      CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy,
 *      Permissions-Policy, Strict-Transport-Security, COOP, CORP.
 *      HSTS is set here too (no-ops for HTTP dev, blocks SSL-strip on
 *      the Caddy fronted HTTPS).
 *
 *   3. **Trace ID propagation (P0-4)** — every request gets a trace ID
 *      (UUID v4). If the caller supplied `X-Trace-Id`, we honor it
 *      (after validating it's URL-safe so a malicious header can't
 *      smuggle CRLF into logs). The trace ID is:
 *        - Attached to the outgoing request headers (forwarded to the
 *          route handler, so handlers can read `req.headers.get('X-Trace-Id')`).
 *        - Attached to the response headers (visible to the caller /
 *          operator — proven path, same as security headers today).
 *      The chismoso logger + audit-log-server pick up the trace ID via
 *      `X-Trace-Id` on the request headers (see `getCurrentTraceId`).
 *
 *   4. **Metrics (P0-1)** — every request is counted in
 *      `chismoso_http_requests_total{method,route,status}` and timed in
 *      `chismoso_http_request_duration_seconds{method,route}`. The route
 *      label is normalized so dynamic segments (UUIDs, prefixed IDs) are
 *      collapsed to `:id` — this prevents cardinality explosion in
 *      Prometheus (e.g. `/api/investigations/inv_abc123` →
 *      `/api/investigations/:id`).
 *
 *      LIMITATION: middleware runs BEFORE the route handler. The duration
 *      we measure here is the middleware overhead (microseconds), NOT the
 *      route handler's latency. For accurate per-route latency, instrument
 *      the route handlers themselves (a follow-up task). For now, the
 *      counter is accurate for request volume + status breakdown
 *      (preflight=204, CORS-denied=403, forwarded='200' as an
 *      approximation when middleware can't see the final status).
 *
 *   5. **Powered-by removal** — Next.js's `poweredByHeader: false` in
 *      `next.config.ts` removes `X-Powered-By` from compiled responses
 *      but the dev server still emits it; we strip it here too as
 *      defense-in-depth.
 *
 * Auth (the actual session/agent token check) runs INSIDE each route
 * handler via `authedPOST`/`withAuth` — that's where we have access to
 * the user DB and the request body. The middleware here does NOT do
 * auth enforcement (it can't access better-sqlite3 reliably in the
 * edge runtime, and we want JWT verification to use the per-process
 * user DB).
 *
 * The middleware config matcher (`export const config`) is set to run
 * on every route EXCEPT Next.js internals (`/_next/...`, `/favicon.ico`,
 * static assets).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { getSecurityHeadersAsRecord } from '@/lib/headers';
import { corsHeadersForOrigin, isOriginAllowed } from '@/lib/cors';
import {
  ensureTraceId,
  runWithTraceId,
  TRACE_ID_HEADER,
} from '@/lib/trace-id';
import {
  httpRequestCounter,
  httpDurationHistogram,
} from '@/lib/metrics';

export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// ROUTE NORMALIZATION (cardinality control)
// ---------------------------------------------------------------------------

/**
 * Collapses dynamic path segments to `:id` so the `route` label on
 * Prometheus counters/histograms doesn't explode.
 *
 *   /api/investigations/inv_abc123        → /api/investigations/:id
 *   /api/alerts/alert_xyz/ack            → /api/alerts/:id/ack
 *   /api/topics/Marketplace%20trends     → /api/topics/:id
 *   /api/health                          → /api/health  (unchanged)
 *
 * Heuristic: a segment is "dynamic" if it does NOT match the static
 * path convention (`^[a-z][a-z0-9-]*$`, length < 20). This catches:
 *   - Prefixed IDs: `inv_…`, `alert_…`, `skill_…`, `trace_…`
 *   - UUIDs: `123e4567-e89b-…`
 *   - URL-encoded values: `Marketplace%20trends`
 *   - Base64 / long opaque IDs
 *
 * Static-looking segments (`ack`, `resolve`, `invoke`, `health`, …) are
 * preserved verbatim so we still get per-route granularity on the
 * fixed endpoints.
 */
function normalizeRoute(pathname: string): string {
  // Fast path: root or simple top-level path.
  if (pathname === '/' || pathname.indexOf('/', 1) === -1) {
    return pathname;
  }
  const segments = pathname.split('/').filter((s) => s.length > 0);
  const out: string[] = [];
  for (const seg of segments) {
    if (/^[a-z][a-z0-9-]{0,18}$/i.test(seg)) {
      out.push(seg);
    } else {
      out.push(':id');
    }
  }
  return '/' + out.join('/');
}

// ---------------------------------------------------------------------------
// METRICS OBSERVATION HELPERS
// ---------------------------------------------------------------------------

/**
 * Records a single HTTP request observation into the Prometheus
 * registry. Called once per request, with the middleware-known status
 * (preflight, CORS-denied, or 'forwarded' for the no-op pass-through).
 *
 * The `route` label is the NORMALIZED route (see `normalizeRoute`).
 */
function observeRequest(
  method: string,
  pathname: string,
  status: string,
  startMs: number,
): void {
  const route = normalizeRoute(pathname);
  // `performance.now()` returns a millisecond float with sub-ms
  // resolution (Node 16+ / all modern browsers). Converted to seconds
  // for the prom-client histogram (which expects SI base units).
  const durationSec = (performance.now() - startMs) / 1000;
  try {
    httpRequestCounter.inc({ method, route, status });
    httpDurationHistogram.observe({ method, route }, durationSec);
  } catch {
    // Metrics recording must never break a request. If the registry
    // is in a weird state (e.g. mid-HMR), swallow + continue.
  }
}

// ---------------------------------------------------------------------------
// MIDDLEWARE
// ---------------------------------------------------------------------------

export function middleware(req: NextRequest) {
  // `performance.now()` is the highest-resolution monotonic clock
  // available in the Node.js runtime without BigInt (which requires
  // ES2020 target — our tsconfig is ES2017). Sub-ms resolution is more
  // than enough for HTTP request timing.
  const startMs = performance.now();
  const { method } = req;
  const pathname = req.nextUrl.pathname;
  const origin = req.headers.get('origin');

  // --- Trace ID (P0-4 + R2-IMP-OBS P0-1) -----------------------------
  // Generate (or honor the caller's) trace ID. We attach it to BOTH
  // the forwarded request headers (so the route handler can read it
  // via `req.headers.get('X-Trace-Id')`) AND the response headers
  // (so the caller / operator can see it on every response).
  //
  // We ALSO wrap the rest of the middleware body in `runWithTraceId`
  // so any code that runs synchronously inside the middleware (e.g.
  // the metrics observation helpers) can read the active trace ID
  // via `getCurrentTraceId()`. This wrap is DEFENSE-IN-DEPTH — it
  // does NOT reliably propagate to route handlers (Next.js runs the
  // route handler in a separate async context). The RELIABLE wire
  // is in `src/lib/auth.ts::withAuth` + `src/lib/middleware.ts::
  // optionalAuth`, which wrap the handler call in `runWithTraceId`.
  const traceId = ensureTraceId(req.headers);
  return runWithTraceId(traceId, () => middlewareInner(req, traceId, startMs, method, pathname, origin));
}

function middlewareInner(
  req: NextRequest,
  traceId: string,
  startMs: number,
  method: string,
  pathname: string,
  origin: string | null,
): NextResponse {
  // --- CORS preflight -------------------------------------------------
  // OPTIONS is handled here centrally so individual API routes don't need
  // an OPTIONS handler.
  if (method === 'OPTIONS') {
    if (origin && !isOriginAllowed(origin)) {
      observeRequest(method, pathname, '403', startMs);
      return new NextResponse(null, {
        status: 403,
        headers: {
          'Content-Type': 'text/plain',
          'Content-Length': '0',
          [TRACE_ID_HEADER]: traceId,
        },
      });
    }
    const corsHeaders = corsHeadersForOrigin(origin);
    observeRequest(method, pathname, '204', startMs);
    return new NextResponse(null, {
      status: 204,
      headers: {
        'Content-Length': '0',
        [TRACE_ID_HEADER]: traceId,
        ...(corsHeaders ?? {}),
      },
    });
  }

  // --- For non-preflight requests, deny cross-origin if not allowed ----
  // We let same-origin (no Origin header) and allowed cross-origin
  // requests pass through with the appropriate ACAO header.
  if (origin && !isOriginAllowed(origin)) {
    observeRequest(method, pathname, '403', startMs);
    return new NextResponse(
      JSON.stringify({ error: 'CORS denied', details: { origin } }),
      {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          'Vary': 'Origin',
          [TRACE_ID_HEADER]: traceId,
        },
      },
    );
  }

  // --- Apply security headers + trace ID + ACAO (if cross-origin) -----
  const requestHeaders = new Headers(req.headers);
  // Forward the trace ID to the route handler so it can read it via
  // `req.headers.get('X-Trace-Id')`. The route handler wrappers
  // (`withAuth`/`optionalAuth`) and the audit-log-server both pick it
  // up from here.
  requestHeaders.set(TRACE_ID_HEADER, traceId);

  // Forward the URL so the handler chain sees the original path.
  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  // Security headers — applied to EVERY response (the existing behavior).
  for (const [k, v] of Object.entries(getSecurityHeadersAsRecord())) {
    response.headers.set(k, v);
  }

  // Trace ID header — appears on the final response to the caller.
  // (This works because NextResponse.next()'s headers are merged into
  // the route handler's response — proven by the security headers
  // already going through this same path.)
  response.headers.set(TRACE_ID_HEADER, traceId);

  if (origin) {
    const corsHeaders = corsHeadersForOrigin(origin);
    if (corsHeaders) {
      for (const [k, v] of Object.entries(corsHeaders)) {
        response.headers.set(k, v);
      }
    }
  }

  // Strip X-Powered-By if Next.js left it on (defense-in-depth — the
  // `poweredByHeader: false` in next.config.ts already does this for
  // production builds; the dev server still emits it).
  response.headers.delete('X-Powered-By');

  // --- Metrics: count + time (P0-1) -----------------------------------
  // For the pass-through case we can't see the final status code from
  // middleware (the route handler runs after middleware returns). We
  // record status='forwarded' so operators can still see request
  // volume by route. Accurate per-status accounting happens at the
  // route layer (apiOk/apiError) — a follow-up task.
  observeRequest(method, pathname, 'forwarded', startMs);

  return response;
}

export const config = {
  // Run on every path EXCEPT Next.js internal asset paths and the
  // static `public/` files. This ensures the security headers apply
  // to API routes, app pages, and server components alike.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|logo.svg|.*\\..*).*)',
  ],
};
