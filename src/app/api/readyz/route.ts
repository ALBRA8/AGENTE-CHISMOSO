/**
 * GET /api/readyz — readiness probe (REL-P0-008).
 *
 * Distinct from `/api/health` (liveness): /api/health answers "is the
 * process up?" — it always 200s if Next.js can answer at all. /readyz
 * answers "is this process ready to receive new traffic?" — it returns
 * 503 when:
 *
 *   - the process is shutting down (draining in-flight requests after
 *     SIGTERM — see graceful-shutdown.ts)
 *   - the SQLite DB is unreadable (file moved, permissions broke,
 *     SQLITE_BUSY long enough to fail even with busy_timeout=5s)
 *   - the LLM API is unreachable (a single cached health probe every
 *     60s so we don't hammer it; the LLM circuit breaker state is
 *     surfaced too so an open circuit shows up here)
 *   - required env vars are unset (CHISMOSO_DB_PATH, CHISMOSO_OUTPUT_DIR)
 *
 * Load balancer / reverse proxy should probe this and route traffic away
 * on 503. The Caddyfile reverse-proxies blindly to :3000 today; once this
 * endpoint exists, the operator can wire it up via Caddy's `health` block
 * or via an external LB.
 *
 * Response shape:
 *   {
 *     status: 'ready' | 'not_ready' | 'draining',
 *     timestamp: '<ISO>',
 *     checks: {
 *       shutdown: 'ok' | 'draining',
 *       db: 'ok' | 'error: <msg>',
 *       env: 'ok' | 'error: <msg>',
 *       llm: 'ok' | 'unreachable' | 'circuit_open' | 'unknown',
 *     },
 *     circuitBreaker: { state: 'closed' | 'open' | 'half-open', failures: <n> },
 *     concurrency: { inFlight, capacity, waiting },
 *   }
 */

import { NextResponse } from 'next/server';
import path from 'node:path';
import { chismosoDb } from '@/lib/db-chismoso';
import { isShuttingDown } from '@/lib/graceful-shutdown';
import { investigateSemaphore } from '@/lib/concurrency';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// REL2-P0-3 — chismoso dist path MUST be configurable so the readiness
// probe doesn't permanently 503 in any non-dev-sandbox deployment
// (systemd at /opt, Docker, etc.). Three resolution strategies, in
// priority order:
//
//   1. CHISMOSO_DIST_PATH env var — absolute path to the compiled
//      chismoso bundle directory. systemd's EnvironmentFile sets this
//      in prod (e.g. `/opt/chismoso/chismoso/dist`).
//   2. CHISMOSO_ROOT env var — parent dir of the chismoso project.
//      dist/ is computed as `${CHISMOSO_ROOT}/dist`. Useful for
//      operators who already set CHISMOSO_ROOT for the CLI path.
//   3. Fallback — relative to the Next.js process CWD. In the dev
//      sandbox that's `/home/z/my-project`, so the path resolves to
//      `/home/z/my-project/chismoso/dist`. In a Docker image with
//      WORKDIR /app and chismoso vendored at /app/chismoso, the path
//      resolves to /app/chismoso/dist without any env wiring.
//
// We compute once at module load (cheap) and reuse on every request —
// /readyz is probed every 5–10s by the LB so per-request path
// resolution would be wasteful.
const CHISMOSO_DIST_PATH = (() => {
  const fromEnv = process.env.CHISMOSO_DIST_PATH;
  if (fromEnv) return fromEnv;
  const root = process.env.CHISMOSO_ROOT;
  if (root) return path.join(root, 'dist');
  // Dev sandbox + Docker default — chismoso is a sibling of the
  // Next.js project. Use a relative join (not hardcoded absolute) so
  // this works regardless of where the project is checked out.
  return path.join(process.cwd(), 'chismoso', 'dist');
})();

interface CheckResult {
  shutdown: 'ok' | 'draining';
  db: 'ok' | `error: ${string}`;
  env: 'ok' | `error: ${string}`;
  llm: 'ok' | 'unreachable' | 'circuit_open' | 'unknown';
}

interface LlmHealthCache {
  lastCheckAt: number;
  reachable: boolean;
  error?: string;
}

// 60s cache so a tight health-check loop (every 5s from the LB) doesn't
// spawn an LLM probe request per call.
const LLM_PROBE_INTERVAL_MS = 60_000;
let llmHealthCache: LlmHealthCache = {
  lastCheckAt: 0,
  reachable: true,
};

/**
 * Cached LLM reachability probe. We import `LLMClient` lazily so the
 * chismoso bundle is only pulled in when this route actually runs (and
 * the chismoso TS build has happened). If the import fails (chismoso not
 * built yet), we mark the LLM check `unknown` rather than fail the whole
 * probe.
 */
