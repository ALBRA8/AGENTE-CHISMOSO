/**
 * Unit tests — Outbound URL validator / SSRF guard (Task IMP-2)
 */

import { describe, it, expect } from 'vitest';
import { validateOutboundUrl } from '../src/mesh/url-validator.js';

describe('url-validator', () => {
  it('accepts valid https URLs', () => {
    expect(validateOutboundUrl('https://example.com/webhook').ok).toBe(true);
    expect(validateOutboundUrl('https://agentes-leads.com/api/opp').ok).toBe(true);
  });

  it('rejects file:// and other protocols', () => {
    expect(validateOutboundUrl('file:///etc/passwd').ok).toBe(false);
    expect(validateOutboundUrl('ftp://example.com/file').ok).toBe(false);
    expect(validateOutboundUrl('gopher://example.com/').ok).toBe(false);
  });

  it('rejects localhost', () => {
    expect(validateOutboundUrl('http://localhost/admin').ok).toBe(false);
    expect(validateOutboundUrl('http://127.0.0.1/admin').ok).toBe(false);
    expect(validateOutboundUrl('http://[::1]/admin').ok).toBe(false);
  });

  it('rejects private IPs', () => {
    expect(validateOutboundUrl('http://10.0.0.1/internal').ok).toBe(false);
    expect(validateOutboundUrl('http://192.168.1.1/router').ok).toBe(false);
    expect(validateOutboundUrl('http://172.16.0.1/internal').ok).toBe(false);
  });

  it('rejects cloud metadata endpoint', () => {
    expect(validateOutboundUrl('http://169.254.169.254/latest/meta-data/').ok).toBe(false);
  });

  it('rejects userinfo in URL', () => {
    expect(validateOutboundUrl('https://user:pass@example.com/').ok).toBe(false);
  });

  it('rejects internal TLDs', () => {
    expect(validateOutboundUrl('http://intranet.local/').ok).toBe(false);
    expect(validateOutboundUrl('http://service.internal/').ok).toBe(false);
  });

  it('rejects suspicious hostnames', () => {
    expect(validateOutboundUrl('http://localhost/.env').ok).toBe(false);
  });

  it('rejects common database ports', () => {
    expect(validateOutboundUrl('http://example.com:3306/').ok).toBe(false);
    expect(validateOutboundUrl('http://example.com:5432/').ok).toBe(false);
    expect(validateOutboundUrl('http://example.com:6379/').ok).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(validateOutboundUrl('not a url').ok).toBe(false);
    expect(validateOutboundUrl('').ok).toBe(false);
    expect(validateOutboundUrl('http://').ok).toBe(false);
  });
});
