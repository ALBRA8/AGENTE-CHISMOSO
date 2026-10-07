import { NextRequest } from 'next/server';
import { chismosoDb } from '@/lib/db-chismoso';
import { apiOk, apiServerError } from '@/lib/api-response';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { authedPOST } from '@/lib/middleware';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CHISMOSO_ROOT = '/home/z/my-project/chismoso';
const COMPILED_CLI = `${CHISMOSO_ROOT}/dist/cli.js`;
const USE_COMPILED = existsSync(COMPILED_CLI);

/**
 * POST /api/memory/decay
 *
 * Triggers a manual temporal-decay pass over all ACTIVE memories via the
 * `chismoso memory decay` CLI subcommand. Returns the counts of how many
 * memories were updated / decayed / archived by the pass.
 *
 * Response shape:
 *   {
 *     ranAt: string (ISO),
 *     action: "decay",
 *     updated: number,    — total rows written back (decayed + archived)
 *     decayed: number,    — rows demoted ACTIVE → DECAYED (relevance < 0.1)
 *     archived: number    — rows demoted → ARCHIVED (relevance < 0.01)
 *   }
 *
 * Spawns the CLI rather than opening a writable connection in-process — see
 * the comment block on POST /api/memory for the rationale.
 *
 * §34 / audit C2 — Protected by `authedPOST`: when `CHISMOSO_AUTH_ENABLED=true`,
 * requests must carry a valid `X-Chismoso-Agent` header.
 */
export const POST = authedPOST(async () => {
  const childCmd = USE_COMPILED ? 'node' : 'npx';
  const childArgs = USE_COMPILED
    ? [COMPILED_CLI, 'memory', 'decay']
    : ['tsx', 'src/cli.ts', 'memory', 'decay'];

  try {
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
        child.on('close', (code) => resolve({ stdout, stderr, code }));
        child.on('error', (err) =>
          resolve({
            stdout,
            stderr: stderr + '\n' + (err?.message ?? String(err)),
            code: -1,
          }),
        );
      },
    );

    let parsed: { updated?: number; decayed?: number; archived?: number } | null = null;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      /* keep parsed = null */
    }

    if (result.code !== 0) {
      return apiServerError('memory_decay_failed', {
        exitCode: result.code,
        stderr: result.stderr.split('\n').slice(-50).join('\n'),
        ranAt: new Date().toISOString(),
      });
    }

    return apiOk({
      ranAt: new Date().toISOString(),
      action: 'decay',
      updated: parsed?.updated ?? 0,
      decayed: parsed?.decayed ?? 0,
      archived: parsed?.archived ?? 0,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('memory_decay_failed', { message, ranAt: new Date().toISOString() });
  }
});

/**
 * GET /api/memory/decay
 *
 * Returns a cheap "what would the next decay pass do?" preview WITHOUT
 * writing anything. Computes the deltas in-process by reading every ACTIVE
 * memory and applying computeRelevance() locally. Useful for dashboards
 * that want to show "5 memories are about to decay" before the operator
 * clicks the archive button.
 *
 * Note: this is a read-only operation, so it uses the in-process readonly
 * singleton chismosoDb — no CLI spawn needed.
 */
export async function GET(_req: NextRequest) {
  try {
    let tableExists = true;
    try {
      chismosoDb.prepare('SELECT 1 FROM memories LIMIT 1').get();
    } catch {
      tableExists = false;
    }
    if (!tableExists) {
      return apiOk({
        ranAt: new Date().toISOString(),
        tableMissing: true,
        wouldDecay: 0,
        wouldArchive: 0,
        totalActive: 0,
      });
    }

    interface MemoryRow {
      id: string;
      confidence: number | null;
      utility: number | null;
      updated_at: string;
      decay_half_life_days: number | null;
      status: string;
      relevance: number | null;
    }
    const rows = chismosoDb
      .prepare('SELECT id, confidence, utility, updated_at, decay_half_life_days, status, relevance FROM memories WHERE status = ?')
      .all('ACTIVE') as MemoryRow[];

    const now = Date.now();
    const DEFAULT_HALF_LIFE_DAYS = 30;
    let wouldDecay = 0;
    let wouldArchive = 0;
    for (const r of rows) {
      const updatedAt = new Date(r.updated_at).getTime();
      if (!Number.isFinite(updatedAt)) continue;
      const ageDays = (now - updatedAt) / (1000 * 60 * 60 * 24);
      const halfLife = r.decay_half_life_days && r.decay_half_life_days > 0 ? r.decay_half_life_days : DEFAULT_HALF_LIFE_DAYS;
      const utility = r.utility ?? 0;
      const confidence = r.confidence ?? 0;
      const decayFactor = Math.pow(0.5, ageDays / halfLife);
      const utilityBoost = 1 + utility * 0.5;
      let relevance = confidence * decayFactor * utilityBoost;
      if (!Number.isFinite(relevance)) relevance = 0;
      if (relevance < 0) relevance = 0;
      if (relevance > 1) relevance = 1;
      if (relevance < 0.01) wouldArchive++;
      else if (relevance < 0.1) wouldDecay++;
    }

    return apiOk({
      ranAt: new Date().toISOString(),
      action: 'decay_preview',
      totalActive: rows.length,
      wouldDecay,
      wouldArchive,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('memory_decay_preview_failed', { message, ranAt: new Date().toISOString() });
  }
}
