/**
 * GET /api/livez — process-liveness probe (Task IMP-PROD-OBS, P0-2).
 *
 * Returns 200 if the Next.js process is up and can execute TypeScript.
 * Does NOT check the DB, LLM providers, or any external dependency —
 * liveness is "is this process alive?" not "is it ready to serve?".
 *
 * Use this for the Kubernetes/Caddy `livenessProbe`. A failing
 * liveness probe should cause the orchestrator to RESTART the pod.
 *
 * For a probe that checks downstream dependencies, use /api/readyz.
 */

import { apiOk } from '@/lib/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return apiOk({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.round(process.uptime()),
  });
}
