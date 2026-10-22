import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { rateLimit, getClientIP, LIMITS } from '@/lib/rate-limit';
import {
  apiBadRequest,
  apiOk,
  apiRateLimited,
  apiServerError,
  apiUnavailable,
} from '@/lib/api-response';
import {
  validateObjective,
  validateGeography,
  validateMaxQueries,
  validateMaxRuntimeMs,
} from '@/lib/validation';
import { authedPOST, getAuthStatus } from '@/lib/middleware';
import { appendAudit } from '@/lib/audit-log-server';
import { activeInvestigationsGauge, investigationsCounter } from '@/lib/metrics';
import { investigateSemaphore } from '@/lib/concurrency';
import { onShutdown, isShuttingDown } from '@/lib/graceful-shutdown';
import { chismosoWritableDb } from '@/lib/db-chismoso-writable';
import { getCurrentTraceId, TRACE_ID_ENV } from '@/lib/trace-id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const CHISMOSO_ROOT = '/home/z/my-project/chismoso';
const OUTPUT_DIR = '/home/z/my-project/download/chismoso';

/**
 * Pre-compiled CLI is preferred (faster startup — no TS compilation per call).
 * Falls back to `npx tsx src/cli.ts` when dist/ hasn't been built yet.
 */
const COMPILED_CLI = `${CHISMOSO_ROOT}/dist/cli.js`;
const USE_COMPILED = existsSync(COMPILED_CLI);

/**
 * How long a 429 (Too Many Investigations) tells the client to wait before
 * retrying. A bit less than the average investigation duration so an early-
 * retryer has a real chance of getting a slot.
 */
const RETRY_AFTER_SEC = 30;

interface InvestigateBody {
  objective: unknown;
  geography?: unknown;
  maxQueries?: unknown;
  maxRuntimeMs?: unknown;
}

interface ChismosoReport {
  investigationId: string;
  status: string;
  markdown: string;
  machine: any;
}

interface IdempotencyRecord {
  key: string;
  investigation_id: string;
  objective: string;
  geography: string | null;
  status: string | null;
  created_at: string;
  completed_at: string | null;
}

// ---------------------------------------------------------------------------
// REL-P0-10 — Idempotency-Key table.
//
// Schema is created on first cold start (idempotent IF NOT EXISTS). The
// chismosoWritableDb singleton is already opened by the alerts subsystem;
// we reuse it instead of opening a new connection. busy_timeout is set by
// the writable singleton's own bootstrap.
// ---------------------------------------------------------------------------
function ensureIdempotencyTable(): void {
  chismosoWritableDb.exec(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key              TEXT PRIMARY KEY,
      investigation_id TEXT NOT NULL,
      objective        TEXT NOT NULL,
      geography        TEXT,
      status           TEXT,
      created_at       TEXT NOT NULL,
      completed_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_idempotency_keys_inv ON idempotency_keys(investigation_id);
  `);
}

function lookupIdempotency(key: string): IdempotencyRecord | null {
  try {
    const row = chismosoWritableDb
      .prepare('SELECT * FROM idempotency_keys WHERE key = ?')
      .get(key) as IdempotencyRecord | undefined;
    return row ?? null;
  } catch {
    // Table not created yet? create + retry once.
    ensureIdempotencyTable();
    try {
      const row = chismosoWritableDb
        .prepare('SELECT * FROM idempotency_keys WHERE key = ?')
        .get(key) as IdempotencyRecord | undefined;
      return row ?? null;
    } catch {
      return null;
    }
  }
}

function storeIdempotency(
  key: string,
  investigationId: string,
  objective: string,
  geography: string,
  status: string,
): void {
  try {
    chismosoWritableDb
      .prepare(
        `INSERT OR REPLACE INTO idempotency_keys
           (key, investigation_id, objective, geography, status, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        key,
        investigationId,
        objective,
        geography,
        status,
        new Date().toISOString(),
        new Date().toISOString(),
      );
  } catch {
    /* best-effort — idempotency is a nice-to-have, not a correctness invariant */
  }
}

/**
 * Read the cached report (markdown + machine JSON) for a previously completed
 * investigation. Returns null if the files don't exist (operator may have run
 * cleanup-reports.sh) — in that case the caller proceeds with a fresh run.
 */
async function loadCachedReport(
  investigationId: string,
  objective: string,
  geography: string,
): Promise<{ status: string; report: ChismosoReport } | null> {
  const fs = await import('node:fs/promises');
  const machinePath = path.join(OUTPUT_DIR, `report-${investigationId}.json`);
  const mdPath = path.join(OUTPUT_DIR, `report-${investigationId}.md`);
  try {
    const machineRaw = await fs.readFile(machinePath, 'utf8');
    const machine = JSON.parse(machineRaw);
    let markdown = '';
    try {
      markdown = await fs.readFile(mdPath, 'utf8');
    } catch {
      /* keep empty markdown */
    }
    return {
      status: 'COMPLETED',
      report: {
        investigationId,
        status: 'COMPLETED',
        markdown,
        machine,
      },
    };
  } catch {
    // Files missing — fall through to a fresh run.
    void objective;
    void geography;
    return null;
  }
}

