/**
 * GET /api/metrics — Prometheus exposition endpoint (Task IMP-PROD-OBS, P0-1).
 *
 * Scraped by Prometheus / VictoriaMetrics / Grafana Agent. Returns the
 * full Prometheus text-format dump from the singleton Registry in
 * `src/lib/metrics.ts` (process metrics + http counters + domain counters
 * + gauges).
 *
 * Cache control: this route is `force-dynamic` because Prometheus scrapes
 * every 15-60 s and expects fresh values. Setting a Cache-Control header
 * would just add noise to Prometheus's own scrape cache.
 *
 * Auth: deliberately open. Prometheus scrape configs do not natively
 * support bearer tokens (the way we use them on /api/audit-log). If an
 * operator wants to gate this, they should put it behind a Caddy basic-
 * auth route or restrict it to a localhost-only NetworkPolicy.
 */

import { register } from '@/lib/metrics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const metrics = await register.metrics();
  return new Response(metrics, {
    status: 200,
    headers: {
      'Content-Type': register.contentType,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
}
