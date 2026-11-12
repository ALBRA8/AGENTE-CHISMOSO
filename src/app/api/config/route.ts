/**
 * GET  /api/config   — return the effective CHISMOSO configuration (safe, no secrets).
 * PUT  /api/config   — informational write endpoint. Most settings CANNOT be
 *                      written here (security risk — see below); the response
 *                      echoes the requested change with the exact CLI command
 *                      the operator must run. Safe client-only preferences
 *                      (theme, default geography override for the dashboard)
 *                      are persisted to localStorage by the caller, not here.
 *
 * Task IMP-DASHBOARD-V2 — surfaces the agent's runtime configuration so the
 * new Settings dialog can render a single, coherent view of:
 *   - general      (domain, log level, geography, DB path, output dir)
 *   - auth         (enabled, token count, session TTL)
 *   - providers    (registered + health, from the /api/providers cache)
 *   - mcp          (servers configured via CHISMOSO_MCP_SERVERS env or
 *                   ~/.chismoso/mcp.json — reported as a count + names)
 *   - mesh         (enabled + subscriber count, from the mesh DB)
 *   - llm          (circuit breaker state — best-effort, since the breaker
 *                   lives in the chismoso subprocess, not the Next.js process)
 *   - observability (Sentry DSN configured? metrics endpoint URL)
 *   - backups      (last backup file mtime under the data dir, retention days)
 *
 * Security:
 *   - Secrets are NEVER returned. Tokens come back as a COUNT only.
 *   - SENTRY_DSN is masked to its host + project slug.
 *   - PUT does NOT write to .env, ever. It returns the CLI command to run.
 *
 * Auth: required via `authedRoute`. In dev (auth disabled) the dashboard
 * can call this freely; in prod, the session cookie must be present.
 */
import { NextRequest } from 'next/server';
import { readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { apiOk, apiBadRequest } from '@/lib/api-response';
import { authedRoute } from '@/lib/middleware';
import { getAuthConfig } from '@/lib/auth';
import { getCached } from '@/lib/cache';
import { chismosoDb } from '@/lib/db-chismoso';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Types — the response shape the Settings panel renders.
// ---------------------------------------------------------------------------

interface ProviderInfo {
  name: string;
  type: string;
  capabilities: string[];
  status: string;
  health: string;
  limits: { requestsPerMinute?: number; maxResultsPerCall?: number };
  authentication: string;
}

interface ConfigResponse {
  general: {
    domain: string;
    logLevel: string;
    geography: string;
    dbPath: string;
    outputDir: string;
  };
  auth: {
    enabled: boolean;
    tokenCount: number;
    sessionTtlSec: number;
    headerName: string;
    cookieName: string;
  };
  providers: {
    count: number;
    healthy: number;
    items: Array<{ name: string; type: string; health: string; capabilities: string[] }>;
  };
  mcp: {
    servers: Array<{ name: string; transport: 'stdio' | 'sse' | 'http' | 'unknown' }>;
    count: number;
  };
  mesh: {
    enabled: boolean;
    subscriberCount: number;
    subscribers: Array<{ agentName: string; webhookUrl: string; active: boolean }>;
  };
  llm: {
    circuitBreakerState: 'closed' | 'open' | 'half-open' | 'unknown';
    model: string;
  };
  observability: {
    sentryConfigured: boolean;
    sentryDsnMasked: string | null;
    metricsEndpoint: string;
  };
  backups: {
    lastBackupAt: string | null;
    retentionDays: number;
    backupDir: string;
    fileCount: number;
  };
}

// ---------------------------------------------------------------------------
// Helpers — read each subsystem defensively. Any failure degrades to a
// neutral "—" / 0 / unknown value so the Settings panel always renders.
// ---------------------------------------------------------------------------

const CHISMOSO_DATA_DIR = path.dirname(
  process.env.CHISMOSO_DB_PATH ?? '/home/z/my-project/chismoso/data/chismoso.db',
);

const BACKUP_DIR = process.env.CHISMOSO_BACKUP_DIR ?? CHISMOSO_DATA_DIR;

/**
 * Mask a Sentry DSN like `https://abc@o123.ingest.sentry.io/456` down to
 * `https://•••@o123.ingest.sentry.io/456` so the operator can confirm
 * WHICH project is configured without leaking the secret key.
 */
function maskSentryDsn(dsn: string): string {
  try {
    const u = new URL(dsn);
    if (u.username) u.username = '•••';
    if (u.password) u.password = '•••';
    return u.toString();
  } catch {
    return '(invalid DSN)';
  }
}

/**
 * Scan the backup directory for the most recent `.bak` / `.db.bak` /
 * `.sqlite.bak` file and return its mtime as an ISO string. Returns null
 * if the dir is missing or no backup file exists yet.
 */
function findLastBackup(): { lastBackupAt: string | null; fileCount: number } {
  try {
    if (!existsSync(BACKUP_DIR)) return { lastBackupAt: null, fileCount: 0 };
    const entries = readdirSync(BACKUP_DIR);
    let latestMtime = 0;
    let fileCount = 0;
    for (const entry of entries) {
      if (!/\.(bak|backup)$/i.test(entry) && !/\.(db|sqlite)[.-]bak$/i.test(entry)) continue;
      const full = path.join(BACKUP_DIR, entry);
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
        fileCount++;
        if (st.mtimeMs > latestMtime) latestMtime = st.mtimeMs;
      } catch {
        /* ignore unreadable files */
      }
    }
    return {
      lastBackupAt: latestMtime > 0 ? new Date(latestMtime).toISOString() : null,
      fileCount,
    };
  } catch {
    return { lastBackupAt: null, fileCount: 0 };
  }
}

