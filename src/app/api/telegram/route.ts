import { NextResponse } from 'next/server';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';

const TELEGRAM_FILE = path.join(process.cwd(), '.telegram-settings.json');

export async function GET() {
  try {
    const data = await readFile(TELEGRAM_FILE, 'utf-8');
    const json = JSON.parse(data);
    return NextResponse.json({
      token_set: Boolean(json.token || process.env.TELEGRAM_BOT_TOKEN),
      enabled: json.enabled ?? false,
      bot_username: json.bot_username || null,
    });
  } catch {
    const token = process.env.TELEGRAM_BOT_TOKEN || '';
    return NextResponse.json({
      token_set: Boolean(token),
      enabled: Boolean(token),
      bot_username: null,
    });
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    let current: any = {};
    try {
      const data = await readFile(TELEGRAM_FILE, 'utf-8');
      current = JSON.parse(data);
    } catch {}

    const token = body.token !== undefined ? body.token.trim() : current.token;
    const enabled = body.enabled !== undefined ? Boolean(body.enabled) : current.enabled ?? true;

    const updated = {
      ...current,
      token,
      enabled,
      updated_at: new Date().toISOString(),
    };

    await writeFile(TELEGRAM_FILE, JSON.stringify(updated, null, 2), 'utf-8');
    if (token) process.env.TELEGRAM_BOT_TOKEN = token;

    return NextResponse.json({ ok: true, token_set: Boolean(token), enabled });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Error al guardar Telegram' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    let token = body.token?.trim();
    if (!token) {
      try {
        const data = await readFile(TELEGRAM_FILE, 'utf-8');
        token = JSON.parse(data).token;
      } catch {}
      if (!token) token = process.env.TELEGRAM_BOT_TOKEN;
    }

    if (!token) {
      return NextResponse.json({ ok: false, message: 'Token de Telegram no configurado' });
    }

    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    if (data.ok && data.result) {
      return NextResponse.json({
        ok: true,
        bot_username: data.result.username,
        first_name: data.result.first_name,
      });
    }

    return NextResponse.json({ ok: false, message: data.description || 'Token inválido' });
  } catch (err: any) {
    return NextResponse.json({ ok: false, message: err.message || 'Fallo de conexión con Telegram' });
  }
}
