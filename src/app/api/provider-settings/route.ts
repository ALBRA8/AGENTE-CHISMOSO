/**
 * /api/provider-settings — LLM provider configuration (Task FASE-1-SEC §1.1, §1.2, §1.5)
 *
 * GET  — returns the saved provider config with API keys MASKED
 *        (`api_key_set: boolean`, `api_key_hint: '••••1234'`).
 *        NEVER returns the full key. Protected by `authedRoute`.
 *
 * PUT  — accepts a new provider config. Validates `base_url`:
 *          - MUST be https://
 *          - MUST NOT point to a private / loopback / link-local IP
 *        Writes `.provider-settings.json` with mode 0o600.
 *        When writing to `.env`: wraps values in double quotes and
 *        escapes newlines / quotes so a malicious value can't inject
 *        extra env entries.
 *        If `api_key` is the empty string, the previously saved key
 *        is preserved (so the dashboard can save other fields without
 *        clobbering a key it can't see). Protected by `authedRoute`.
 */

import { NextResponse, NextRequest } from 'next/server';
import { readFile, writeFile, chmod } from 'fs/promises';
import path from 'path';
import { authedRoute } from '@/lib/middleware';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SETTINGS_FILE = path.join(process.cwd(), '.provider-settings.json');
const ENV_FILE = path.join(process.cwd(), '.env');

const DEFAULT_SETTINGS = {
  provider: 'nvidia',
  base_url: 'https://integrate.api.nvidia.com/v1',
  model: 'z-ai/glm-5.3-flash',
  temperature: 0.5,
  top_p: 1.0,
  max_tokens: 1024,
  timeout: 60,
};

// ---------------------------------------------------------------------------
// Helpers — secret masking + base_url validation + env escaping
// ---------------------------------------------------------------------------

/**
 * Mask a secret for display. Returns `null` when the secret is empty.
 *
 *   maskSecret('nvapi-abc123')  → '••••12••'  (last 4 chars, padded)
 *   maskSecret('short')         → '••••hort'
 *   maskSecret('')              → null
 *
 * Only the last 4 characters of the actual secret are exposed; the
 * rest is replaced with bullets. The masked form is safe to ship to
 * the dashboard (it confirms "a key is set" + lets the operator
 * visually verify the last 4 digits without leaking the value).
 */
function maskSecret(secret: string | undefined | null): string | null {
  const s = (secret ?? '').trim();
  if (!s) return null;
  if (s.length <= 4) return `••••${s}`;
  return `••••${s.slice(-4)}`;
}

/**
 * Reject `http://` URLs and URLs pointing at private / loopback /
 * link-local / cloud-metadata IP ranges. This blocks SSRF attempts
 * where an operator (or a compromised dashboard session) tries to
 * point the LLM base_url at an internal service.
 *
 * Returns `null` when the URL is acceptable, or a human-readable
 * reason string when it should be rejected.
 */
function validateBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'base_url must be a valid URL';
  }
  if (url.protocol !== 'https:') {
    return 'base_url must use https://';
  }
  const host = url.hostname.toLowerCase();
  // Reject obvious private / internal hostnames.
  if (
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.localhost')
  ) {
    return 'base_url must not point at a loopback host';
  }
  // Reject IPv4 private / reserved ranges.
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (
      a === 10 ||                                  // 10.0.0.0/8
      (a === 172 && b >= 16 && b <= 31) ||         // 172.16.0.0/12
      (a === 192 && b === 168) ||                  // 192.168.0.0/16
      a === 127 ||                                 // 127.0.0.0/8  (loopback)
      (a === 169 && b === 254) ||                  // 169.254.0.0/16 (link-local)
      a === 0 ||                                   // 0.0.0.0/8
      a >= 224                                     // 224.0.0.0/4 (multicast) + 240.0.0.0/4 (reserved)
    ) {
      return 'base_url must not point at a private / loopback / link-local IP';
    }
  }
  // Reject IPv6 loopback / link-local / ULA.
  if (host === '[::1]' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    return 'base_url must not point at a private / loopback IPv6 host';
  }
  return null;
}

/**
 * Escape a value for the .env file. We always wrap in double quotes
 * and escape backslashes, double quotes, newlines, and carriage
 * returns so a value like `foo\nBAR=evil` cannot inject a second env
 * entry.
 *
 *   escapeEnvValue('normal')         → '"normal"'
 *   escapeEnvValue('a"b')            → '"a\\"b"'
 *   escapeEnvValue('line1\nline2')   → '"line1\\nline2"'
 */
function escapeEnvValue(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  return `"${escaped}"`;
}

/**
 * Read the existing settings file (or return null if missing). Used
 * by PUT to preserve the existing api_key when the caller sends "".
 */
