/**
 * CHISMOSO V1.5 — Mesh webhook delivery + inbound HMAC verification
 * (Task IMP-PROD-SEC, audit H-5)
 *
 * Two responsibilities:
 *
 *   1. **Outbound** — `deliverWebhook(input)`: POST `payload` as JSON to
 *      `url`. If `secret` is provided, adds the header
 *      `X-Chismoso-Signature: sha256=<hex-hmac>` which is the
 *      HMAC-SHA256 of the raw JSON body over `secret`. The receiver
 *      re-computes the HMAC and compares in constant time.
 *
 *      The secret comes from env / runtime memory — NEVER from the
 *      `mesh_subscribers.secret` column (which is now `secret_hash`,
 *      a SHA-256 of the real secret — see audit H-8). Outbound delivery
 *      therefore requires the operator to set
 *      `CHISMOSO_WEBHOOK_SECRET_<AGENT>` env vars per agent.
 *
 *   2. **Inbound** — `verifyInboundSignature(opts)`: for mesh_subscribers
 *      that RECEIVE external signals (e.g. the orchestrator subscribing
 *      to NEX-SCOPE), verify the inbound `X-Chismoso-Signature` header
 *      against `HMAC-SHA256(rawBody, secret)`. Returns:
 *        - `verified: true`  on match (or when no secret configured —
 *          open inbound, same as V1.0).
 *        - `verified: false` on signature mismatch / missing header
 *          with a `reason` for the caller to use in a 401 response.
 *
 * Design choices:
 *   - Uses the global `fetch` (Node 20+ ships it natively).
 *   - 10 second timeout via `AbortController` (matches the orchestrator's
 *     bounded-runtime philosophy — never hang the mesh on a slow receiver).
 *   - Treats HTTP 2xx as success; anything else is a failure with the
 *     status code captured for the outbox's `last_error` column.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
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

// ---------------------------------------------------------------------------
// INBOUND HMAC VERIFICATION (audit H-5)
// ---------------------------------------------------------------------------

export interface InboundSignatureInput {
  /** Raw request body bytes (NOT the parsed JSON — order/whitespace matters). */
  rawBody: string | Buffer;
  /** Value of the `X-Chismoso-Signature` header (`sha256=<hex>` or empty). */
  signatureHeader: string | null | undefined;
  /** Shared secret with the sender. If empty/undefined, verification is SKIPPED. */
  secret?: string | null;
}

export interface InboundSignatureResult {
  /** True if verification passed OR was skipped (no secret configured). */
  verified: boolean;
  /**
   * Always present when `verified === false`. Caller should return a 401
   * with this reason in the response body's `details.reason` field.
   */
  reason?: 'no_secret_configured_open_inbound' | 'missing_signature_header' | 'malformed_signature_header' | 'signature_mismatch';
  /** The hex digest the server computed (for debugging — never expose to clients). */
  computedDigest?: string;
}

/**
 * Verify the inbound `X-Chismoso-Signature` header against the raw request
 * body. Returns `{ verified: true }` when:
 *   - The secret is missing/unset — inbound verification is silently
 *     skipped (legacy behavior; log it server-side for visibility).
 *   - The signature header is present and matches
 *     `HMAC-SHA256(rawBody, secret)` in constant time.
 *
 * Returns `{ verified: false, reason }` when:
 *   - The secret IS configured but the header is missing → 401.
 *   - The header is malformed (not `sha256=<hex>`) → 401.
 *   - The header is present but the HMAC doesn't match → 401.
 *
 * The caller (e.g. `POST /api/mesh/external-signals`) MUST read the raw
 * request body BEFORE parsing it as JSON — the signature is over the
 * exact bytes the sender sent, not a re-serialized form.
 *
 * Example:
 *   ```ts
 *   const rawBody = await req.text();
 *   const sig = req.headers.get('X-Chismoso-Signature');
 *   const secret = process.env.CHISMOSO_WEBHOOK_SECRET_NEX_SCOPE;
 *   const v = verifyInboundSignature({ rawBody, signatureHeader: sig, secret });
 *   if (!v.verified) {
 *     return new Response(JSON.stringify({ error: 'Unauthorized', details: { reason: v.reason } }), { status: 401 });
 *   }
 *   const body = JSON.parse(rawBody);
 *   ```
 */
export function verifyInboundSignature(
  input: InboundSignatureInput,
): InboundSignatureResult {
  const { rawBody, signatureHeader, secret } = input;

  // No secret configured → inbound is open (same as V1.0). Caller logs
  // this for visibility but accepts the request.
  if (!secret || secret.length === 0) {
    return {
      verified: true,
      reason: 'no_secret_configured_open_inbound',
    };
  }

  // Secret IS configured → header MUST be present + well-formed.
  if (!signatureHeader || signatureHeader.length === 0) {
    return { verified: false, reason: 'missing_signature_header' };
  }

  // Header format: `sha256=<hex>`. Reject anything else.
  const prefix = 'sha256=';
  if (!signatureHeader.startsWith(prefix)) {
    return { verified: false, reason: 'malformed_signature_header' };
  }
  const receivedHex = signatureHeader.slice(prefix.length);
  if (!/^[a-fA-F0-9]{64}$/.test(receivedHex)) {
    return { verified: false, reason: 'malformed_signature_header' };
  }

  // Compute the expected HMAC over the raw body.
  const bodyBuf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const expectedHex = createHmac('sha256', secret).update(bodyBuf).digest('hex');

  // Constant-time compare.
  const received = Buffer.from(receivedHex, 'utf8');
  const expected = Buffer.from(expectedHex, 'utf8');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return {
      verified: false,
      reason: 'signature_mismatch',
      computedDigest: expectedHex,
    };
  }
  return { verified: true, computedDigest: expectedHex };
}
