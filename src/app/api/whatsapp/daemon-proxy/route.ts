import { NextResponse } from 'next/server';

const DAEMON_URL = process.env.WHATSAPP_DAEMON_URL || 'http://localhost:3002';
const TIMEOUT_MS = 4000;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const path = searchParams.get('path') || '/status';

  try {
    const res = await fetch(`${DAEMON_URL}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });

    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('content-type') || 'application/json' },
    });
  } catch {
    return NextResponse.json({
      status: 'disconnected',
      qr: null,
      phone: null,
      message: 'WhatsApp Daemon no está en ejecución en puerto 3002.',
    });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const path = body.path || '/connect';
    const { path: _path, ...payload } = body;

    const res = await fetch(`${DAEMON_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('content-type') || 'application/json' },
    });
  } catch (err: any) {
    return NextResponse.json({
      ok: false,
      status: 'disconnected',
      message: 'Daemon de WhatsApp desconectado o no iniciado.',
    });
  }
}