/**
 * POST /api/investigate
 *
 * Spawns CHISMOSO CLI as a child process and waits for it to complete.
 * Returns the full report (markdown + machine JSON) when done.
 *
 * This is a synchronous endpoint (long-running). For V2 we'd switch to a
 * job-based pattern with polling, but for V1 sync is fine because the
 * preview environment supports up to 5 min request duration.
 *
 * §34 / audit C2 — Protected by `authedPOST`: when `CHISMOSO_AUTH_ENABLED=true`,
 * requests must carry a valid `X-Chismoso-Agent` header (SHA-256 of the
 * token must appear in `CHISMOSO_AUTH_TOKENS`). When auth is disabled
 * (default for dev), all callers are allowed.
 *
 * V1.5 hardening (REL-P0-003, REL-P0-004, REL-P0-005, REL-P0-10):
 *   - process-wide semaphore caps concurrent investigations at
 *     CHISMOSO_MAX_CONCURRENT_INVESTIGATIONS (default 3); overflow gets
 *     HTTP 429 + Retry-After instead of a 5-minute hang
 *   - SIGTERM / SIGINT received by the Next.js process now kill the
 *     spawned child too (previously only client-abort did)
 *   - Idempotency-Key header short-circuits duplicate POSTs to a cached
 *     report (so a client-side retry after a network blip doesn't
 *     double-spend LLM tokens)
 *   - 503 returned while the process is shutting down so the load
 *     balancer routes traffic away during a deploy
 */
