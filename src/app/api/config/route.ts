/**
 * GET  /api/config   — return effective CHISMOSO config (env + SQLite overrides, secrets masked)
 * PUT  /api/config   — write config key-value pairs to SQLite agent_config table
 * POST /api/config/whatsapp/test — send a test message via configured WhatsApp daemon/webhook
 *
 * The agent_config table overrides env vars. This lets the dashboard change
 * settings without restarting the server or editing .env.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authedRoute, apiOk, apiBadRequest, apiServerError } from '@/lib/middleware';
import { chismosoDb } from '@/lib/db-chismoso';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET — read all config
// ---------------------------------------------------------------------------

async function getConfig(req: NextRequest) {
  // Read from agent_config table
  const rows = chismosoDb.prepare(`
    SELECT key, value, category, description, is_secret, updated_at, updated_by
    FROM agent_config
    ORDER BY category, key
  `).all() as any[];

  // Build config object grouped by category
  const config: Record<string, Record<string, { value: string; description?: string; isSecret: boolean; updatedAt: string; updatedBy?: string }>> = {};
  for (const row of rows) {
    if (!config[row.category]) config[row.category] = {};
    config[row.category][row.key] = {
      value: row.is_secret ? maskValue(row.value) : row.value,
      description: row.description,
      isSecret: !!row.is_secret,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    };
  }

  // Also include env-based defaults (read-only, can't be changed via PUT)
  const envDefaults: Record<string, string> = {
    'CHISMOSO_DB_PATH': process.env.CHISMOSO_DB_PATH ?? '/data/chismoso.db',
    'CHISMOSO_LOG_LEVEL': process.env.CHISMOSO_LOG_LEVEL ?? 'INFO',
    'CHISMOSO_GEOGRAPHY': process.env.CHISMOSO_GEOGRAPHY ?? 'global',
    'CHISMOSO_AUTH_ENABLED': process.env.CHISMOSO_AUTH_ENABLED ?? 'false',
    'CHISMOSO_DOMAIN': process.env.CHISMOSO_DOMAIN ?? '',
    'SENTRY_DSN': process.env.SENTRY_DSN ? 'configured' : 'not set',
    'REDIS_URL': process.env.REDIS_URL ?? 'not set',
    'NODE_ENV': process.env.NODE_ENV ?? 'development',
  };

  return apiOk({
    config,
    envDefaults,
    whatsapp: {
      daemonUrl: getConfigValue(rows, 'whatsapp.daemon_url') ?? '',
      webhookUrl: getConfigValue(rows, 'whatsapp.webhook_url') ?? '',
      phoneNumber: getConfigValue(rows, 'whatsapp.phone_number') ?? '',
      enabled: getConfigValue(rows, 'whatsapp.enabled') === 'true',
      connectionType: getConfigValue(rows, 'whatsapp.connection_type') ?? 'webhook',
    },
  });
}

function getConfigValue(rows: any[], key: string): string | undefined {
  const row = rows.find(r => r.key === key);
  return row?.value;
}

function maskValue(value: string): string {
  if (value.length <= 8) return '••••';
  return value.slice(0, 4) + '••••' + value.slice(-4);
}

// ---------------------------------------------------------------------------
// PUT — write config
// ---------------------------------------------------------------------------

interface PutBody {
  settings: Array<{
    key: string;
    value: string;
    category: string;
    description?: string;
    isSecret?: boolean;
  }>;
}

async function putConfig(req: NextRequest) {
  let body: PutBody;
  try {
    body = await req.json();
  } catch {
    return apiBadRequest('Invalid JSON body');
  }

  if (!body.settings || !Array.isArray(body.settings) || body.settings.length === 0) {
    return apiBadRequest('Missing "settings" array');
  }

  const now = new Date().toISOString();
  const stmt = chismosoDb.prepare(`
    INSERT INTO agent_config (key, value, category, description, is_secret, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, 'dashboard')
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      category = excluded.category,
      description = excluded.description,
      is_secret = excluded.is_secret,
      updated_at = excluded.updated_at,
      updated_by = 'dashboard'
  `);

  const tx = chismosoDb.transaction(() => {
    let count = 0;
    for (const s of body.settings) {
      if (!s.key || !s.value || !s.category) continue;
      stmt.run(s.key, s.value, s.category, s.description ?? null, s.isSecret ? 1 : 0, now);
      count++;
    }
    return count;
  });

  const written = tx();
  return apiOk({ written, message: `${written} settings saved` });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const GET = authedRoute(getConfig);
export const PUT = authedRoute(putConfig);
