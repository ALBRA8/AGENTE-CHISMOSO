/**
 * GET  /api/doctor         — run all 14 doctor checks (read-only), return JSON.
 * POST /api/doctor?fix=true — run all 14 checks + apply safe deterministic fixes.
 *
 * Task IMP-3, spec §31 / §32.
 *
 * === Architecture ===
 *
 * The Doctor class lives in `chismoso/src/doctor/index.ts` — a separate
 * Node package whose TS types are NOT directly importable from Next.js
 * (different tsconfig, different module resolution, different deps).
 * Mirroring the pattern in `/api/providers`, this route spawns the
 * compiled chismoso CLI (`node dist/cli.js doctor --json`) and parses
 * the JSON it prints to stdout.
 *
 * Why spawn instead of importing:
 *   1. The doctor opens a SEPARATE SQLite connection (readwrite) to run
 *      integrity_check and (with --fix) create missing tables. Reusing
 *      the Next.js singleton readonly connection would either fail the
 *      writes or require widening the singleton to readwrite (which
 *      would break the dashboard's concurrency assumptions).
 *   2. The CLI is the only entry point that knows how to construct the
 *      full Orchestrator graph (Providers + Repositories + AnomalyDetector
 *      + ToolRegistry + LLMClient). Duplicating that wiring in the Next.js
 *      side would create a maintenance footgun.
 *   3. Spawning isolates failures — a crashing check inside the doctor
 *      subprocess never takes down the Next.js process.
 *
 * === Caching ===
 *
 * None. The doctor is operator-on-demand — operators want fresh results.
 * A 5-min cache like /api/providers would be misleading (a subsystem
 * could be failing right now but the cached "OK" would hide it). The
 * doctor takes ~50-200ms cold; that's acceptable for an operator tool.
 *
 * === Response shape ===
 *
 * GET returns the DoctorReport JSON exactly as the CLI emits it:
 *   {
 *     generated_at: string,
 *     version: string,
 *     overall_status: 'OK' | 'DEGRADED' | 'FAIL',
 *     checks: DoctorCheck[],
 *     summary: { ok, degraded, fail, unknown },
 *     auto_fixes_applied: number
 *   }
 *
 * POST returns the same shape with `auto_fixes_applied` reflecting the
 * fixes that were applied (0 if no fixable issues, ≥1 if fixes ran).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { apiOk, apiServerError } from '@/lib/api-response';
import { getCached, setCached, invalidate } from '@/lib/cache';
import { authedPOST } from '@/lib/middleware';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const CHISMOSO_ROOT = '/home/z/my-project/chismoso';

/**
 * Pre-compiled CLI is preferred (faster startup — no TS compilation per call).
 * Falls back to `npx tsx src/cli.ts` when dist/ hasn't been built yet.
 */
const COMPILED_CLI = `${CHISMOSO_ROOT}/dist/cli.js`;
const USE_COMPILED = existsSync(COMPILED_CLI);

/**
 * The doctor scan can take a few hundred ms on a cold DB. To prevent
 * a thundering-herd of dashboard polls from spawning N concurrent CLI
 * processes, we dedupe concurrent requests: only one doctor run is in
 * flight at a time. Concurrent callers await the same promise.
 *
 * The dedupe is held for at most 10 seconds — beyond that we let the
 * next caller spawn a fresh process (the previous one likely hung).
 */
let inflightDoctor: Promise<unknown> | null = null;
const DOCTOR_DEDUPE_TTL_MS = 10_000;

interface DoctorReportJSON {
  generated_at: string;
  version: string;
  overall_status: 'OK' | 'DEGRADED' | 'FAIL';
  checks: unknown[];
  summary: { ok: number; degraded: number; fail: number; unknown: number };
  auto_fixes_applied: number;
}

/**
 * Spawns the chismoso CLI with the doctor command and resolves with the
 * parsed JSON report. Rejects on non-zero exit code or unparseable stdout.
 *
 * `applyFixes` toggles the `--fix` flag — when true, the doctor will
 * mkdir missing data/ dirs and CREATE TABLE IF NOT EXISTS missing
 * embeddings/memories/alerts tables.
 */