export const POST = authedPOST(async (req: NextRequest) => {
  // --- Drain / shutdown guard (REL-P0-004) ------------------------------
  // New traffic should NOT enter the long-running spawn path while we're
  // draining on SIGTERM. The readiness probe returns 503 too; this is a
  // belt-and-braces in-handler check.
  if (isShuttingDown()) {
    return apiUnavailable('Server is shutting down');
  }

  // --- Rate limit (per-IP, 5/min) ---------------------------------------
  const ip = getClientIP(req);
  const rl = rateLimit(`investigate:${ip}`, LIMITS.investigate);
  if (!rl.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
    return apiRateLimited(retryAfter);
  }

  // --- Parse body ------------------------------------------------------
  let body: InvestigateBody;
  try {
    body = (await req.json()) as InvestigateBody;
  } catch {
    return apiBadRequest('Invalid JSON body');
  }

  // --- Validate inputs -------------------------------------------------
  const objectiveRes = validateObjective(body.objective);
  if (!objectiveRes.ok) {
    return apiBadRequest(objectiveRes.error!);
  }
  const geographyRes = validateGeography(body.geography);
  if (!geographyRes.ok) {
    return apiBadRequest(geographyRes.error!);
  }
  const maxQueriesRes = validateMaxQueries(body.maxQueries);
  if (!maxQueriesRes.ok) {
    return apiBadRequest(maxQueriesRes.error!);
  }
  const maxRuntimeMsRes = validateMaxRuntimeMs(body.maxRuntimeMs);
  if (!maxRuntimeMsRes.ok) {
    return apiBadRequest(maxRuntimeMsRes.error!);
  }
  const objective = objectiveRes.value!;
  const geography = geographyRes.value!;
  const maxQueries = maxQueriesRes.value!;
  const maxRuntimeMs = maxRuntimeMsRes.value!;

  // --- REL-P0-10 — Idempotency-Key short-circuit ----------------------
  // If the client sends an Idempotency-Key and we already have a cached
  // result for it, return that result with 200 (so retries don't double-
  // spend LLM tokens). If we have a record but the report files are gone
  // (cleanup-reports.sh ran), fall through to a fresh run and overwrite.
  const idempotencyKey = req.headers.get('idempotency-key')?.trim();
  if (idempotencyKey && idempotencyKey.length > 0 && idempotencyKey.length <= 200) {
    const cached = lookupIdempotency(idempotencyKey);
    if (cached) {
      const report = await loadCachedReport(cached.investigation_id, objective, geography);
      if (report) {
        return apiOk({
          status: report.status,
          investigationId: cached.investigation_id,
          idempotent: true,
          counts: null,
          report: report.report,
          // R2-IMP-SEC (audit H-7): the `log` field is gated on
          // NODE_ENV !== 'production'. The cached idempotent branch
          // only ever returns this static marker string, so it's
          // harmless — but we keep the gate for shape consistency
          // with the fresh-run branch (so a client always sees `log`
          // present in dev and absent in prod, never mixed).
          ...(process.env.NODE_ENV !== 'production'
            ? { log: '[idempotent] returned cached report' }
            : {}),
        });
      }
    }
  }

  // --- REL-P0-3 — Concurrency cap (process-wide semaphore) ------------
  // 50 concurrent users × ~80 MB RSS = 4 GB just for the CLI processes.
  // The semaphore caps in-flight investigations process-wide so the host
  // doesn't fork-storm itself to death. We check available() up-front so
  // we can return 429 immediately; otherwise we'd queue behind 3 in-
  // flight investigations for up to 5 min each.
  if (investigateSemaphore.available === 0) {
    return NextResponse.json(
      {
        error: 'Too many concurrent investigations',
        details: {
          retryAfterSec: RETRY_AFTER_SEC,
          inFlight: investigateSemaphore.inFlight,
          capacity: investigateSemaphore.capacity,
          waiting: investigateSemaphore.waiting,
        },
      },
      {
        status: 429,
        headers: { 'Retry-After': String(RETRY_AFTER_SEC) },
      },
    );
  }
  const releaseSlot = await investigateSemaphore.acquire();

  // --- Metrics + audit log (start) — fire-and-forget -----------------
  try {
    activeInvestigationsGauge.inc();
    investigationsCounter.inc({ status: 'started' });
  } catch {
    /* swallow */
  }
  const authStatus = getAuthStatus(req);
  const investigateActor =
    authStatus.ok && authStatus.reason !== 'auth_disabled'
      ? `user:operator`
      : 'agent:chismoso';
  appendAudit({
    actor: investigateActor,
    action: 'investigate.start',
    target_type: 'investigation',
    target_id: 'pending',
    ip: getClientIP(req),
    user_agent: req.headers.get('user-agent') ?? undefined,
    metadata: {
      objective_truncated: objective.slice(0, 200),
      geography,
      max_queries: maxQueries,
      max_runtime_ms: maxRuntimeMs,
      idempotency_key: idempotencyKey ?? undefined,
    },
  });

  // Build CLI args. We pass --save so reports are persisted to disk too.
  // When the pre-compiled CLI exists, we invoke `node dist/cli.js ...` (no
  // TS compilation overhead — ~370ms faster startup than `npx tsx src/cli.ts`).
  // Otherwise we fall back to the tsx dev runner.
  const cliArgs = [
    'investigate',
    objective,
    `--geography=${geography}`,
    `--max-queries=${maxQueries}`,
    `--max-runtime-ms=${maxRuntimeMs}`,
    '--save',
  ];

  const childCmd = USE_COMPILED ? 'node' : 'npx';
  const childArgs = USE_COMPILED
    ? [COMPILED_CLI, ...cliArgs]
    : ['tsx', 'src/cli.ts', ...cliArgs];

  // Spawn child process. Capture stdout (markdown report) and stderr (logs).
  const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>(
    (resolve) => {
      const traceId = getCurrentTraceId() ?? 'no-trace';
      const child = spawn(childCmd, childArgs, {
        cwd: CHISMOSO_ROOT,
        env: {
          ...process.env,
          CHISMOSO_LOG_LEVEL: 'WARN',
          // Propagate the trace_id to the subprocess so the chismoso
          // logger can include it in every log line. This is the
          // cross-process trace correlation bridge.
          [TRACE_ID_ENV]: traceId,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => {
        stdout += d.toString();
      });
      child.stderr.on('data', (d) => {
        stderr += d.toString();
      });

      // FIX-2 (AUDIT-PERF Critical #5): if the client disconnects (closes
      // the tab, navigates away, network drops) the request signal fires
      // 'abort'. Without this handler the spawned chismoso CLI would keep
      // running for up to maxRuntimeMs + 30s — consuming provider quota
      // and CPU for a response no one will ever read. We kill it promptly.
      const killChild = () => {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        // Give it 2s to clean up gracefully, then SIGKILL.
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }, 2000).unref?.();
      };
      const abortListener = () => killChild();
      req.signal.addEventListener('abort', abortListener);

      // REL-P0-004 — also kill the child on SIGTERM/SIGINT received by the
      // Next.js process (deploy roll, container stop, OOM-kill graceful).
      // Without this the child outlives the parent for up to 5 min.
      const unregisterShutdown = onShutdown(() => killChild());

      // Safety timeout — kill the child if it exceeds maxRuntimeMs + 30s grace.
      const timeout = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
      }, maxRuntimeMs + 30_000);

      child.on('close', (code) => {
        clearTimeout(timeout);
        req.signal.removeEventListener('abort', abortListener);
        unregisterShutdown();
        resolve({ stdout, stderr, code });
      });
      child.on('error', (err) => {
        clearTimeout(timeout);
        req.signal.removeEventListener('abort', abortListener);
        unregisterShutdown();
        resolve({ stdout, stderr: stderr + '\n' + (err?.message ?? String(err)), code: -1 });
      });
    },
  );

  // The CLI prints the markdown report to stdout. The report file is also saved
  // to OUTPUT_DIR. We parse the investigation ID from stderr (where [chismoso] logs go).
  const idMatch = result.stderr.match(/Reports saved to .*\/report-(inv_[\w]+)\.\{md,json\}/);
  const investigationId = idMatch?.[1] ?? 'unknown';

  // Load the saved machine JSON if available — gives us full structured data.
  let machine: any = null;
  let markdown = result.stdout;
  try {
    const machinePath = path.join(OUTPUT_DIR, `report-${investigationId}.json`);
    const machineRaw = await import('node:fs/promises').then((m) => m.readFile(machinePath, 'utf8'));
    machine = JSON.parse(machineRaw);
  } catch {
    // Fallback: if file not found, build a minimal machine object from CLI output.
    machine = {
      investigationId,
      query: objective,
      scope: geography,
      generatedAt: new Date().toISOString(),
      limitations: ['Could not load structured report file.'],
    };
  }

  // Also prefer the saved markdown (cleaner than stdout which mixes log lines).
  try {
    const mdPath = path.join(OUTPUT_DIR, `report-${investigationId}.md`);
    const md = await import('node:fs/promises').then((m) => m.readFile(mdPath, 'utf8'));
    if (md && md.length > 0) markdown = md;
  } catch {
    /* keep stdout version */
  }

  // Parse status from stderr line "Completed in Xms — status: COMPLETED"
  const statusMatch = result.stderr.match(/status:\s*(\w+)/);
  const status = statusMatch?.[1] ?? (result.code === 0 ? 'COMPLETED' : 'FAILED');

  // Parse signal/trend/opportunity counts from stderr.
  const countsMatch = result.stderr.match(/signals:\s*(\d+)\s+trends:\s*(\d+)\s+problems:\s*(\d+)\s+opportunities:\s*(\d+)/);
  const counts = countsMatch
    ? {
        signals: parseInt(countsMatch[1], 10),
        trends: parseInt(countsMatch[2], 10),
        problems: parseInt(countsMatch[3], 10),
        opportunities: parseInt(countsMatch[4], 10),
      }
    : null;

  const report: ChismosoReport = {
    investigationId,
    status,
    markdown,
    machine,
  };

  const isOk =
    result.code === 0 ||
    status === 'COMPLETED' ||
    status === 'PARTIAL' ||
    status === 'INSUFFICIENT_EVIDENCE';

  const payload = {
    status,
    investigationId,
    counts,
    report,
    // R2-IMP-SEC (audit H-7 + R2-9): the `log` field — last 200 lines
    // of the chismoso CLI's stderr — was previously returned on EVERY
    // successful response. Stderr contains absolute file paths
    // (`/home/z/my-project/chismoso/dist/...`), provider echoes, and
    // any thrown stack — exactly the kind of internal detail the
    // audit's H-7 finding calls out. In production we omit it entirely;
    // operators grep the server-side log keyed by `investigationId`
    // (which IS returned) for triage. Dev keeps the field so the
    // operator can eyeball CLI progress without leaving the dashboard.
    ...(process.env.NODE_ENV !== 'production'
      ? { log: result.stderr.split('\n').slice(-200).join('\n') }
      : {}),
  };

  // --- REL-P0-10 — Record idempotency mapping ----------------------------
  // Only on successful completion so a failed run can be retried with the
  // same key without returning the cached failure.
  if (idempotencyKey && isOk) {
    storeIdempotency(idempotencyKey, investigationId, objective, geography, status);
  }

  // --- Metrics + audit log (complete) — fire-and-forget ----------------
  try {
    activeInvestigationsGauge.dec();
    investigationsCounter.inc({
      status: isOk ? status : 'failed',
    });
  } catch {
    /* swallow */
  }
  appendAudit({
    actor: investigateActor,
    action: 'investigate.complete',
    target_type: 'investigation',
    target_id: investigationId,
    ip: getClientIP(req),
    user_agent: req.headers.get('user-agent') ?? undefined,
    metadata: {
      status,
      exit_code: result.code,
      counts,
      objective_truncated: objective.slice(0, 200),
      geography,
    },
  });

  // Release the concurrency slot — always, success or failure.
  releaseSlot();

  // Investigation genuinely failed (CLI exit non-zero AND status not in the
  // success-like set) → 500 with canonical error shape. Successful or
  // soft-state (PARTIAL / INSUFFICIENT_EVIDENCE) results stay 200.
  if (!isOk) {
    return apiServerError('Investigation failed', payload);
  }
  return apiOk(payload);
});
