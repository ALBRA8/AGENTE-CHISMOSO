import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const DAEMON_URL = process.env.WHATSAPP_DAEMON_URL || 'http://127.0.0.1:3002';
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || '12345678901234567890123456789012';
const TIMEOUT_MS = 5000;

function ensureDaemonRunning() {
  try {
    const daemonScript = path.resolve('D:/PROYECTOS/AGENTES CON IA/AGENTE GENERAL/dashboard/src/server/whatsapp-daemon.js');
    const nodeModulesPath = path.resolve('D:/PROYECTOS/AGENTES CON IA/AGENTE GENERAL/dashboard/node_modules');

    if (!fs.existsSync(daemonScript)) return;

    const env = {
      ...process.env,
      NODE_PATH: nodeModulesPath,
      INTERNAL_API_SECRET: INTERNAL_API_SECRET,
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
  } catch {}
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
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
    let res = await makeReq();
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('content-type') || 'application/json' },
    });
  } catch {
    // If daemon is not running, attempt to boot it
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
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
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
      // Daemon might be down, start it
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
      message: err.message || 'Error al conectar con WhatsApp',
    });
  }
}