function runDoctorCLI(applyFixes: boolean): Promise<DoctorReportJSON> {
  const childCmd = USE_COMPILED ? 'node' : 'npx';
  const childArgs = USE_COMPILED
    ? applyFixes
      ? [COMPILED_CLI, 'doctor', '--json', '--fix']
      : [COMPILED_CLI, 'doctor', '--json']
    : applyFixes
      ? ['tsx', 'src/cli.ts', 'doctor', '--json', '--fix']
      : ['tsx', 'src/cli.ts', 'doctor', '--json'];

  return new Promise<DoctorReportJSON>((resolve, reject) => {
    const child = spawn(childCmd, childArgs, {
      cwd: CHISMOSO_ROOT,
      env: {
        ...process.env,
        // Silence the chismoso logger so stderr stays clean (the CLI
        // also writes the doctor's colored summary to stderr when
        // --json is not used; with --json, stderr is empty on success).
        CHISMOSO_LOG_LEVEL: 'WARN',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`doctor CLI exited ${code}: ${stderr.trim().slice(0, 400)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as DoctorReportJSON;
        resolve(parsed);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        reject(new Error(`doctor CLI returned unparseable JSON: ${msg}; stdout=${stdout.slice(0, 200)}`));
      }
    });
    child.on('error', (err) => {
      reject(new Error(`failed to spawn doctor CLI: ${err.message}`));
    });
  });
}

/**
 * Dedupes concurrent doctor runs against a single in-flight promise.
 *
 * If a doctor run is already in progress, the new caller awaits the same
 * promise instead of spawning a second CLI process. This prevents a
 * dashboard refresh storm from spawning N processes against the same DB.
 *
 * The dedupe is cleared after DOCTOR_DEDUPE_TTL_MS so a hung CLI process
 * doesn't permanently block subsequent calls.
 */
async function runDoctorDeduped(applyFixes: boolean): Promise<DoctorReportJSON> {
  // POST ?fix=true is NOT deduped — operators want every --fix invocation
  // to actually run (e.g. they may have just deleted a table and want the
  // doctor to recreate it). Only the read-only GET path is deduped.
  if (!applyFixes && inflightDoctor) {
    try {
      return await Promise.race([
        inflightDoctor as Promise<DoctorReportJSON>,
        new Promise<DoctorReportJSON>((_, reject) =>
          setTimeout(() => reject(new Error('doctor dedupe timed out')), DOCTOR_DEDUPE_TTL_MS),
        ),
      ]);
    } catch {
      // The in-flight run hung or rejected — fall through and spawn a fresh one.
    }
  }
  const p = runDoctorCLI(applyFixes).finally(() => {
    // Clear the dedupe slot once the CLI returns. We do NOT keep the
    // result cached — operators expect fresh data on the next call.
    if (inflightDoctor === p) inflightDoctor = null;
  });
  if (!applyFixes) inflightDoctor = p;
  return p;
}

/**
 * GET /api/doctor
 *
 * Runs all 14 doctor checks (read-only) and returns the JSON report.
 *
 * Query params:
 *   ?cache=true   Use the 60s response cache (default: off). Useful when
 *                 embedding the doctor summary in a dashboard that polls
 *                 frequently.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const useCache = url.searchParams.get('cache') === 'true';

  if (useCache) {
    const cached = getCached<DoctorReportJSON>('doctor:report');
    if (cached) {
      return apiOk({ ...cached, cached: true });
    }
  }

  try {
    const report = await runDoctorDeduped(false);
    if (useCache) {
      // 60-second cache — long enough to absorb dashboard poll storms,
      // short enough that a subsystem failure is surfaced within a minute.
      setCached('doctor:report', report, 60_000);
    }
    return apiOk({ ...report, cached: false });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('doctor_run_failed', { message });
  }
}

/**
 * POST /api/doctor
 *
 * Runs all 14 checks AND applies safe deterministic fixes:
 *   - mkdir data/ if missing
 *   - CREATE TABLE IF NOT EXISTS signal_embeddings
 *   - (configuration fix is documented but a no-op in practice — the
 *      DB is opened by the doctor before the config check runs)
 *
 * Query params:
 *   ?fix=true   Required to actually apply fixes. Without it, POST is
 *               equivalent to GET (read-only run). This gate exists so
 *               a stray POST request from a misconfigured client does
 *               not silently mutate the DB.
 *
 * Response shape: same DoctorReport JSON as GET, with `auto_fixes_applied`
 * reflecting the number of fixes that ran.
 *
 * §34 / audit C2 — Protected by `authedPOST`: when `CHISMOSO_AUTH_ENABLED=true`,
 * requests must carry a valid `X-Chismoso-Agent` header. Without ?fix=true the
 * POST is read-only (calls GET), but we still require auth so an anonymous
 * caller cannot probe the doctor surface.
 */
export const POST = authedPOST(async (req: NextRequest) => {
  const url = new URL(req.url);
  const fixRequested = url.searchParams.get('fix') === 'true';

  if (!fixRequested) {
    // Without ?fix=true, POST is read-only. We don't 400 — we just run
    // the same scan as GET. This keeps the route forgiving for clients
    // that POST out of habit.
    return GET(req);
  }

  try {
    const report = await runDoctorDeduped(true);
    // Invalidate any cached read-only report — fixes may have changed
    // the subsystem state, so the next GET should re-scan.
    invalidate('doctor:report');
    return apiOk(report);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('doctor_fix_failed', { message });
  }
});
