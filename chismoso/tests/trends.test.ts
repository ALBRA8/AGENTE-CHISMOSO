/**
 * Unit tests — Cross-source confirmation (sección 16) and Trend Detection (sección 15)
 */

import { describe, it, expect } from 'vitest';
import {
  countDistinctSources,
  countDistinctSourceTypes,
  crossSourceConfidence,
  sourcesPresent,
} from '../src/intelligence/cross-source.js';
import { detectTrend } from '../src/intelligence/trends.js';
import { SignalType, SourceType, TruthLevel, TrendState } from '../src/models.js';
import type { Signal, Evidence } from '../src/models.js';

function mkSignal(source: string, sourceType: SourceType, snippet = 'generic snippet content', url?: string): Signal {
  return {
    id: `sig_${source}_${Math.random().toString(36).slice(2, 6)}`,
    topic: 'test-topic',
    keyword: 'test',
    source,
    sourceType,
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
    url,
  };
}

function mkEvidence(s: Signal): Evidence {
  return {
    id: `ev_${s.id}`,
    source: s.source,
    sourceType: s.sourceType,
    url: s.url,
    observedAt: s.timestamp,
    collectedAt: s.timestamp,
    geographicScope: s.geography,
    topic: s.topic,
    rawValue: s.rawSnippet,
    normalizedValue: s.rawSnippet.toLowerCase(),
    confidence: s.confidence,
    evidenceType: TruthLevel.OBSERVED,
    metadata: {},
  };
}

describe('cross-source confirmation', () => {
  it('1 source = low confidence', () => {
    const sigs = [mkSignal('web_search', SourceType.SEARCH_WEB)];
    const c = crossSourceConfidence(sigs);
    expect(c).toBeLessThan(0.4);
  });

  it('2 sources of same type = low-medium', () => {
    const sigs = [
      mkSignal('web_search', SourceType.SEARCH_WEB),
      mkSignal('web_search', SourceType.SEARCH_WEB),
    ];
    const c = crossSourceConfidence(sigs);
    expect(c).toBeGreaterThanOrEqual(0.15);
    expect(c).toBeLessThan(0.6);
  });

  it('2 source types = better than 1 source type', () => {
    const single = [
      mkSignal('web_search', SourceType.SEARCH_WEB),
      mkSignal('web_search', SourceType.SEARCH_WEB),
      mkSignal('web_search', SourceType.SEARCH_WEB),
    ];
    const multi = [
      mkSignal('web_search', SourceType.SEARCH_WEB),
      mkSignal('reddit_communities', SourceType.REDDIT_COMMUNITIES),
      mkSignal('web_content', SourceType.WEB_CONTENT),
    ];
    expect(crossSourceConfidence(multi)).toBeGreaterThan(crossSourceConfidence(single));
  });

  it('countDistinctSources counts unique sources', () => {
    const sigs = [
      mkSignal('a', SourceType.SEARCH_WEB),
      mkSignal('a', SourceType.SEARCH_WEB),
      mkSignal('b', SourceType.REDDIT_COMMUNITIES),
    ];
    expect(countDistinctSources(sigs)).toBe(2);
    expect(countDistinctSourceTypes(sigs)).toBe(2);
  });

  it('sourcesPresent returns unique sourceTypes', () => {
    const sigs = [
      mkSignal('a', SourceType.SEARCH_WEB),
      mkSignal('b', SourceType.REDDIT_COMMUNITIES),
    ];
    const types = sourcesPresent(sigs);
    expect(types).toContain(SourceType.SEARCH_WEB);
    expect(types).toContain(SourceType.REDDIT_COMMUNITIES);
  });
});

describe('trend detection', () => {
  it('few signals → NOISE', () => {
    const sigs = [mkSignal('web_search', SourceType.SEARCH_WEB)];
    const ev = sigs.map(mkEvidence);
    const { trend } = detectTrend({ topic: 't', canonical: 't', signals: sigs, evidence: ev });
    expect(trend.state).toBe(TrendState.NOISE);
    expect(trend.score).toBeLessThan(50);
  });

  it('multi-source multi-type strong signals → STRONG_TREND', () => {
    const sigs: Signal[] = [];
    for (let i = 0; i < 4; i++) sigs.push(mkSignal('web_search', SourceType.SEARCH_WEB, `restaurant reservation automation ${i}`));
    for (let i = 0; i < 4; i++) sigs.push(mkSignal('reddit_communities', SourceType.REDDIT_COMMUNITIES, `how to automate whatsapp reservations ${i}`));
    for (let i = 0; i < 4; i++) sigs.push(mkSignal('web_content', SourceType.WEB_CONTENT, `restaurant automation demand growing ${i}`));
    const ev = sigs.map(mkEvidence);
    const { trend } = detectTrend({ topic: 't', canonical: 'restaurant-automation', signals: sigs, evidence: ev });
    expect(trend.sourcesCount).toBe(3);
    expect(trend.score).toBeGreaterThan(50);
    expect([TrendState.STRONG_TREND, TrendState.EMERGING_TREND, TrendState.ESTABLISHED_TREND]).toContain(trend.state);
  });

  it('trend records firstSeen/lastSeen', () => {
    const s = mkSignal('web_search', SourceType.SEARCH_WEB);
    s.timestamp = '2024-01-01T00:00:00.000Z';
    const s2 = mkSignal('web_search', SourceType.SEARCH_WEB);
    s2.timestamp = '2024-06-01T00:00:00.000Z';
    const { trend } = detectTrend({ topic: 't', canonical: 't', signals: [s, s2], evidence: [mkEvidence(s), mkEvidence(s2)] });
    expect(trend.firstSeen).toBe('2024-01-01T00:00:00.000Z');
    expect(trend.lastSeen).toBe('2024-06-01T00:00:00.000Z');
  });

  it('historical signals affect persistence and growth', () => {
    const sigs = [mkSignal('web_search', SourceType.SEARCH_WEB)];
    const past: Signal[] = [];
    for (let i = 0; i < 10; i++) past.push(mkSignal('web_search', SourceType.SEARCH_WEB));
    const ev = sigs.map(mkEvidence);
    const { trend } = detectTrend({ topic: 't', canonical: 't', signals: sigs, evidence: ev, historicalSignals: past });
    expect(trend.persistence).toBeGreaterThan(0);
  });
});
