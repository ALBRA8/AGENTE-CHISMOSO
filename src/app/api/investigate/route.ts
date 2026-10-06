import { NextRequest } from 'next/server';
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
} from '@/lib/api-response';
import {
  validateObjective,
  validateGeography,
  validateMaxQueries,
  validateMaxRuntimeMs,
} from '@/lib/validation';

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

/**
 * POST /api/investigate
 *
 * Spawns CHISMOSO CLI as a child process and waits for it to complete.
 * Returns the full report (markdown + machine JSON) when done.
 *
 * This is a synchronous endpoint (long-running). For V2 we'd switch to a
 * job-based pattern with polling, but for V1 sync is fine because the
 * preview environment supports up to 5 min request duration.
 */
export async function POST(req: NextRequest) {
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
      const child = spawn(childCmd, childArgs, {
        cwd: CHISMOSO_ROOT,
        env: { ...process.env, CHISMOSO_LOG_LEVEL: 'WARN' },
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
      const abortListener = () => {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        // Give it 2s to clean up gracefully, then SIGKILL.
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }, 2000);
      };
      req.signal.addEventListener('abort', abortListener);

      // Safety timeout — kill the child if it exceeds maxRuntimeMs + 30s grace.
      const timeout = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
      }, maxRuntimeMs + 30_000);

      child.on('close', (code) => {
        clearTimeout(timeout);
        req.signal.removeEventListener('abort', abortListener);
        resolve({ stdout, stderr, code });
      });
      child.on('error', (err) => {
        clearTimeout(timeout);
        req.signal.removeEventListener('abort', abortListener);
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
    // Include the last 200 lines of stderr for debugging (so user can see what providers did).
    log: result.stderr.split('\n').slice(-200).join('\n'),
  };

  // Investigation genuinely failed (CLI exit non-zero AND status not in the
  // success-like set) → 500 with canonical error shape. Successful or
  // soft-state (PARTIAL / INSUFFICIENT_EVIDENCE) results stay 200.
  if (!isOk) {
    return apiServerError('Investigation failed', payload);
  }
  return apiOk(payload);
}
