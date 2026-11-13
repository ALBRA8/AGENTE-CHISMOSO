/**
 * CHISMOSO V1.0 — LLM Client (sección 41)
 *
 * El LLM es responsable de:
 *   - interpretar intención;
 *   - generar hipótesis;
 *   - planificar investigación;
 *   - seleccionar herramientas;
 *   - interpretar resultados;
 *   - sintetizar;
 *   - explicar incertidumbre.
 *
 * NO se encarga de scraping, persistencia, dedup, retries, scoring
 * determinista ni almacenamiento. Esas son responsabilidades de los
 * engines y repositories.
 *
 * V1.5 (REL-P0-006): every chat() call now goes through `llmCircuitBreaker`
 * so that 5 consecutive LLM failures open the circuit and we fail-fast
 * instead of hammering a degraded provider. The chat route / scheduler /
 * investigate route all observe the same breaker state.
 */

import fs from 'node:fs';
import path from 'node:path';
import ZAI from 'z-ai-web-dev-sdk';
import { logger } from '../logger.js';
import { classifyError, ErrorCode } from '../errors.js';
import { llmCircuitBreaker, CircuitBreakerError } from '../circuit-breaker.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  content: string;
  raw: unknown;
  durationMs: number;
  tokens?: number;
}

function getCustomProviderConfig(): { apiKey: string; baseUrl: string; model: string } | null {
  try {
    const settingsPath = path.resolve(process.cwd(), '..', '.provider-settings.json');
    const localSettingsPath = path.resolve(process.cwd(), '.provider-settings.json');
    let raw = '';
    if (fs.existsSync(settingsPath)) {
      raw = fs.readFileSync(settingsPath, 'utf-8');
    } else if (fs.existsSync(localSettingsPath)) {
      raw = fs.readFileSync(localSettingsPath, 'utf-8');
    }
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.api_key && parsed.provider !== 'mock') {
        return {
          apiKey: parsed.api_key,
          baseUrl: parsed.base_url || 'https://integrate.api.nvidia.com/v1',
          model: parsed.model || 'z-ai/glm-5.3-flash',
        };
      }
    }
  } catch {}

  const apiKey = process.env.NVIDIA_API_KEY || process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY;
  if (apiKey) {
    const isGroq = Boolean(process.env.GROQ_API_KEY);
    return {
      apiKey,
      baseUrl: process.env.AI_BASE_URL || (isGroq ? 'https://api.groq.com/openai/v1' : 'https://integrate.api.nvidia.com/v1'),
      model: process.env.AI_MODEL || (isGroq ? 'openai/gpt-oss-120b' : 'z-ai/glm-5.3-flash'),
    };
  }
  return null;
}

export class LLMClient {
  private zaiPromise: Promise<ZAI> | null = null;

  private async getZAI(): Promise<ZAI> {
    if (!this.zaiPromise) this.zaiPromise = ZAI.create();
    return this.zaiPromise;
  }

  private async callProviderDirect(messages: ChatMessage[], config: { apiKey: string; baseUrl: string; model: string }): Promise<LLMResponse> {
    const t0 = Date.now();
    const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0.5,
        max_tokens: 2048,
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${errText.slice(0, 150)}`);
    }

    const data: any = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? '';
    const tokens = data?.usage?.total_tokens;
    return {
      content,
      raw: data,
      durationMs: Date.now() - t0,
      tokens,
    };
  }

  async chat(messages: ChatMessage[], opts?: { thinking?: boolean }): Promise<LLMResponse> {
    const t0 = Date.now();
    try {
      return await llmCircuitBreaker.execute(async () => {
        const customProvider = getCustomProviderConfig();
        if (customProvider) {
          try {
            return await this.callProviderDirect(messages, customProvider);
          } catch (e: any) {
            logger.warn('Direct provider failed, falling back to ZAI SDK', { err: e?.message });
          }
        }

        try {
          const zai = await this.getZAI();
          const completion: any = await zai.chat.completions.create({
            messages,
            thinking: { type: opts?.thinking ? 'enabled' : 'disabled' },
          } as any);
          const content = completion?.choices?.[0]?.message?.content ?? '';
          const tokens = completion?.usage?.total_tokens;
          logger.debug('LLM chat completed', { durationMs: Date.now() - t0, tokens, contentLen: content.length });
          return {
            content,
            raw: completion,
            durationMs: Date.now() - t0,
            tokens,
          };
        } catch (e) {
          const cerr = classifyError(e, 'llm');
          logger.error('LLM chat failed', { err: cerr.message, code: cerr.code });
          if (cerr.code === ErrorCode.RATE_LIMIT || cerr.code === ErrorCode.TEMPORARY_FAILURE || cerr.code === ErrorCode.TIMEOUT) {
            await sleep(cerr.retryAfterMs ?? 1500);
            const zai = await this.getZAI();
            const completion: any = await zai.chat.completions.create({
              messages,
              thinking: { type: opts?.thinking ? 'enabled' : 'disabled' },
            } as any);
            const content = completion?.choices?.[0]?.message?.content ?? '';
            return { content, raw: completion, durationMs: Date.now() - t0, tokens: completion?.usage?.total_tokens };
          }
          throw new Error(`LLM unavailable: ${cerr.message}`);
        }
      });
    } catch (e) {
      if (e instanceof CircuitBreakerError) {
        logger.warn('LLM circuit open — fail-fast', { breaker: e.breakerName, state: llmCircuitBreaker.status });
        throw new Error(`LLM unavailable: circuit_breaker_open (state=${llmCircuitBreaker.status})`);
      }
      throw e;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