/**
 * Parse the `CHISMOSO_MCP_SERVERS` env (a comma-separated list of server
 * names) or fall back to an empty list. The full MCP config (commands,
 * args, transports) lives in `~/.chismoso/mcp.json` and is managed by the
 * `chismoso mcp` CLI — we surface what's declared in env so the Settings
 * panel can show "X servers configured" without re-reading the JSON file.
 */
function readMcpServers(): Array<{ name: string; transport: 'stdio' | 'sse' | 'http' | 'unknown' }> {
  const raw = process.env.CHISMOSO_MCP_SERVERS ?? '';
  const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return names.map((name) => {
    // Transport is encoded as `name:transport` if present, else stdio.
    const [n, t] = name.split(':');
    const transport = (t ?? 'stdio') as 'stdio' | 'sse' | 'http' | 'unknown';
    return { name: n, transport };
  });
}

/**
 * Read the mesh config directly from the chismoso SQLite DB via the
 * singleton readonly connection (`chismosoDb`). We deliberately do NOT
 * import `openMeshDb`/`getMeshConfig` from `@/app/api/mesh/_mesh-db`
 * because that helper imports from `chismoso/dist/mesh/db.js`, which is
 * only available after the chismoso TypeScript is compiled to dist/.
 * Reading the two mesh tables (`mesh_meta`, `mesh_subscribers`)
 * directly with SQL is simpler and works whether or not dist/ exists.
 *
 * The mesh tables are created by the chismoso CLI on first run
 * (`CREATE TABLE IF NOT EXISTS`). If they don't exist yet (fresh
 * install), the queries below throw — we catch and return empty config.
 */
function readMeshConfig(): ConfigResponse['mesh'] {
  try {
    // mesh_meta: { key, value } — `enabled` row holds 'true' | 'false'.
    const metaRow = chismosoDb
      .prepare('SELECT value FROM mesh_meta WHERE key = ?')
      .get('enabled') as { value: string } | undefined;
    const enabled = metaRow?.value === 'true';

    // mesh_subscribers: secret column is intentionally NOT selected —
    // we never leak secrets to the API caller.
    const subRows = chismosoDb
      .prepare(
        'SELECT agent_name, webhook_url, active FROM mesh_subscribers ORDER BY created_at ASC',
      )
      .all() as Array<{ agent_name: string; webhook_url: string; active: number }>;

    return {
      enabled,
      subscriberCount: subRows.length,
      subscribers: subRows.map((s) => ({
        agentName: s.agent_name,
        webhookUrl: s.webhook_url,
        active: s.active === 1,
      })),
    };
  } catch {
    // Tables don't exist yet (fresh install) or DB is cold — degrade to
    // an empty config so the Settings panel always renders.
    return { enabled: false, subscriberCount: 0, subscribers: [] };
  }
}

/**
 * Read the provider list from the in-process cache populated by
 * `/api/providers`. We deliberately do NOT spawn the CLI here — the
 * Settings panel is not worth a 600ms child-process spawn on every open.
 * If the cache is empty (operators never visited the dashboard), the
 * panel shows "0 providers cached — refresh the Providers tab first".
 */
function readProviders(): ConfigResponse['providers'] {
  const cached = getCached<ProviderInfo[]>('providers:list');
  const items = cached ?? [];
  const healthy = items.filter((p) => p.health === 'OK').length;
  return {
    count: items.length,
    healthy,
    items: items.map((p) => ({
      name: p.name,
      type: p.type,
      health: p.health,
      capabilities: p.capabilities ?? [],
    })),
  };
}

// ---------------------------------------------------------------------------
// GET — assemble the effective config
// ---------------------------------------------------------------------------