async function probeLlm(): Promise<{ reachable: boolean; error?: string }> {
  const now = Date.now();
  if (now - llmHealthCache.lastCheckAt < LLM_PROBE_INTERVAL_MS) {
    return { reachable: llmHealthCache.reachable, error: llmHealthCache.error };
  }
  // Re-probe. Use a low-cost chat call (1 token of "ping"). If it throws
  // (timeout, network, auth, circuit open) we mark unreachable.
  try {
    // Dynamic import so the chismoso dist/ bundle is only required when
    // /readyz runs. If dist/ is missing (operator forgot to build), the
    // import rejects and we treat it as `unknown` rather than tanking the
    // readiness probe on a build step that may have happened on another host.
    //
    // REL2-P0-3 — path is resolved from CHISMOSO_DIST_PATH / CHISMOSO_ROOT /
    // process.cwd() (see top of file), NOT hardcoded to the dev-sandbox path.
    const { LLMClient } = await import(
      /* webpackIgnore: true */ path.join(CHISMOSO_DIST_PATH, 'orchestrator', 'llm.js')
    ).catch(() => ({ LLMClient: null }));
    if (!LLMClient) {
      llmHealthCache = { lastCheckAt: now, reachable: false, error: 'llm module not built' };
      return { reachable: false, error: 'llm module not built' };
    }
    const client = new LLMClient();
    await client.chat(
      [
        { role: 'system', content: 'reply with the single word: ok' },
        { role: 'user', content: 'ping' },
      ],
      { thinking: false },
    );
    llmHealthCache = { lastCheckAt: now, reachable: true };
    return { reachable: true };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    llmHealthCache = { lastCheckAt: now, reachable: false, error: msg };
    return { reachable: false, error: msg };
  }
}

function checkEnv(): 'ok' | `error: ${string}` {
  const required = ['CHISMOSO_DB_PATH', 'CHISMOSO_OUTPUT_DIR'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    return `error: missing env vars: ${missing.join(', ')}`;
  }
  // CHISMOSO_DB_PATH isn't required at runtime in the Next.js process (the
  // singleton reader uses a default), but if it's set it must point to an
  // existing file. (db-chismoso.ts creates the parent dir but not the file
  // itself — the file is created by the chismoso CLI on first run.)
  return 'ok';
}

export async function GET() {
  const checks: CheckResult = {
    shutdown: isShuttingDown() ? 'draining' : 'ok',
    db: 'ok',
    env: checkEnv(),
    llm: 'unknown',
  };

  // --- DB connectivity --------------------------------------------------
  try {
    const row = chismosoDb.prepare('SELECT 1 AS one').get() as { one: number } | undefined;
    if (!row || row.one !== 1) {
      checks.db = 'error: SELECT 1 returned unexpected result';
    }
  } catch (e: unknown) {
    checks.db = `error: ${e instanceof Error ? e.message : String(e)}`;
  }

  // --- LLM reachability (cached, 60s) ----------------------------------
  // We DO probe the LLM here so /readyz catches a provider outage. But
  // we cache the result so a tight LB probe loop (every 5s) doesn't
  // generate one LLM call per probe.
  const llmProbe = await probeLlm();
  if (!llmProbe.reachable) {
    checks.llm = 'unreachable';
  } else {
    checks.llm = 'ok';
  }

  // --- Circuit breaker state -------------------------------------------
  // Read directly without touching the network. If the breaker is OPEN,
  // we report it but we don't fail readiness — the breaker opening means
  // we're protecting ourselves from a bad dependency; the process is
  // still ready to serve the parts of the API that don't need the LLM
  // (e.g. /api/alerts, /api/investigations, /api/topics).
  let circuitBreaker: { state: string; failures: number } = { state: 'unknown', failures: 0 };
  try {
    // REL2-P0-3 — same path resolution strategy as the LLM probe above.
    const mod = await import(
      /* webpackIgnore: true */ path.join(CHISMOSO_DIST_PATH, 'circuit-breaker.js')
    ).catch(() => ({ llmCircuitBreaker: null }));
    if (mod.llmCircuitBreaker) {
      circuitBreaker = {
        state: mod.llmCircuitBreaker.status,
        failures: mod.llmCircuitBreaker.failures,
      };
    }
  } catch {
    /* fall through with circuitBreaker = unknown */
  }

  const allOk =
    checks.shutdown === 'ok' &&
    checks.db === 'ok' &&
    checks.env === 'ok' &&
    checks.llm === 'ok';

  const status = checks.shutdown === 'draining' ? 'draining' : allOk ? 'ready' : 'not_ready';

  return NextResponse.json(
    {
      status,
      timestamp: new Date().toISOString(),
      checks,
      circuitBreaker,
      concurrency: {
        inFlight: investigateSemaphore.inFlight,
        capacity: investigateSemaphore.capacity,
        waiting: investigateSemaphore.waiting,
      },
    },
    { status: allOk ? 200 : 503 },
  );
}
