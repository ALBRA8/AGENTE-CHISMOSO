/**
 * tests/security.test.ts — Task FASE-1-SEC §1.6
 *
 * Verifies the Phase-1 security hardening:
 *
 *   §1.1 — Protected routes reject unauthenticated callers when auth is
 *          enabled (chat, provider-settings, signals-config, telegram,
 *          whatsapp/daemon-proxy). The chat route uses `optionalAuth`
 *          + an inline 401 gate; the others use `authedRoute`.
 *   §1.2 — GET responses never leak full API keys (provider-settings
 *          returns `api_key_set` + `api_key_hint`; signals-config
 *          returns `*_set` + `*_hint` for tavily / serper / brave).
 *   §1.3 — `getAuthConfig` is fail-closed in production (auth ON by
 *          default; only explicit 'false' disables).
 *   §1.5 — PUT with empty api_key preserves the existing saved value;
 *          base_url must be https and must not point at private /
 *          loopback / link-local IPs (SSRF defense).
 *
 * The fs/promises module is mocked so the tests don't touch real
 * `.provider-settings.json` / `.signals-settings.json` / `.env` files.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import path from 'path';

// ---------------------------------------------------------------------------
// Mock fs/promises — backed by an in-memory map. The map is shared
// between the test (which seeds + asserts) and the route handlers
// (which read/write through the mocked readFile/writeFile). `vi.hoisted`
// ensures the map exists before the route modules are imported.
// ---------------------------------------------------------------------------

const { mockFiles } = vi.hoisted(() => ({
  mockFiles: {} as Record<string, string>,
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string | Buffer | URL) => {
    const key = String(p);
    if (key in mockFiles) return mockFiles[key];
    const err = new Error(`ENOENT: ${key}`) as Error & { code?: string };
    err.code = 'ENOENT';
    throw err;
  }),
  writeFile: vi.fn(async (p: string | Buffer | URL, content: string) => {
    mockFiles[String(p)] = String(content);
  }),
  chmod: vi.fn(async () => undefined),
}));

// Imports below resolve AFTER vi.mock is applied (vitest hoists vi.mock
// above all top-level imports), so the routes receive the mocked fs.
import { GET as providerGET, PUT as providerPUT } from '../src/app/api/provider-settings/route';
import { GET as signalsGET, PUT as signalsPUT } from '../src/app/api/signals-config/route';
import { POST as chatPOST } from '../src/app/api/chat/route';
import { getAuthConfig, hashToken, withAuth, AUTH_HEADER_DEFAULT } from '../src/lib/auth';

const TEST_TOKEN = 'security-test-token-1234567890abcdef';
const TEST_TOKEN_HASH = hashToken(TEST_TOKEN);

const PROVIDER_FILE = path.join(process.cwd(), '.provider-settings.json');
const SIGNALS_FILE = path.join(process.cwd(), '.signals-settings.json');

function makeReq(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): NextRequest {
  return new NextRequest(url, {
    method: init.method ?? 'GET',
    headers: init.headers ?? {},
    body: init.body,
  });
}

// ---------------------------------------------------------------------------
// §1.1 — Protected routes reject unauthenticated callers
// ---------------------------------------------------------------------------

describe('FASE-1-SEC §1.1 — protected routes reject unauthenticated callers', () => {
  beforeEach(() => {
    Object.keys(mockFiles).forEach((k) => delete mockFiles[k]);
    delete process.env.CHISMOSO_AUTH_ENABLED;
    delete process.env.CHISMOSO_AUTH_TOKENS;
    delete process.env.CHISMOSO_AUTH_HEADER;
    // Tests run with NODE_ENV unset (vitest default) → dev → auth OFF
    // unless explicitly enabled below.
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    delete process.env.CHISMOSO_AUTH_ENABLED;
    delete process.env.CHISMOSO_AUTH_TOKENS;
    delete process.env.NODE_ENV;
    Object.keys(mockFiles).forEach((k) => delete mockFiles[k]);
  });

  it('provider-settings GET returns 401 when auth is enabled and no header is present', async () => {
    process.env.CHISMOSO_AUTH_ENABLED = 'true';
    process.env.CHISMOSO_AUTH_TOKENS = TEST_TOKEN_HASH;
    const req = makeReq('http://localhost/api/provider-settings');
    const res = await providerGET(req, {});
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
    expect(body.details.reason).toBe('missing_header');
  });

  it('provider-settings PUT returns 401 when auth is enabled and no header is present', async () => {
    process.env.CHISMOSO_AUTH_ENABLED = 'true';
    process.env.CHISMOSO_AUTH_TOKENS = TEST_TOKEN_HASH;
    const req = makeReq('http://localhost/api/provider-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'nvidia' }),
    });
    const res = await providerPUT(req, {});
    expect(res.status).toBe(401);
  });

  it('signals-config GET returns 401 when auth is enabled and no header is present', async () => {
    process.env.CHISMOSO_AUTH_ENABLED = 'true';
    process.env.CHISMOSO_AUTH_TOKENS = TEST_TOKEN_HASH;
    const req = makeReq('http://localhost/api/signals-config');
    const res = await signalsGET(req, {});
    expect(res.status).toBe(401);
  });

  it('signals-config PUT returns 401 when auth is enabled and no header is present', async () => {
    process.env.CHISMOSO_AUTH_ENABLED = 'true';
    process.env.CHISMOSO_AUTH_TOKENS = TEST_TOKEN_HASH;
    const req = makeReq('http://localhost/api/signals-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tavily_api_key: 'x' }),
    });
    const res = await signalsPUT(req, {});
    expect(res.status).toBe(401);
  });

  it('chat POST returns 401 when auth is enabled and no header is present', async () => {
    process.env.CHISMOSO_AUTH_ENABLED = 'true';
    process.env.CHISMOSO_AUTH_TOKENS = TEST_TOKEN_HASH;
    const req = makeReq('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    const res = await chatPOST(req, {});
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
    expect(body.details.reason).toBe('missing_header');
  });

  it('withAuth wrapper rejects requests when auth is enabled and no header is present', async () => {
    process.env.CHISMOSO_AUTH_ENABLED = 'true';
    process.env.CHISMOSO_AUTH_TOKENS = TEST_TOKEN_HASH;
    const handler = vi.fn(async () => NextResponse.json({ ok: true }));
    const wrapped = withAuth(handler);
    const req = makeReq('http://localhost/api/anything');
    const res = await wrapped(req, {});
    expect(handler).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
  });

  it('protected routes accept callers with a valid X-Chismoso-Agent token', async () => {
    process.env.CHISMOSO_AUTH_ENABLED = 'true';
    process.env.CHISMOSO_AUTH_TOKENS = TEST_TOKEN_HASH;
    const req = makeReq('http://localhost/api/provider-settings', {
      headers: { [AUTH_HEADER_DEFAULT]: TEST_TOKEN },
    });
    const res = await providerGET(req, {});
    // 200 — auth passed, handler ran (mocked fs returns null → falls
    // back to env defaults).
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// §1.2 — GET responses never leak full API keys
// ---------------------------------------------------------------------------

describe('FASE-1-SEC §1.2 — GET responses never leak full API keys', () => {
  beforeEach(() => {
    Object.keys(mockFiles).forEach((k) => delete mockFiles[k]);
    // Auth disabled in dev so the GET handler runs.
    delete process.env.CHISMOSO_AUTH_ENABLED;
    delete process.env.CHISMOSO_AUTH_TOKENS;
    delete process.env.NODE_ENV;
    // Clear env keys so masking falls back to file content only.
    delete process.env.NVIDIA_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.AI_BASE_URL;
    delete process.env.AI_MODEL;
    delete process.env.AI_PROVIDER;
    delete process.env.TAVILY_API_KEY;
    delete process.env.SERPER_API_KEY;
    delete process.env.BRAVE_API_KEY;
  });

  afterEach(() => {
    Object.keys(mockFiles).forEach((k) => delete mockFiles[k]);
  });

  it('provider-settings GET never returns the full api_key', async () => {
    const fullKey = 'nvapi-super-secret-key-1234567890';
    mockFiles[PROVIDER_FILE] = JSON.stringify({
      api_key: fullKey,
      provider: 'nvidia',
      base_url: 'https://integrate.api.nvidia.com/v1',
      model: 'z-ai/glm-5.3-flash',
    });

    const req = makeReq('http://localhost/api/provider-settings');
    const res = await providerGET(req, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    // The full key MUST NOT appear anywhere in the serialized body.
    expect(JSON.stringify(body)).not.toContain(fullKey);
    // Only the masked hint + set flag should be present.
    expect(body).toHaveProperty('api_key_set', true);
    expect(body).toHaveProperty('api_key_hint');
    expect(typeof body.api_key_hint).toBe('string');
    // Hint shows the last 4 chars of the actual key.
    expect(body.api_key_hint).toMatch(/••••7890$/);
    // No raw `api_key` field at all.
    expect(body).not.toHaveProperty('api_key');
  });

  it('provider-settings GET reports api_key_set=false when no key is configured', async () => {
    // No settings file, no env keys.
    const req = makeReq('http://localhost/api/provider-settings');
    const res = await providerGET(req, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('api_key_set', false);
    expect(body.api_key_hint).toBeNull();
  });

  it('signals-config GET never returns the full tavily / serper / brave keys', async () => {
    const tavily = 'tavily-secret-key-aaaa';
    const serper = 'serper-secret-key-bbbb';
    const brave = 'brave-secret-key-cccc';
    mockFiles[SIGNALS_FILE] = JSON.stringify({
      tavily_api_key: tavily,
      serper_api_key: serper,
      brave_api_key: brave,
    });

    const req = makeReq('http://localhost/api/signals-config');
    const res = await signalsGET(req, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    const serialized = JSON.stringify(body);
    // None of the full keys appear in the response body.
    expect(serialized).not.toContain(tavily);
    expect(serialized).not.toContain(serper);
    expect(serialized).not.toContain(brave);
    // Masked hints + set flags are present.
    expect(body).toHaveProperty('tavily_set', true);
    expect(body.tavily_hint).toMatch(/••••aaaa$/);
    expect(body).toHaveProperty('serper_set', true);
    expect(body.serper_hint).toMatch(/••••bbbb$/);
    expect(body).toHaveProperty('brave_set', true);
    expect(body.brave_hint).toMatch(/••••cccc$/);
    // No raw keys at all.
    expect(body).not.toHaveProperty('tavily_api_key');
    expect(body).not.toHaveProperty('serper_api_key');
    expect(body).not.toHaveProperty('brave_api_key');
  });

  it('signals-config GET reports *_set=false when no keys are configured', async () => {
    const req = makeReq('http://localhost/api/signals-config');
    const res = await signalsGET(req, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tavily_set).toBe(false);
    expect(body.serper_set).toBe(false);
    expect(body.brave_set).toBe(false);
    expect(body.tavily_hint).toBeNull();
    expect(body.serper_hint).toBeNull();
    expect(body.brave_hint).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §1.5 — PUT with empty api_key preserves the existing value
// ---------------------------------------------------------------------------

describe('FASE-1-SEC §1.5 — PUT with empty api_key preserves the existing value', () => {
  beforeEach(() => {
    Object.keys(mockFiles).forEach((k) => delete mockFiles[k]);
    delete process.env.CHISMOSO_AUTH_ENABLED;
    delete process.env.CHISMOSO_AUTH_TOKENS;
    delete process.env.NODE_ENV;
    delete process.env.NVIDIA_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.TAVILY_API_KEY;
    delete process.env.SERPER_API_KEY;
    delete process.env.BRAVE_API_KEY;
  });

  afterEach(() => {
    Object.keys(mockFiles).forEach((k) => delete mockFiles[k]);
  });

  it('provider-settings PUT preserves the existing api_key when the body sends ""', async () => {
    const existingKey = 'nvapi-existing-key-xyz789';
    mockFiles[PROVIDER_FILE] = JSON.stringify({
      api_key: existingKey,
      provider: 'nvidia',
      base_url: 'https://integrate.api.nvidia.com/v1',
      model: 'z-ai/glm-5.3-flash',
    });

    // Save with empty api_key — should preserve existingKey.
    const req = makeReq('http://localhost/api/provider-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'nvidia',
        base_url: 'https://integrate.api.nvidia.com/v1',
        model: 'z-ai/glm-5.3-flash',
        api_key: '', // empty — must NOT overwrite
      }),
    });
    const res = await providerPUT(req, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.config.api_key_set).toBe(true);
    // Masked hint matches the EXISTING key's last 4, not a new empty value.
    expect(body.config.api_key_hint).toMatch(/••••z789$/);

    // The saved file on disk still contains the existing key.
    const saved = JSON.parse(mockFiles[PROVIDER_FILE]);
    expect(saved.api_key).toBe(existingKey);
  });

  it('signals-config PUT preserves existing keys when the body sends "" for them', async () => {
    const existingTavily = 'tavily-existing-key-aaaa';
    const existingSerper = 'serper-existing-key-bbbb';
    mockFiles[SIGNALS_FILE] = JSON.stringify({
      tavily_api_key: existingTavily,
      serper_api_key: existingSerper,
      brave_api_key: '',
    });

    // PUT with empty strings for all three keys — should preserve
    // existingTavily + existingSerper, leave brave empty.
    const req = makeReq('http://localhost/api/signals-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tavily_api_key: '',
        serper_api_key: '',
        brave_api_key: '',
      }),
    });
    const res = await signalsPUT(req, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.config.tavily_set).toBe(true);
    expect(body.config.tavily_hint).toMatch(/••••aaaa$/);
    expect(body.config.serper_set).toBe(true);
    expect(body.config.serper_hint).toMatch(/••••bbbb$/);

    const saved = JSON.parse(mockFiles[SIGNALS_FILE]);
    expect(saved.tavily_api_key).toBe(existingTavily);
    expect(saved.serper_api_key).toBe(existingSerper);
  });
});

// ---------------------------------------------------------------------------
// §1.5 — base_url SSRF validation
// ---------------------------------------------------------------------------

describe('FASE-1-SEC §1.5 — base_url SSRF validation', () => {
  beforeEach(() => {
    Object.keys(mockFiles).forEach((k) => delete mockFiles[k]);
    delete process.env.CHISMOSO_AUTH_ENABLED;
    delete process.env.CHISMOSO_AUTH_TOKENS;
    delete process.env.NODE_ENV;
    delete process.env.NVIDIA_API_KEY;
    delete process.env.GROQ_API_KEY;
  });

  afterEach(() => {
    Object.keys(mockFiles).forEach((k) => delete mockFiles[k]);
  });

  it('rejects http:// base_url with 400', async () => {
    const req = makeReq('http://localhost/api/provider-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'nvidia',
        base_url: 'http://insecure.example.com/v1',
        api_key: 'nvapi-test',
      }),
    });
    const res = await providerPUT(req, {});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.details.reason).toMatch(/https/i);
  });

  it('rejects base_url pointing at a private 192.168.x IP', async () => {
    const req = makeReq('http://localhost/api/provider-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'nvidia',
        base_url: 'https://192.168.1.1/v1',
        api_key: 'nvapi-test',
      }),
    });
    const res = await providerPUT(req, {});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.details.reason).toMatch(/private/i);
  });

  it('rejects base_url pointing at loopback 127.0.0.1', async () => {
    const req = makeReq('http://localhost/api/provider-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'nvidia',
        base_url: 'https://127.0.0.1:8080/v1',
        api_key: 'nvapi-test',
      }),
    });
    const res = await providerPUT(req, {});
    expect(res.status).toBe(400);
  });

  it('rejects base_url pointing at 169.254.x (cloud metadata)', async () => {
    const req = makeReq('http://localhost/api/provider-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'nvidia',
        base_url: 'https://169.254.169.254/v1',
        api_key: 'nvapi-test',
      }),
    });
    const res = await providerPUT(req, {});
    expect(res.status).toBe(400);
  });

  it('rejects base_url pointing at 10.x private range', async () => {
    const req = makeReq('http://localhost/api/provider-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'nvidia',
        base_url: 'https://10.0.0.1/v1',
        api_key: 'nvapi-test',
      }),
    });
    const res = await providerPUT(req, {});
    expect(res.status).toBe(400);
  });

  it('accepts a valid https:// public URL', async () => {
    const req = makeReq('http://localhost/api/provider-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'nvidia',
        base_url: 'https://integrate.api.nvidia.com/v1',
        api_key: 'nvapi-test-1234',
      }),
    });
    const res = await providerPUT(req, {});
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// §1.3 — getAuthConfig fail-closed in production
// ---------------------------------------------------------------------------

describe('FASE-1-SEC §1.3 — getAuthConfig fail-closed in production', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAuthEnabled = process.env.CHISMOSO_AUTH_ENABLED;

  beforeEach(() => {
    delete process.env.CHISMOSO_AUTH_ENABLED;
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalAuthEnabled === undefined) delete process.env.CHISMOSO_AUTH_ENABLED;
    else process.env.CHISMOSO_AUTH_ENABLED = originalAuthEnabled;
  });

  it('defaults auth OFF in development (NODE_ENV unset)', () => {
    delete process.env.NODE_ENV;
    expect(getAuthConfig().enabled).toBe(false);
  });

  it('defaults auth OFF when NODE_ENV="development"', () => {
    process.env.NODE_ENV = 'development';
    expect(getAuthConfig().enabled).toBe(false);
  });

  it('defaults auth ON in production when CHISMOSO_AUTH_ENABLED is unset', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.CHISMOSO_AUTH_ENABLED;
    expect(getAuthConfig().enabled).toBe(true);
  });

  it('keeps auth ON in production when CHISMOSO_AUTH_ENABLED is empty string (the original bug)', () => {
    // Previously: `enabledEnv === 'true'` → '' === 'true' → false → auth OFF.
    // Now: only explicit 'false' disables in production.
    process.env.NODE_ENV = 'production';
    process.env.CHISMOSO_AUTH_ENABLED = '';
    expect(getAuthConfig().enabled).toBe(true);
  });

  it('keeps auth ON in production when CHISMOSO_AUTH_ENABLED is a typo (e.g. "yes")', () => {
    process.env.NODE_ENV = 'production';
    process.env.CHISMOSO_AUTH_ENABLED = 'yes';
    expect(getAuthConfig().enabled).toBe(true);
  });

  it('keeps auth ON in production when CHISMOSO_AUTH_ENABLED is "1" (numeric truthy)', () => {
    process.env.NODE_ENV = 'production';
    process.env.CHISMOSO_AUTH_ENABLED = '1';
    expect(getAuthConfig().enabled).toBe(true);
  });

  it('only disables auth in production when CHISMOSO_AUTH_ENABLED is the literal "false"', () => {
    process.env.NODE_ENV = 'production';
    process.env.CHISMOSO_AUTH_ENABLED = 'false';
    expect(getAuthConfig().enabled).toBe(false);
  });

  it('honours CHISMOSO_AUTH_ENABLED="true" to enable auth in dev', () => {
    process.env.NODE_ENV = 'development';
    process.env.CHISMOSO_AUTH_ENABLED = 'true';
    expect(getAuthConfig().enabled).toBe(true);
  });
});
