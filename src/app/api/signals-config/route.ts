import { NextResponse } from 'next/server';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';

const SIGNALS_FILE = path.join(process.cwd(), '.signals-settings.json');
const ENV_FILE = path.join(process.cwd(), '.env');

const DEFAULT_SIGNALS = {
  tavily_api_key: process.env.TAVILY_API_KEY || '',
  serper_api_key: process.env.SERPER_API_KEY || '',
  brave_api_key: process.env.BRAVE_API_KEY || '',
  github_token: process.env.GITHUB_TOKEN || '',
  shodan_api_key: process.env.SHODAN_API_KEY || '',
  zai_api_key: process.env.ZAI_API_KEY || '',
};

export async function GET() {
  try {
    const data = await readFile(SIGNALS_FILE, 'utf-8');
    const json = JSON.parse(data);
    return NextResponse.json({
      tavily_api_key: json.tavily_api_key || process.env.TAVILY_API_KEY || '',
      serper_api_key: json.serper_api_key || process.env.SERPER_API_KEY || '',
      brave_api_key: json.brave_api_key || process.env.BRAVE_API_KEY || '',
      github_token: json.github_token || process.env.GITHUB_TOKEN || '',
      shodan_api_key: json.shodan_api_key || process.env.SHODAN_API_KEY || '',
      zai_api_key: json.zai_api_key || process.env.ZAI_API_KEY || '',
    });
  } catch {
    return NextResponse.json(DEFAULT_SIGNALS);
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const config = {
      tavily_api_key: (body.tavily_api_key || '').trim(),
      serper_api_key: (body.serper_api_key || '').trim(),
      brave_api_key: (body.brave_api_key || '').trim(),
      github_token: (body.github_token || '').trim(),
      shodan_api_key: (body.shodan_api_key || '').trim(),
      zai_api_key: (body.zai_api_key || '').trim(),
      updated_at: new Date().toISOString(),
    };

    await writeFile(SIGNALS_FILE, JSON.stringify(config, null, 2), 'utf-8');

    // Update in-memory process.env
    if (config.tavily_api_key) process.env.TAVILY_API_KEY = config.tavily_api_key;
    if (config.serper_api_key) process.env.SERPER_API_KEY = config.serper_api_key;
    if (config.brave_api_key) process.env.BRAVE_API_KEY = config.brave_api_key;
    if (config.github_token) process.env.GITHUB_TOKEN = config.github_token;
    if (config.shodan_api_key) process.env.SHODAN_API_KEY = config.shodan_api_key;
    if (config.zai_api_key) process.env.ZAI_API_KEY = config.zai_api_key;

    // Persist to .env
    try {
      let envContent = await readFile(ENV_FILE, 'utf-8').catch(() => '');
      const lines = envContent.split(/\r?\n/);
      const envMap: Record<string, string> = {};
      for (const line of lines) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m) envMap[m[1]] = m[2];
      }

      if (config.tavily_api_key) envMap['TAVILY_API_KEY'] = config.tavily_api_key;
      if (config.serper_api_key) envMap['SERPER_API_KEY'] = config.serper_api_key;
      if (config.brave_api_key) envMap['BRAVE_API_KEY'] = config.brave_api_key;
      if (config.github_token) envMap['GITHUB_TOKEN'] = config.github_token;
      if (config.shodan_api_key) envMap['SHODAN_API_KEY'] = config.shodan_api_key;
      if (config.zai_api_key) envMap['ZAI_API_KEY'] = config.zai_api_key;

      const newEnv = Object.entries(envMap).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
      await writeFile(ENV_FILE, newEnv, 'utf-8');
    } catch {}

    return NextResponse.json({ ok: true, config });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Error al guardar APIs de señales' }, { status: 500 });
  }
}