async function getConfig(): Promise<ConfigResponse> {
  const auth = getAuthConfig();
  const mesh = readMeshConfig();
  const providers = readProviders();
  const mcpServers = readMcpServers();
  const backups = findLastBackup();

  const sentryDsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN ?? '';

  return {
    general: {
      domain: process.env.CHISMOSO_DOMAIN ?? 'localhost',
      logLevel: process.env.CHISMOSO_LOG_LEVEL ?? 'INFO',
      geography: process.env.CHISMOSO_GEOGRAPHY ?? 'global',
      dbPath: process.env.CHISMOSO_DB_PATH ?? '/home/z/my-project/chismoso/data/chismoso.db',
      outputDir: process.env.CHISMOSO_OUTPUT_DIR ?? '/home/z/my-project/download/chismoso',
    },
    auth: {
      enabled: auth.enabled,
      tokenCount: auth.validTokens.length,
      sessionTtlSec: auth.sessionTtlSec,
      headerName: auth.headerName,
      cookieName: auth.cookieName,
    },
    providers,
    mcp: {
      servers: mcpServers,
      count: mcpServers.length,
    },
    mesh,
    llm: {
      // The circuit breaker lives in the chismoso subprocess (orchestrator/llm.ts).
      // We can't introspect it from the Next.js process without spawning the CLI,
      // which the Settings panel isn't worth. Surface 'unknown' and let the
      // operator run `chismoso doctor` for a live snapshot.
      circuitBreakerState: 'unknown',
      model: process.env.CHISMOSO_LLM_MODEL ?? 'glm-4.6',
    },
    observability: {
      sentryConfigured: sentryDsn.length > 0,
      sentryDsnMasked: sentryDsn ? maskSentryDsn(sentryDsn) : null,
      metricsEndpoint: '/api/metrics',
    },
    backups: {
      lastBackupAt: backups.lastBackupAt,
      retentionDays: Number.parseInt(process.env.CHISMOSO_BACKUP_RETENTION_DAYS ?? '30', 10),
      backupDir: BACKUP_DIR,
      fileCount: backups.fileCount,
    },
  };
}

export const GET = authedRoute(async () => {
  const config = await getConfig();
  return apiOk({ config });
});

// ---------------------------------------------------------------------------
// PUT — informational only. Returns the CLI command(s) the operator must
// run to apply the requested change. We never mutate .env or the process
// environment from this route.
// ---------------------------------------------------------------------------

interface PutBody {
  /** The setting the operator wants to change. */
  key:
    | 'logLevel'
    | 'geography'
    | 'domain'
    | 'authEnabled'
    | 'meshEnabled'
    | 'backupRetentionDays'
    | 'llmModel'
    | 'sentryDsn';
  /** The desired value (already validated as a string by the caller). */
  value: string;
}

export const PUT = authedRoute(async (req: NextRequest) => {
  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return apiBadRequest('Invalid JSON body', { code: 'invalid_json' });
  }
  if (!body?.key || typeof body.value !== 'string') {
    return apiBadRequest('key and value are required', { code: 'missing_field' });
  }

  // Map the requested key → the canonical env var + the CLI command that
  // applies it. The frontend renders these verbatim so the operator knows
  // exactly what to paste into their terminal.
  const mapping: Record<PutBody['key'], { envVar: string; cli: string }> = {
    logLevel: {
      envVar: 'CHISMOSO_LOG_LEVEL',
      cli: `echo 'CHISMOSO_LOG_LEVEL=${body.value}' >> .env && (restart chismoso)`,
    },
    geography: {
      envVar: 'CHISMOSO_GEOGRAPHY',
      cli: `echo 'CHISMOSO_GEOGRAPHY=${body.value}' >> .env`,
    },
    domain: {
      envVar: 'CHISMOSO_DOMAIN',
      cli: `echo 'CHISMOSO_DOMAIN=${body.value}' >> .env`,
    },
    authEnabled: {
      envVar: 'CHISMOSO_AUTH_ENABLED',
      cli: `echo 'CHISMOSO_AUTH_ENABLED=${body.value}' >> .env`,
    },
    meshEnabled: {
      envVar: '(managed via CLI)',
      cli: `chismoso mesh ${body.value === 'true' ? 'enable' : 'disable'}`,
    },
    backupRetentionDays: {
      envVar: 'CHISMOSO_BACKUP_RETENTION_DAYS',
      cli: `echo 'CHISMOSO_BACKUP_RETENTION_DAYS=${body.value}' >> .env`,
    },
    llmModel: {
      envVar: 'CHISMOSO_LLM_MODEL',
      cli: `echo 'CHISMOSO_LLM_MODEL=${body.value}' >> .env`,
    },
    sentryDsn: {
      envVar: 'SENTRY_DSN',
      cli: `echo 'SENTRY_DSN=${body.value}' >> .env`,
    },
  };
  const entry = mapping[body.key];
  if (!entry) {
    return apiBadRequest(`Unknown config key: ${body.key}`, { code: 'unknown_key' });
  }

  return apiOk({
    applied: false,
    reason:
      'Settings are not written from the dashboard for security. Apply the change via the CLI or by editing .env, then restart CHISMOSO.',
    envVar: entry.envVar,
    cli: entry.cli.replace('${body.value}', body.value),
    requestedKey: body.key,
    requestedValue: body.value,
  });
});
