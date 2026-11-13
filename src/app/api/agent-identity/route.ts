import { NextResponse } from 'next/server';
import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';

const IDENTITY_FILE = path.join(process.cwd(), '.agent-identity.json');

const DEFAULT_IDENTITY = {
  name: 'CHISMOSO',
  role: 'Agente autónomo de inteligencia de señales (SIGINT/OSINT)',
  geography: 'global',
  language: 'es',
};

export async function GET() {
  try {
    const data = await readFile(IDENTITY_FILE, 'utf-8');
    return NextResponse.json({ ...DEFAULT_IDENTITY, ...JSON.parse(data) });
  } catch {
    return NextResponse.json(DEFAULT_IDENTITY);
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const name = (body.name || '').trim() || DEFAULT_IDENTITY.name;
    const role = (body.role || '').trim() || DEFAULT_IDENTITY.role;
    const geography = (body.geography || '').trim() || DEFAULT_IDENTITY.geography;
    const language = (body.language || '').trim() || DEFAULT_IDENTITY.language;

    const identity = { name, role, geography, language, updated_at: new Date().toISOString() };
    await mkdir(path.dirname(IDENTITY_FILE), { recursive: true });
    await writeFile(IDENTITY_FILE, JSON.stringify(identity, null, 2), 'utf-8');

    return NextResponse.json({ ok: true, ...identity });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Error al guardar identidad' }, { status: 500 });
  }
}
