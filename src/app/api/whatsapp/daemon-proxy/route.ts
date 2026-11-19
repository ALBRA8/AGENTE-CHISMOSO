/**
 * /api/whatsapp/daemon-proxy — proxy to the WhatsApp daemon (Task FASE-1-SEC §1.1)
 *
 * GET  — proxies `GET ${DAEMON_URL}${path}` to the WhatsApp daemon
 *        running on 127.0.0.1:3002. Bootstraps the daemon on first
 *        call (best-effort). Protected by `authedRoute`.
 * POST — proxies a POST to the daemon (e.g. /connect, /disconnect).
 *        Protected by `authedRoute`.
 *
 * The historical implementation hard-coded a Windows absolute path
 * pointing at the original developer's machine — that path didn't
 * exist on the deployment host (Linux container, macOS dev box, etc.)
 * so the bootstrap silently no-op'd everywhere outside the original
 * dev machine. We now resolve the daemon script relative to
 * `process.cwd()` (`./mini-services/whatsapp-daemon/...` or
 * `./src/server/whatsapp-daemon.js`) so the auto-bootstrap works
 * consistently across environments. The daemon is optional — if the
 * script isn't found, we still proxy and let the caller see the
 * "starting" message.
 */

import { NextResponse, NextRequest } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { authedRoute } from '@/lib/middleware';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DAEMON_URL = process.env.WHATSAPP_DAEMON_URL || 'http://127.0.0.1:3002';
const INTERNAL_API_SECRET =
  process.env.INTERNAL_API_SECRET || '12345678901234567890123456789012';
const TIMEOUT_MS = 5000;

/**
 * Best-effort bootstrap of the WhatsApp daemon. Resolves the daemon
 * script relative to the project root (the historical Windows absolute
 * path was removed in Task FASE-2-DEPS). If the script isn't found,
 * returns silently — the proxy will still return its "starting"
 * message and the operator can launch the daemon manually.
 */
function ensureDaemonRunning() {
  try {
    // Candidate locations relative to process.cwd():
    //   1. ./mini-services/whatsapp-daemon/index.ts (bun)
    //   2. ./src/server/whatsapp-daemon.js        (node, legacy)
    //   3. ./mini-services/whatsapp-daemon/index.js
    const candidates = [
      path.resolve(process.cwd(), 'mini-services', 'whatsapp-daemon', 'index.ts'),
      path.resolve(process.cwd(), 'mini-services', 'whatsapp-daemon', 'index.js'),
      path.resolve(process.cwd(), 'src', 'server', 'whatsapp-daemon.js'),
    ];
    const daemonScript = candidates.find((p) => fs.existsSync(p));
    if (!daemonScript) return;

    const env = {
      ...process.env,
      INTERNAL_API_SECRET,
      WHATSAPP_DAEMON_PORT: '3002',
      WHATSAPP_DAEMON_HOST: '127.0.0.1',
    };

    const child = spawn(process.execPath, [daemonScript], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env,
    });
    child.unref();
  } catch {
    // Bootstrap is best-effort — never let it crash the proxy.
  }
}

export const GET = authedRoute(async (req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const pathParam = searchParams.get('path') || '/status';

  const makeReq = async () => {
    return await fetch(`${DAEMON_URL}${pathParam}`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${INTERNAL_API_SECRET}`,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
  };

  try {
    const res = await makeReq();
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('content-type') || 'application/json' },
    });
  } catch {
    // Daemon may be down — try to bootstrap, then retry once.
    ensureDaemonRunning();
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const retry = await makeReq();
      const text = await retry.text();
      return new NextResponse(text, {
        status: retry.status,
        headers: { 'Content-Type': retry.headers.get('content-type') || 'application/json' },
      });
    } catch {
      return NextResponse.json({
        status: 'disconnected',
        qr: null,
        phone: null,
        message: 'Iniciando servicio de WhatsApp...',
      });
    }
  }
});

export const POST = authedRoute(async (req: NextRequest) => {
  try {
    const body = await req.json().catch(() => ({}));
    const pathParam = body.path || '/connect';
    const { path: _path, ...payload } = body;

    const makePost = async () => {
      return await fetch(`${DAEMON_URL}${pathParam}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${INTERNAL_API_SECRET}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    };

    try {
      const res = await makePost();
      const text = await res.text();
      return new NextResponse(text, {
        status: res.status,
        headers: { 'Content-Type': res.headers.get('content-type') || 'application/json' },
      });
    } catch {
      // Daemon might be down — bootstrap and retry.
      ensureDaemonRunning();
      await new Promise((r) => setTimeout(r, 2000));
      const retry = await makePost();
      const text = await retry.text();
      return new NextResponse(text, {
        status: retry.status,
        headers: { 'Content-Type': retry.headers.get('content-type') || 'application/json' },
      });
    }
  } catch (err: any) {
    return NextResponse.json({
      ok: false,
      status: 'disconnected',
      message: err?.message || 'Error al conectar con WhatsApp',
    });
  }
});
