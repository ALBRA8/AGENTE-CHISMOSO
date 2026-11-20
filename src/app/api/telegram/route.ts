/**
 * /api/telegram — Telegram bot token config (Task FASE-1-SEC §1.1)
 *
 * GET  — returns `token_set: boolean` + bot info. NEVER returns the
 *        full token. Protected by `authedRoute`.
 * PUT  — saves the Telegram bot token to `.telegram-settings.json`
 *        with mode 0o600. If `token` is empty, the existing value
 *        is preserved. Protected by `authedRoute`.
 * POST — probes the Telegram API with the saved token to verify it
 *        (returns the bot's username on success). Protected by
 *        `authedRoute`.
 */

import { NextResponse, NextRequest } from 'next/server';
import { readFile, writeFile, chmod } from 'fs/promises';
import path from 'path';
import { authedRoute } from '@/lib/middleware';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TELEGRAM_FILE = path.join(process.cwd(), '.telegram-settings.json');

async function readTelegram(): Promise<any | null> {
  try {
    const data = await readFile(TELEGRAM_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export const GET = authedRoute(async (_req: NextRequest) => {
  const existing = await readTelegram();
  const token = existing?.token || process.env.TELEGRAM_BOT_TOKEN || '';
  return NextResponse.json({
    token_set: Boolean(token),
    enabled: existing?.enabled ?? false,
    bot_username: existing?.bot_username || null,
  });
});

export const PUT = authedRoute(async (req: NextRequest) => {
  try {
    const body = await req.json();
    const current = (await readTelegram()) ?? {};

    // Preserve existing token when caller sends empty (the dashboard
    // GETs only `token_set`, so a save without re-entering the token
    // arrives as `token: ""`).
    const incomingToken =
      typeof body.token === 'string' ? body.token.trim() : '';
    const token = incomingToken || current.token || process.env.TELEGRAM_BOT_TOKEN || '';
    const enabled =
      body.enabled !== undefined ? Boolean(body.enabled) : current.enabled ?? true;

    const updated = {
      ...current,
      token,
      enabled,
      updated_at: new Date().toISOString(),
    };

    await writeFile(TELEGRAM_FILE, JSON.stringify(updated, null, 2), 'utf-8');
    try {
      await chmod(TELEGRAM_FILE, 0o600);
    } catch {
      // chmod can fail on Windows — non-fatal.
    }
    if (token) process.env.TELEGRAM_BOT_TOKEN = token;

    return NextResponse.json({ ok: true, token_set: Boolean(token), enabled });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || 'Error al guardar Telegram' },
      { status: 500 },
    );
  }
});

export const POST = authedRoute(async (req: NextRequest) => {
  try {
    const body = await req.json().catch(() => ({}));
    let token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!token) {
      const existing = await readTelegram();
      token = existing?.token || '';
    }
    if (!token) token = process.env.TELEGRAM_BOT_TOKEN || '';

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
    return NextResponse.json({ ok: false, message: err?.message || 'Fallo de conexión con Telegram' });
  }
});
