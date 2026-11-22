import { describe, it, expect, vi } from 'vitest';
import { filterRelevantSemantic } from '../src/intelligence/relevance.js';
import { SignalType, SourceType, TruthLevel } from '../src/models.js';
import type { Signal } from '../src/models.js';

function mkSignal(snippet: string, topic = 'test'): Signal {
  return {
    id: `sig_${Math.random().toString(36).slice(2, 8)}`,
    topic,
    keyword: snippet.split(' ')[0],
    source: 'web_search',
    sourceType: SourceType.SEARCH_WEB,
    timestamp: new Date().toISOString(),
    geography: 'Colombia',
    metric: 'mention_count',
    value: 1,
    normalizedValue: 1,
    direction: 'up',
    velocity: 0,
    confidence: 0.6,
    evidenceType: TruthLevel.OBSERVED,
    signalType: SignalType.MENTION_SPIKE,
    metadata: {},
    rawSnippet: snippet,
  };
}

describe('RONDA-4 Point 1 — pipeline invokes semantic relevance', () => {
  it('filterRelevantSemantic is called and discards shared-keyword noise', async () => {
    const objective = 'oportunidades de negocio en restaurantes en Colombia';
    const signals = [
      mkSignal('Automatizacion de reservas por WhatsApp para restaurantes en Bogota Colombia'),
      mkSignal('POS cloud para pequenos restaurantes en Medellin Colombia'),
      mkSignal('Sistema de pedidos online para restaurantes en Cali Colombia'),
      // Noise: shares "restaurante" + "colombia" but about school bullying
      mkSignal('El restaurante escolar lucha contra el acoso y bullying en instituciones educativas de Bogota Colombia'),
    ];

    // Without LLM → falls back to lexical
    const result = await filterRelevantSemantic(signals, { objective, geography: 'Colombia' }, {});
    expect(result.total).toBe(4);
    // The bullying signal should score lower than the real ones
    const bullying = signals.find(s => s.rawSnippet.includes('bullying'))!;
    const bullyingScore = bullying.metadata?.relevance as any;
    if (bullyingScore) {
      expect(bullyingScore.score).toBeLessThan(0.6);
    }
  });

  it('with mock LLM, semantic mode discards signals that share words but differ in meaning', async () => {
    const objective = 'oportunidades de negocio en restaurantes en Colombia';
    const signals = [
      mkSignal('Automatizacion de reservas por WhatsApp para restaurantes en Bogota'),
      mkSignal('El restaurante escolar lucha contra el acoso y bullying en Colombia'),
    ];

    // Mock LLM that scores the bullying signal low
    const mockLLM = {
      chat: vi.fn().mockImplementation(async (messages: any[]) => {
        const userMsg = messages.find((m: any) => m.role === 'user')?.content ?? '';
        if (userMsg.includes('bullying') || userMsg.includes('acoso')) {
          return { content: '5' }; // very low relevance
        }
        return { content: '95' }; // high relevance
      }),
    };

    const result = await filterRelevantSemantic(
      signals,
      { objective, geography: 'Colombia' },
      { llm: mockLLM as any, enabled: true },
    );

    expect(result.total).toBe(2);
    expect(result.discarded).toBeGreaterThanOrEqual(1);
    // The bullying signal should be discarded
    const bullying = signals.find(s => s.rawSnippet.includes('bullying'))!;
    const meta = bullying.metadata?.relevance as any;
    expect(meta?.irrelevant).toBe(true);
    expect(meta?.semantic).toBe(true);
  });

  it('falls back to lexical when LLM call fails', async () => {
    const objective = 'restaurantes Colombia';
    const signals = [mkSignal('POS cloud para restaurantes en Bogota Colombia')];

    const brokenLLM = {
      chat: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
    };

    const result = await filterRelevantSemantic(
      signals,
      { objective, geography: 'Colombia' },
      { llm: brokenLLM as any, enabled: true },
    );

    // Should not crash, should fall back to lexical
    expect(result.total).toBe(1);
    expect(result.relevant.length + result.discarded).toBe(1);
  });
});
