/**
 * CHISMOSO V1.0 — Mesh webhook delivery (Task EXP-2)
 *
 * Outbound HTTP client used by `AgentMesh.deliverPending()` to push events
 * to registered subscribers. Signs the payload with HMAC-SHA256 if a
 * shared secret is configured so the receiver can verify authenticity.
 *
 * Design choices:
 *   - Uses the global `fetch` (Node 20+ ships it natively).
 *   - 10 second timeout via `AbortController` (matches the orchestrator's
 *     bounded-runtime philosophy — never hang the mesh on a slow receiver).
 *   - Treats HTTP 2xx as success; anything else is a failure with the
 *     status code captured for the outbox's `last_error` column.
 */

import { createHmac } from 'node:crypto';
import { validateOutboundUrl } from './url-validator.js';

export interface WebhookDeliveryInput {
  url: string;
  secret?: string;
  payload: unknown;
}

export interface WebhookDeliveryResult {
  ok: boolean;
  status: number;
  error?: string;
}

const WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * Deliver a single webhook: POST `payload` as JSON to `url`. If `secret`
 * is provided, adds the header `X-Chismoso-Signature: sha256=<hex-hmac>`
 * which is the HMAC-SHA256 of the raw JSON body.
 *
 * Returns `{ ok: true, status: 2xx }` on success, otherwise `{ ok: false,
 * status, error }` with a human-readable error string.
 */
export async function deliverWebhook(input: WebhookDeliveryInput): Promise<WebhookDeliveryResult> {
  const { url, secret, payload } = input;
  let body: string;
  try {
    body = JSON.stringify(payload);
  } catch (e: any) {
    return { ok: false, status: 0, error: `payload_serialize_failed: ${e?.message ?? String(e)}` };
  }

  if (!url) {
    return { ok: false, status: 0, error: 'invalid_url: url is empty' };
  }

  // SSRF guard — reject localhost, private IPs, cloud metadata endpoints,
  // internal TLDs, non-http(s) protocols, userinfo and common DB ports
  // before we hand the URL to fetch(). See url-validator.ts for the full
  // block list.
  const validation = validateOutboundUrl(url);
  if (!validation.ok || !validation.safeUrl) {
    return { ok: false, status: 0, error: `URL rejected: ${validation.reason}` };
  }
  const safeUrl = validation.safeUrl.toString();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'chismoso-mesh/1.0',
  };
  if (secret) {
    headers['X-Chismoso-Signature'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(safeUrl, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, status: res.status };
    }
    let errText = '';
    try {
      errText = await res.text();
    } catch {
      /* ignore body read error */
    }
    return {
      ok: false,
      status: res.status,
      error: `http_${res.status}: ${errText.slice(0, 200)}`,
    };
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      return { ok: false, status: 0, error: `timeout_after_${WEBHOOK_TIMEOUT_MS}ms` };
    }
    return { ok: false, status: 0, error: `fetch_failed: ${e?.message ?? String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}