async function readSettings(): Promise<any | null> {
  try {
    const data = await readFile(SETTINGS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GET — masked config (no full api_key)
// ---------------------------------------------------------------------------

export const GET = authedRoute(async (_req: NextRequest) => {
  try {
    const existing = await readSettings();
    // The effective key is whichever source has it: saved file → env.
    const envKey =
      process.env.NVIDIA_API_KEY ||
      process.env.GROQ_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      process.env.OPENAI_API_KEY ||
      '';
    const apiKey = existing?.api_key || envKey;

    const provider =
      existing?.provider ||
      (process.env.NVIDIA_API_KEY
        ? 'nvidia'
        : process.env.GROQ_API_KEY
        ? 'groq'
        : 'nvidia');
    const base_url =
      existing?.base_url ||
      process.env.AI_BASE_URL ||
      'https://integrate.api.nvidia.com/v1';
    const model =
      existing?.model || process.env.AI_MODEL || 'z-ai/glm-5.3-flash';

    return NextResponse.json({
      provider,
      base_url,
      model,
      temperature: existing?.temperature ?? DEFAULT_SETTINGS.temperature,
      top_p: existing?.top_p ?? DEFAULT_SETTINGS.top_p,
      max_tokens: existing?.max_tokens ?? DEFAULT_SETTINGS.max_tokens,
      timeout: existing?.timeout ?? DEFAULT_SETTINGS.timeout,
      // MASKED — never ship the full key to the client.
      api_key_set: Boolean(apiKey),
      api_key_hint: maskSecret(apiKey),
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || 'Error al leer configuración' },
      { status: 500 },
    );
  }
});

// ---------------------------------------------------------------------------
// PUT — validate, preserve existing key on empty input, write 0600
// ---------------------------------------------------------------------------

export const PUT = authedRoute(async (req: NextRequest) => {
  try {
    const body = await req.json();

    // --- Validate base_url (SSRF defense) ------------------------------
    const baseUrl =
      typeof body.base_url === 'string' && body.base_url.trim()
        ? body.base_url.trim()
        : 'https://integrate.api.nvidia.com/v1';
    const urlError = validateBaseUrl(baseUrl);
    if (urlError) {
      return NextResponse.json(
        { error: 'Bad Request', details: { reason: urlError } },
        { status: 400 },
      );
    }

    const provider = typeof body.provider === 'string' && body.provider
      ? body.provider
      : 'nvidia';
    const model = typeof body.model === 'string' && body.model
      ? body.model
      : 'z-ai/glm-5.3-flash';

    // --- Resolve api_key (preserve existing on empty input) ------------
    // The dashboard GETs only the masked hint — when the user saves
    // other fields without re-entering the key, the PUT arrives with
    // `api_key: ""`. We keep the previously saved value rather than
    // clobbering it with empty.
    const incomingKey =
      typeof body.api_key === 'string' ? body.api_key.trim() : '';
    const existing = await readSettings();
    const envKey =
      process.env.NVIDIA_API_KEY ||
      process.env.GROQ_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      process.env.OPENAI_API_KEY ||
      '';
    const apiKey = incomingKey || existing?.api_key || envKey;

    const temperature = Number(body.temperature) || 0.5;
    const topP = Number(body.top_p) || 1.0;
    const maxTokens = Number(body.max_tokens) || 1024;
    const timeout = Number(body.timeout) || 60;

    const toSave = {
      provider,
      base_url: baseUrl,
      model,
      api_key: apiKey,
      temperature,
      top_p: topP,
      max_tokens: maxTokens,
      timeout,
      updated_at: new Date().toISOString(),
    };

    // --- Write settings file with mode 0600 ----------------------------
    // Owner read/write only — API keys are sensitive.
    await writeFile(SETTINGS_FILE, JSON.stringify(toSave, null, 2), 'utf-8');
    try {
      await chmod(SETTINGS_FILE, 0o600);
    } catch {
      // chmod can fail on Windows (no permission bits) — non-fatal.
    }

    // --- Update process.env (in-memory) --------------------------------
    if (apiKey) {
      if (provider === 'nvidia') process.env.NVIDIA_API_KEY = apiKey;
      else if (provider === 'groq') process.env.GROQ_API_KEY = apiKey;
      else if (provider === 'google') process.env.GOOGLE_API_KEY = apiKey;
      else if (provider === 'openai') process.env.OPENAI_API_KEY = apiKey;
    }
    process.env.AI_PROVIDER = provider;
    process.env.AI_BASE_URL = baseUrl;
    process.env.AI_MODEL = model;

    // --- Persist to .env (escaped, quoted) -----------------------------
    try {
      const envContent = await readFile(ENV_FILE, 'utf-8').catch(() => '');
      const lines = envContent.split(/\r?\n/);
      const envMap: Record<string, string> = {};
      for (const line of lines) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m) envMap[m[1]] = m[2];
      }

      if (apiKey) {
        if (provider === 'nvidia') envMap['NVIDIA_API_KEY'] = escapeEnvValue(apiKey);
        else if (provider === 'groq') envMap['GROQ_API_KEY'] = escapeEnvValue(apiKey);
        else if (provider === 'google') envMap['GOOGLE_API_KEY'] = escapeEnvValue(apiKey);
        else if (provider === 'openai') envMap['OPENAI_API_KEY'] = escapeEnvValue(apiKey);
      }
      envMap['AI_PROVIDER'] = escapeEnvValue(provider);
      envMap['AI_BASE_URL'] = escapeEnvValue(baseUrl);
      envMap['AI_MODEL'] = escapeEnvValue(model);

      const newEnv =
        Object.entries(envMap).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
      await writeFile(ENV_FILE, newEnv, 'utf-8');
      try {
        await chmod(ENV_FILE, 0o600);
      } catch {
        // Windows — non-fatal.
      }
    } catch {
      // .env persistence is best-effort; the settings file is the
      // source of truth for the running process.
    }

    return NextResponse.json({
      ok: true,
      config: {
        provider: toSave.provider,
        base_url: toSave.base_url,
        model: toSave.model,
        temperature: toSave.temperature,
        top_p: toSave.top_p,
        max_tokens: toSave.max_tokens,
        timeout: toSave.timeout,
        updated_at: toSave.updated_at,
        // Don't echo the full key back to the client — only the
        // masked hint so the operator can verify the last 4 chars.
        api_key_set: Boolean(apiKey),
        api_key_hint: maskSecret(apiKey),
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || 'Error al guardar configuración' },
      { status: 500 },
    );
  }
});
