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
 */

import ZAI from 'z-ai-web-dev-sdk';
import { logger } from '../logger.js';
import { classifyError, ErrorCode } from '../errors.js';

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

export class LLMClient {
  private zaiPromise: Promise<ZAI> | null = null;

  private async getZAI(): Promise<ZAI> {
    if (!this.zaiPromise) this.zaiPromise = ZAI.create();
    return this.zaiPromise;
  }

  async chat(messages: ChatMessage[], opts?: { thinking?: boolean }): Promise<LLMResponse> {
    const t0 = Date.now();
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
        // un intento de retry simple para LLM
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
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
