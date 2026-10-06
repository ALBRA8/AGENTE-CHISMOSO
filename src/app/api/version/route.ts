/**
 * GET /api/version — build & runtime metadata (Task IMP-3, spec §32).
 *
 * Returns the CHISMOSO version, build date, git commit hash, and Node
 * version. Used by:
 *   - Dashboard footer (display version + build info).
 *   - MCP clients (capability discovery — see chismoso/src/mcp/resources.ts).
 *   - Load balancers / canary deploys (compare versions across instances).
 *
 * The git_commit field is read from `git rev-parse --short HEAD` at build
 * time. In dev (no .git dir), it falls back to 'dev'. We do NOT exec git
 * on every request — the result is captured once per process and cached
 * on the module scope.
 *
 * Response shape:
 *   {
 *     name: 'AGENTE-CHISMOSO',
 *     version: '1.5.0',
 *     build_date: '<ISO>',
 *     git_commit: '<short hash>' | 'dev',
 *     node_version: 'v20.x.x'
 *   }
 */

import { execSync } from 'node:child_process';
import { apiOk } from '@/lib/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CHISMOSO_VERSION = '1.5.0';

// ---------------------------------------------------------------------------
// GIT COMMIT (cached at module load — exec'ing git on every request would
// be expensive and would leak file handles under load).
// ---------------------------------------------------------------------------

function resolveGitCommit(): string {
  try {
    // --short gives the 7-char hash, plenty for distinguishing deploys.
    // 2-second timeout so a broken git install doesn't hang boot.
    const hash = execSync('git rev-parse --short HEAD', {
      cwd: '/home/z/my-project',
      timeout: 2000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return hash || 'dev';
  } catch {
    // No .git dir (e.g. production tarball deploy) or git missing — fall
    // back to 'dev' so the field is always a string, never null.
    return 'dev';
  }
}

const GIT_COMMIT = resolveGitCommit();

// ---------------------------------------------------------------------------
// BUILD DATE — when the Next.js process started. We use process.uptime() to
// compute "how long has this instance been alive" from this value if needed.
// ---------------------------------------------------------------------------

const BUILD_DATE = new Date().toISOString();

export async function GET() {
  return apiOk({
    name: 'AGENTE-CHISMOSO',
    version: CHISMOSO_VERSION,
    build_date: BUILD_DATE,
    git_commit: GIT_COMMIT,
    node_version: process.version,
    uptime_seconds: Math.round(process.uptime()),
  });
}
