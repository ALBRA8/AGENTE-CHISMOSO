import { NextResponse } from 'next/server';
import { spawn } from 'node:child_process';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CHISMOSO_ROOT = '/home/z/my-project/chismoso';

interface ProviderInfo {
  name: string;
  type: string;
  capabilities: string[];
  status: string;
  limits: { requestsPerMinute?: number; maxResultsPerCall?: number };
  authentication: string;
  health: string;
}

/**
 * GET /api/providers
 *
 * Returns the list of registered providers with their health status.
 * Spawns `chismoso providers` CLI and parses its JSON output.
 */
export async function GET() {
  const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>(
    (resolve) => {
      const child = spawn('npx', ['tsx', 'src/cli.ts', 'providers'], {
        cwd: CHISMOSO_ROOT,
        env: { ...process.env, CHISMOSO_LOG_LEVEL: 'WARN' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('close', (code) => resolve({ stdout, stderr, code }));
      child.on('error', () => resolve({ stdout, stderr, code: -1 }));
    },
  );

  if (result.code !== 0) {
    return NextResponse.json(
      { error: 'Failed to query providers', details: result.stderr || result.stdout },
      { status: 500 },
    );
  }

  try {
    // CLI prints JSON to stdout. Parse it.
    const data = JSON.parse(result.stdout);
    const providers: ProviderInfo[] = data?.providers ?? [];
    return NextResponse.json({ providers });
  } catch {
    return NextResponse.json(
      { error: 'Could not parse provider output', raw: result.stdout },
      { status: 500 },
    );
  }
}
