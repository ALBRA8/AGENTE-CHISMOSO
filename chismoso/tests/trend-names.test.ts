import { describe, it, expect } from 'vitest';
import { clusterSignals } from '../src/intelligence/clustering.js';
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
    geography: 'global',
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

describe('RONDA-3 Point 1 — trend name quality', () => {
  it('no trend name ends in -N (numeric suffix)', () => {
    const sigs = [
      mkSignal('restaurant automation WhatsApp Colombia'),
      mkSignal('restaurant booking automation WhatsApp'),
      mkSignal('automated reservations for restaurants via WhatsApp'),
      mkSignal('POS systems for small restaurants in Bogota'),
      mkSignal('kitchen display software for restaurants'),
      mkSignal('food delivery automation trends Colombia'),
    ];
    const { clusters } = clusterSignals(sigs);
    for (const c of clusters) {
      expect(c.canonical).not.toMatch(/-\d+$/);
    }
  });

  it('every trend name has at least 2 meaningful words', () => {
    const sigs = [
      mkSignal('restaurant automation WhatsApp Colombia reserva'),
      mkSignal('automatizacion de pedidos en restaurantes pequenos'),
      mkSignal('sistema de reservas por WhatsApp para comida'),
      mkSignal('POS cloud para restaurantes en Bogota'),
      mkSignal('software de cocina para restaurantes medianos'),
    ];
    const { clusters } = clusterSignals(sigs);
    for (const c of clusters) {
      const words = c.canonical.split(/\s+/).filter(w => w.length >= 3);
      expect(words.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('merges near-duplicate clusters instead of creating -2 suffixes', () => {
    // Two clusters that would normally get the same canonical "restaurantes"
    const sigs = [
      mkSignal('restaurantes bogota reservas whatsapp'),
      mkSignal('restaurantes bogota reservas whatsapp automatizado'),
      mkSignal('restaurantes bogota pedidos'),
      mkSignal('restaurantes bogota pedidos automaticos'),
    ];
    const { clusters } = clusterSignals(sigs);
    // Should merge into 1 cluster, not 2 with "-2" suffix
    const canonicals = clusters.map(c => c.canonical.toLowerCase());
    for (const name of canonicals) {
      expect(name).not.toMatch(/-\d+$/);
    }
    // No two clusters should have the exact same name
    const unique = new Set(canonicals);
    expect(unique.size).toBe(canonicals.length);
  });
});
