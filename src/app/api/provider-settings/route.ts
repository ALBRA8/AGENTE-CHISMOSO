import { NextResponse } from 'next/server';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';

const SETTINGS_FILE = path.join(process.cwd(), '.provider-settings.json');
const ENV_FILE = path.join(process.cwd(), '.env');

const DEFAULT_SETTINGS = {
  provider: 'nvidia',
  base_url: 'https://integrate.api.nvidia.com/v1',
  model: 'z-ai/glm-5.3-flash',
  api_key: process.env.NVIDIA_API_KEY || process.env.GROQ_API_KEY || '',
  temperature: 0.5,
  top_p: 1.0,
  max_tokens: 1024,
  timeout: 60,
};

export async function GET() {
  try {
    const data = await readFile(SETTINGS_FILE, 'utf-8');
    const json = JSON.parse(data);
    return NextResponse.json({
      ...DEFAULT_SETTINGS,
      ...json,
      api_key_set: Boolean(json.api_key || process.env.NVIDIA_API_KEY || process.env.GROQ_API_KEY),
    });
  } catch {
    const current = {
      ...DEFAULT_SETTINGS,
      provider: process.env.NVIDIA_API_KEY ? 'nvidia' : process.env.GROQ_API_KEY ? 'groq' : 'nvidia',
      base_url: process.env.AI_BASE_URL || 'https://integrate.api.nvidia.com/v1',
      model: process.env.AI_MODEL || 'z-ai/glm-5.3-flash',
      api_key: process.env.NVIDIA_API_KEY || process.env.GROQ_API_KEY || '',
      api_key_set: Boolean(process.env.NVIDIA_API_KEY || process.env.GROQ_API_KEY),
    };
    return NextResponse.json(current);
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const provider = body.provider || 'nvidia';
    const baseUrl = body.base_url || 'https://integrate.api.nvidia.com/v1';
    const model = body.model || 'z-ai/glm-5.3-flash';
    const apiKey = body.api_key || '';
    const temperature = Number(body.temperature) || 0.5;
    const topP = Number(body.top_p) || 1.0;
    const maxTokens = Number(body.max_tokens) || 1024;
    const timeout = Number(body.timeout) || 60;

    const toSave = {
      provider,
      base_url: baseUrl,
      model,
      api_key: apiKey,
      temperature,
      top_p: topP,
      max_tokens: maxTokens,
      timeout,
      updated_at: new Date().toISOString(),
    };

    // Save to settings file
    await writeFile(SETTINGS_FILE, JSON.stringify(toSave, null, 2), 'utf-8');

    // Update process.env and sync with .env file
    if (provider === 'nvidia') {
      process.env.NVIDIA_API_KEY = apiKey;
    } else if (provider === 'groq') {
      process.env.GROQ_API_KEY = apiKey;
    } else if (provider === 'google') {
      process.env.GOOGLE_API_KEY = apiKey;
    } else if (provider === 'openai') {
      process.env.OPENAI_API_KEY = apiKey;
    }
    process.env.AI_PROVIDER = provider;
    process.env.AI_BASE_URL = baseUrl;
    process.env.AI_MODEL = model;

    try {
      let envContent = await readFile(ENV_FILE, 'utf-8').catch(() => '');
      const lines = envContent.split(/\r?\n/);
      const envMap: Record<string, string> = {};
      for (const line of lines) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m) envMap[m[1]] = m[2];
      }

      if (apiKey) {
        if (provider === 'nvidia') envMap['NVIDIA_API_KEY'] = apiKey;
        if (provider === 'groq') envMap['GROQ_API_KEY'] = apiKey;
        if (provider === 'google') envMap['GOOGLE_API_KEY'] = apiKey;
        if (provider === 'openai') envMap['OPENAI_API_KEY'] = apiKey;
      }
      envMap['AI_PROVIDER'] = provider;
      envMap['AI_BASE_URL'] = baseUrl;
      envMap['AI_MODEL'] = model;

      const newEnv = Object.entries(envMap).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
      await writeFile(ENV_FILE, newEnv, 'utf-8');
    } catch {}

    return NextResponse.json({ ok: true, config: { ...toSave, api_key_set: Boolean(apiKey) } });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Error al guardar configuración' }, { status: 500 });
  }
}
