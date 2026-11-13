/**
 * CHISMOSO V1.5 — CORS allowlist
 */

export function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return true; // same-origin or non-browser request

  try {
    const u = new URL(origin);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1') {
      return true;
    }
  } catch {}

  const allowlist = getAllowlist();
  for (const allowed of allowlist) {
    if (origin === allowed) return true;
  }
  return false;
}

export function corsHeadersForOrigin(
  origin: string | null,
): Record<string, string> | null {
  if (!isOriginAllowed(origin)) return null;
  if (!origin) return {}; // same-origin — no CORS headers needed
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, X-Chismoso-Agent, X-CSRF-Token',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function getAllowlist(): string[] {
  const defaults = ['http://localhost:3000', 'http://127.0.0.1:3000'];
  const raw = process.env.CHISMOSO_CORS_ORIGINS ?? '';
  const parsed = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return Array.from(new Set([...defaults, ...parsed]));
}
