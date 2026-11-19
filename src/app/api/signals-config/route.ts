/**
 * /api/signals-config — search-provider API keys (Task FASE-1-SEC §1.1, §1.2, §1.5)
 *
 * GET  — returns `tavily_set`, `serper_set`, `brave_set` (booleans)
 *        plus `tavily_hint`, `serper_hint`, `brave_hint` (masked last-4).
 *        NEVER returns the full keys. Protected by `authedRoute`.
 *
 * PUT  — accepts new keys. If a key field is the empty string, the
 *        previously saved value is preserved (so the dashboard can
 *        save one key without clobbering the others it can't see).
 *        Writes `.signals-settings.json` with mode 0o600. When
 *        writing to `.env`, wraps values in double quotes and
 *        escapes newlines / quotes (env-injection defense).
 *        Protected by `authedRoute`.
 */

import { NextResponse, NextRequest } from 'next/server';
import { readFile, writeFile, chmod } from 'fs/promises';
import path from 'path';
import { authedRoute } from '@/lib/middleware';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SIGNALS_FILE = path.join(process.cwd(), '.signals-settings.json');
const ENV_FILE = path.join(process.cwd(), '.env');

// ---------------------------------------------------------------------------
// Helpers — secret masking + env escaping
// ---------------------------------------------------------------------------

/**
 * Mask a secret for display: last 4 chars padded with bullets.
 * Returns `null` when the secret is empty (so the dashboard can
 * distinguish "not configured" from "configured but hidden").
 */
function maskSecret(secret: string | undefined | null): string | null {
  const s = (secret ?? '').trim();
  if (!s) return null;
  if (s.length <= 4) return `••••${s}`;
  return `••••${s.slice(-4)}`;
}

/**
 * Escape a value for the .env file. Always wraps in double quotes
 * and escapes backslashes, double quotes, newlines, and carriage
 * returns so a value like `foo\nBAR=evil` cannot inject a second
 * env entry.
 */
function escapeEnvValue(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  return `"${escaped}"`;
}

/** Read the existing signals file (or return null if missing). */
async function readSignals(): Promise<any | null> {
  try {
    const data = await readFile(SIGNALS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GET — masked keys only
// ---------------------------------------------------------------------------

export const GET = authedRoute(async (_req: NextRequest) => {
  const existing = await readSignals();

  const tavily = existing?.tavily_api_key || process.env.TAVILY_API_KEY || '';
  const serper = existing?.serper_api_key || process.env.SERPER_API_KEY || '';
  const brave = existing?.brave_api_key || process.env.BRAVE_API_KEY || '';

  return NextResponse.json({
    // MASKED — never ship the full key to the client.
    tavily_set: Boolean(tavily),
    tavily_hint: maskSecret(tavily),
    serper_set: Boolean(serper),
    serper_hint: maskSecret(serper),
    brave_set: Boolean(brave),
    brave_hint: maskSecret(brave),
  });
});

// ---------------------------------------------------------------------------
// PUT — preserve existing keys on empty input, write 0600
// ---------------------------------------------------------------------------

export const PUT = authedRoute(async (req: NextRequest) => {
  try {
    const body = await req.json();

    // --- Resolve each key (preserve existing on empty input) ----------
    // The dashboard GETs only the masked hints — when the user saves
    // one key without re-entering the others, the PUT arrives with
    // empty strings for the others. We keep the previously saved
    // values rather than clobbering them with empty.
    const existing = await readSignals();

    const incomingTavily =
      typeof body.tavily_api_key === 'string' ? body.tavily_api_key.trim() : '';
    const incomingSerper =
      typeof body.serper_api_key === 'string' ? body.serper_api_key.trim() : '';
    const incomingBrave =
      typeof body.brave_api_key === 'string' ? body.brave_api_key.trim() : '';

    const tavily = incomingTavily || existing?.tavily_api_key || process.env.TAVILY_API_KEY || '';
    const serper = incomingSerper || existing?.serper_api_key || process.env.SERPER_API_KEY || '';
    const brave = incomingBrave || existing?.brave_api_key || process.env.BRAVE_API_KEY || '';

    const toSave = {
      tavily_api_key: tavily,
      serper_api_key: serper,
      brave_api_key: brave,
      updated_at: new Date().toISOString(),
    };

    // --- Write settings file with mode 0600 ----------------------------
    await writeFile(SIGNALS_FILE, JSON.stringify(toSave, null, 2), 'utf-8');
    try {
      await chmod(SIGNALS_FILE, 0o600);
    } catch {
      // chmod can fail on Windows — non-fatal.
    }

    // --- Update process.env (in-memory) --------------------------------
    if (tavily) process.env.TAVILY_API_KEY = tavily;
    if (serper) process.env.SERPER_API_KEY = serper;
    if (brave) process.env.BRAVE_API_KEY = brave;

    // --- Persist to .env (escaped, quoted) -----------------------------
    try {
      const envContent = await readFile(ENV_FILE, 'utf-8').catch(() => '');
      const lines = envContent.split(/\r?\n/);
      const envMap: Record<string, string> = {};
      for (const line of lines) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m) envMap[m[1]] = m[2];
      }
      if (tavily) envMap['TAVILY_API_KEY'] = escapeEnvValue(tavily);
      if (serper) envMap['SERPER_API_KEY'] = escapeEnvValue(serper);
      if (brave) envMap['BRAVE_API_KEY'] = escapeEnvValue(brave);

      const newEnv =
        Object.entries(envMap).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
      await writeFile(ENV_FILE, newEnv, 'utf-8');
      try {
        await chmod(ENV_FILE, 0o600);
      } catch {
        // Windows — non-fatal.
      }
    } catch {
      // .env persistence is best-effort.
    }

    return NextResponse.json({
      ok: true,
      config: {
        tavily_set: Boolean(tavily),
        tavily_hint: maskSecret(tavily),
        serper_set: Boolean(serper),
        serper_hint: maskSecret(serper),
        brave_set: Boolean(brave),
        brave_hint: maskSecret(brave),
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || 'Error al guardar motores de búsqueda' },
      { status: 500 },
    );
  }
});
