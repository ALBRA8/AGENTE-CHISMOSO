import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const CHISMOSO_ROOT = '/home/z/my-project/chismoso';
const OUTPUT_DIR = '/home/z/my-project/download/chismoso';

interface InvestigateBody {
  objective: string;
  geography?: string;
  maxQueries?: number;
  maxRuntimeMs?: number;
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
  let body: InvestigateBody;
  try {
    body = (await req.json()) as InvestigateBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const objective = (body.objective ?? '').trim();
  if (!objective) {
    return NextResponse.json({ error: 'Missing "objective"' }, { status: 400 });
  }
  if (objective.length > 1000) {
    return NextResponse.json({ error: 'Objective too long (max 1000 chars)' }, { status: 400 });
  }

  const geography = (body.geography ?? 'Colombia').trim() || 'Colombia';
  const maxQueries = Math.min(Math.max(body.maxQueries ?? 4, 1), 10);
  const maxRuntimeMs = Math.min(Math.max(body.maxRuntimeMs ?? 180_000, 30_000), 240_000);

  // Build CLI args. We pass --save so reports are persisted to disk too.
  const args = [
    'src/cli.ts',
    'investigate',
    objective,
    `--geography=${geography}`,
    `--max-queries=${maxQueries}`,
    `--max-runtime-ms=${maxRuntimeMs}`,
    '--save',
  ];

  // Spawn tsx as a child process. Capture stdout (markdown report) and stderr (logs).
  const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>(
    (resolve) => {
      const child = spawn('npx', ['tsx', ...args], {
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
      child.on('close', (code) => {
        resolve({ stdout, stderr, code });
      });
      child.on('error', (err) => {
        resolve({ stdout, stderr: stderr + '\n' + (err?.message ?? String(err)), code: -1 });
      });

      // Safety timeout — kill the child if it exceeds maxRuntimeMs + 30s grace.
      const timeout = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
      }, maxRuntimeMs + 30_000);
      child.on('close', () => clearTimeout(timeout));
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

  return NextResponse.json({
    ok: result.code === 0 || status === 'COMPLETED' || status === 'PARTIAL' || status === 'INSUFFICIENT_EVIDENCE',
    status,
    investigationId,
    counts,
    report,
    // Include the last 200 lines of stderr for debugging (so user can see what providers did).
    log: result.stderr.split('\n').slice(-200).join('\n'),
  });
}
