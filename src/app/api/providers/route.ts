import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { apiOk, apiServerError } from '@/lib/api-response';
import { getCached, setCached } from '@/lib/cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CHISMOSO_ROOT = '/home/z/my-project/chismoso';

/**
 * Pre-compiled CLI is preferred (faster startup — no TS compilation per call).
 * Falls back to `npx tsx src/cli.ts` when dist/ hasn't been built yet.
 */
const COMPILED_CLI = `${CHISMOSO_ROOT}/dist/cli.js`;
const USE_COMPILED = existsSync(COMPILED_CLI);

/**
 * Provider list rarely changes (it's defined statically in chismoso's
 * providers-db registry and only grows when a new adapter is added). Cache
 * the spawn result for 5 min so the dashboard can poll freely without
 * paying the 600-1200ms child-process cost on every request.
 *
 * If a provider is ever added at runtime, call `invalidate(PROVIDERS_CACHE_KEY)`
 * (or restart the process) to force a refresh on the next request.
 */
const PROVIDERS_CACHE_KEY = 'providers:list';
const PROVIDERS_CACHE_TTL = 5 * 60 * 1000; // 5 min

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
 * Spawns `chismoso providers` CLI and parses its JSON output. Result is
 * cached in-process for 5 min — see `PROVIDERS_CACHE_TTL` above.
 *
 * Response shape:
 *   { providers: ProviderInfo[], cached: boolean }
 */
export async function GET() {
  const cached = getCached<ProviderInfo[]>(PROVIDERS_CACHE_KEY);
  if (cached) {
    return apiOk({ providers: cached, cached: true });
  }

  const childCmd = USE_COMPILED ? 'node' : 'npx';
  const childArgs = USE_COMPILED
    ? [COMPILED_CLI, 'providers']
    : ['tsx', 'src/cli.ts', 'providers'];
  const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>(
    (resolve) => {
      const child = spawn(childCmd, childArgs, {
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
    return apiServerError(
      'Failed to query providers',
      { stderr: result.stderr, stdout: result.stdout },
    );
  }

  try {
    // CLI prints JSON to stdout. Parse it.
    const data = JSON.parse(result.stdout);
    const providers: ProviderInfo[] = data?.providers ?? [];
    // Only cache non-empty results — an empty list usually means the CLI
    // failed silently and we'd rather re-try next call than pin the empty
    // state for 5 min.
    if (providers.length > 0) {
      setCached(PROVIDERS_CACHE_KEY, providers, PROVIDERS_CACHE_TTL);
    }
    return apiOk({ providers, cached: false });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('Could not parse provider output', { raw: result.stdout, parseError: message });
  }
}
