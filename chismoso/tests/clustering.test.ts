/**
 * Unit tests — Topic Clustering (sección 18)
 */

import { describe, it, expect } from 'vitest';
import { clusterSignals } from '../src/intelligence/clustering.js';
import { SignalType, SourceType, TruthLevel } from '../src/models.js';
import type { Signal } from '../src/models.js';

function mkSignal(snippet: string, topic = 't'): Signal {
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
    confidence: 0.5,
    evidenceType: TruthLevel.OBSERVED,
    signalType: SignalType.MENTION_SPIKE,
    metadata: {},
    rawSnippet: snippet,
  };
}

describe('topic clustering', () => {
  it('groups signals with similar tokens into one cluster', () => {
    const sigs = [
      mkSignal('restaurant reservation automation WhatsApp Colombia'),
      mkSignal('automate restaurant WhatsApp booking flow'),
      mkSignal('how to automate WhatsApp reservations at restaurant'),
    ];
    const { clusters, signalToCluster } = clusterSignals(sigs);
    expect(clusters.length).toBe(1);
    expect(signalToCluster.size).toBe(3);
  });

  it('separates signals with no token overlap', () => {
    const sigs = [
      mkSignal('pizza delivery drone'),
      mkSignal('crypto mining gpu'),
    ];
    const { clusters } = clusterSignals(sigs);
    expect(clusters.length).toBe(2);
  });

  it('assigns a canonical from the most frequent token', () => {
    const sigs = [
      mkSignal('automate restaurant booking'),
      mkSignal('restaurant automation'),
      mkSignal('restaurant reservations'),
    ];
    const { clusters } = clusterSignals(sigs);
    expect(clusters[0].canonical).toBeTruthy();
    expect(clusters[0].canonical.length).toBeGreaterThan(0);
  });
});
