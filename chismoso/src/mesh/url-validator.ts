/**
 * CHISMOSO V1.0 — Outbound URL validator (Task IMP-2)
 *
 * Defensive guard used by the mesh webhook delivery and any other code path
 * that fetches a URL supplied at runtime. Blocks SSRF vectors:
 *   - Non-http(s) protocols (file://, ftp://, gopher://, etc.)
 *   - localhost / 127.0.0.0/8 / ::1 / 0.0.0.0
 *   - Private IPs (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16)
 *   - Cloud metadata endpoints (169.254.169.254 — AWS/GCP metadata)
 *   - Internal TLDs (.local, .internal, .lan, .intranet)
 *   - Userinfo in URL (user:pass@host — could be confused with host)
 *   - Common database / admin ports (22, 25, 3306, 5432, 6379, 27017)
 *
 * NOTE: This validator is a static check on the URL string. It does NOT
 * resolve DNS, so a hostname that resolves to a private IP at runtime
 * (DNS rebinding) is not caught here — callers that need full protection
 * should additionally pin the resolved IP before connecting. For the
 * CHISMOSO mesh, all outbound URLs come from operator-configured webhook
 * subscriptions, so static validation is sufficient.
 */

import { isIP } from 'node:net';

export interface UrlValidationResult {
  ok: boolean;
  reason?: string;
  safeUrl?: URL;
}

const BLOCKED_HOSTS = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'broadcasthost',
]);

const BLOCKED_TLDS = new Set([
  'local',
  'internal',
  'lan',
  'intranet',
]);

/**
 * Validates a URL for safe outbound HTTP fetching.
 * Blocks:
 *   - Non-http(s) protocols (file://, ftp://, gopher://, etc.)
 *   - localhost / 127.0.0.0/8 / ::1 / 0.0.0.0
 *   - Private IPs (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16)
 *   - Cloud metadata endpoints (169.254.169.254 — AWS/GCP metadata)
 *   - Internal TLDs (.local, .internal, .lan, .intranet)
 *   - Userinfo in URL (user:pass@host — could be confused with host)
 */
export function validateOutboundUrl(rawUrl: string): UrlValidationResult {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'Invalid URL format' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `Protocol ${url.protocol} not allowed (only http/https)` };
  }

  if (url.username || url.password) {
    return { ok: false, reason: 'URL userinfo not allowed' };
  }

  const host = url.hostname.toLowerCase();

  if (BLOCKED_HOSTS.has(host)) {
    return { ok: false, reason: `Blocked host: ${host}` };
  }

  // Check if host is an IP literal
  const ipVersion = isIP(host);
  if (ipVersion > 0) {
    if (isPrivateIP(host, ipVersion)) {
      return { ok: false, reason: `Private/loopback IP not allowed: ${host}` };
    }
  } else {
    // Hostname — check TLD
    const tld = host.split('.').pop();
    if (tld && BLOCKED_TLDS.has(tld)) {
      return { ok: false, reason: `Internal TLD not allowed: .${tld}` };
    }
    // Block hostnames that look like internal names (no dot, or starts with .)
    if (!host.includes('.') || host.startsWith('.')) {
      return { ok: false, reason: `Suspicious hostname: ${host}` };
    }
  }

  // Block default ports commonly used for internal services
  const port = url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80);
  if (port === 22 || port === 25 || port === 3306 || port === 5432 || port === 6379 || port === 27017) {
    return { ok: false, reason: `Blocked port: ${port}` };
  }

  return { ok: true, safeUrl: url };
}

function isPrivateIP(ip: string, version: number): boolean {
  if (version === 4) {
    // 127.0.0.0/8 — loopback
    if (ip.startsWith('127.')) return true;
    // 0.0.0.0/8
    if (ip.startsWith('0.')) return true;
    // 10.0.0.0/8
    if (ip.startsWith('10.')) return true;
    // 172.16.0.0/12
    if (ip.startsWith('172.')) {
      const second = parseInt(ip.split('.')[1], 10);
      if (second >= 16 && second <= 31) return true;
    }
    // 192.168.0.0/16
    if (ip.startsWith('192.168.')) return true;
    // 169.254.0.0/16 — link-local (includes 169.254.169.254 — cloud metadata)
    if (ip.startsWith('169.254.')) return true;
    // 100.64.0.0/10 — CGNAT
    if (ip.startsWith('100.')) {
      const second = parseInt(ip.split('.')[1], 10);
      if (second >= 64 && second <= 127) return true;
    }
  } else if (version === 6) {
    // ::1 — loopback
    if (ip === '::1') return true;
    // fc00::/7 — unique local
    if (/^f[cd][0-9a-f]{2}:/.test(ip)) return true;
    // fe80::/10 — link-local
    if (/^fe[89ab][0-9a-f]:/.test(ip)) return true;
  }
  return false;
}
