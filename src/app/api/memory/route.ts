import { NextRequest } from 'next/server';
import { apiOk, apiBadRequest, apiServerError, apiError } from '@/lib/api-response';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { authedPOST } from '@/lib/middleware';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CHISMOSO_ROOT = '/home/z/my-project/chismoso';
const COMPILED_CLI = `${CHISMOSO_ROOT}/dist/cli.js`;
const USE_COMPILED = existsSync(COMPILED_CLI);

/**
 * POST /api/memory
 *
 * Operator-only memory management endpoint. Accepts an `action` field and
 * dispatches to the appropriate `chismoso memory` CLI subcommand. Used by the
 * dashboard's "Memory" panel to let operators verify, archive, or decay
 * memories without leaving the UI.
 *
 * Body shape:
 *   {
 *     action: 'verify' | 'archive' | 'decay',
 *     id?:    string  (required for 'verify' | 'archive', ignored for 'decay')
 *   }
 *
 * Why we spawn the CLI instead of opening a writable DB connection in-process:
 *   - Writable chismoso DB connections must be opened from the chismoso/
 *     process (different tsconfig, different deps). The Next.js process only
 *     holds a readonly singleton (src/lib/db-chismoso.ts).
 *   - Each CLI invocation opens + closes its own connection, avoiding
 *     long-lived write locks that would block the dashboard's reads.
 *   - Spawning isolates failures — a crashing CLI never takes down the
 *     Next.js process.
 *
 * §34 / audit C2 — Protected by `authedPOST`: when `CHISMOSO_AUTH_ENABLED=true`,
 * requests must carry a valid `X-Chismoso-Agent` header. Memory management is
 * an operator-only write surface — anonymous callers must not be able to
 * archive or decay memories.
 *
 * See also:
 *   - POST /api/memory/decay — convenience shortcut for `action:'decay'`.
 *   - GET /api/memory/[id]  — fetch a single memory record (read-only).
 */
export const POST = authedPOST(async (req: NextRequest) => {
  let body: { action?: unknown; id?: unknown };
  try {
    body = (await req.json()) as { action?: unknown; id?: unknown };
  } catch {
    return apiBadRequest('Invalid JSON body', { code: 'invalid_json' });
  }

  const action =
    typeof body.action === 'string' ? body.action : '';
  if (!action) {
    return apiBadRequest('Field "action" is required', {
      valid_actions: ['verify', 'archive', 'decay'],
    });
  }

  if (action !== 'verify' && action !== 'archive' && action !== 'decay') {
    return apiBadRequest(`Invalid action: ${action}`, {
      valid_actions: ['verify', 'archive', 'decay'],
    });
  }

  // 'verify' and 'archive' require a memory id. 'decay' takes no args.
  const id =
    typeof body.id === 'string' ? body.id.trim() : '';
  if (action !== 'decay' && !id) {
    return apiBadRequest(`Field "id" is required for action "${action}"`, {
      action,
    });
  }
  if (id && !/^[\w-]+$/.test(id)) {
    return apiBadRequest('Invalid memory ID (must match [\\w-]+)');
  }

  // Map action → CLI argv.
  const cliSubArgs: string[] = ['memory'];
  if (action === 'verify') {
    cliSubArgs.push('verify', id);
  } else if (action === 'archive') {
    cliSubArgs.push('archive', id);
  } else {
    // decay
    cliSubArgs.push('decay');
  }

  const childCmd = USE_COMPILED ? 'node' : 'npx';
  const childArgs = USE_COMPILED
    ? [COMPILED_CLI, ...cliSubArgs]
    : ['tsx', 'src/cli.ts', ...cliSubArgs];

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

    // Exit code 3 = "not found" (chismoso convention).
    if (result.code === 3) {
      return apiError(404, `Memory not found: ${id}`, {
        action,
        id,
        stderr_tail: result.stderr.split('\n').slice(-10).join('\n'),
      });
    }

    if (result.code !== 0) {
      return apiServerError('memory_action_failed', {
        action,
        id: id || null,
        exitCode: result.code,
        stderr: result.stderr.split('\n').slice(-50).join('\n'),
        ranAt: new Date().toISOString(),
      });
    }

    // The CLI prints the resulting JSON object on stdout. Try to parse it;
    // if parsing fails, fall back to wrapping the raw stdout string.
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      parsed = null;
    }

    return apiOk({
      ranAt: new Date().toISOString(),
      action,
      id: id || null,
      result: parsed ?? { raw: result.stdout.trim() },
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('memory_action_failed', {
      action,
      id: id || null,
      message,
      ranAt: new Date().toISOString(),
    });
  }
});

/**
 * GET /api/memory
 *
 * Returns aggregate stats about the memories table — domain/type/status
 * breakdown + total counts. Read-only, delegates to `chismoso memory stats`.
 *
 * This endpoint is intentionally NOT in the "protected write endpoints" list
 * (audit C2) — it's a read-only aggregate exposed to the dashboard. It uses
 * the same in-process readonly DB singleton as other GET endpoints.
 */
export async function GET() {
  // Re-use the in-process readonly connection.
  const { chismosoDb } = await import('@/lib/db-chismoso');
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
        total: 0,
        byStatus: {},
        byType: {},
        byDomain: {},
      });
    }

    const total = (
      chismosoDb.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }
    ).n;
    const byStatus = chismosoDb
      .prepare('SELECT status, COUNT(*) AS n FROM memories GROUP BY status')
      .all() as Array<{ status: string; n: number }>;
    const byType = chismosoDb
      .prepare('SELECT type, COUNT(*) AS n FROM memories GROUP BY type')
      .all() as Array<{ type: string; n: number }>;
    const byDomain = chismosoDb
      .prepare('SELECT domain, COUNT(*) AS n FROM memories GROUP BY domain')
      .all() as Array<{ domain: string; n: number }>;

    return apiOk({
      ranAt: new Date().toISOString(),
      total,
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
      byType: Object.fromEntries(byType.map((r) => [r.type, r.n])),
      byDomain: Object.fromEntries(byDomain.map((r) => [r.domain, r.n])),
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('memory_stats_failed', { message });
  }
}
