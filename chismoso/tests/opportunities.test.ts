/**
 * Unit tests — Problem Detection (sección 19) and Opportunity Engine (sección 20-22)
 */

import { describe, it, expect } from 'vitest';
import { detectProblem } from '../src/intelligence/problems.js';
import { generateOpportunity } from '../src/intelligence/opportunities.js';
import { SignalType, SourceType, TruthLevel } from '../src/models.js';
import type { Signal, Evidence } from '../src/models.js';
import { detectTrend } from '../src/intelligence/trends.js';

function mkSignal(source: string, sourceType: SourceType, snippet: string, url?: string): Signal {
  return {
    id: `sig_${Math.random().toString(36).slice(2, 8)}`,
    topic: 'restaurant-automation',
    keyword: 'whatsapp',
    source,
    sourceType,
    timestamp: new Date().toISOString(),
    geography: 'Colombia',
    metric: 'mention_count',
    value: 1,
    normalizedValue: 1,
    direction: 'up',
    velocity: 0,
    confidence: 0.6,
    evidenceType: TruthLevel.OBSERVED,
    signalType: SignalType.COMPLAINT_SPIKE,
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

describe('problem detection', () => {
  it('returns null when signals < 2 friction matches', () => {
    const sigs = [mkSignal('reddit', SourceType.REDDIT_COMMUNITIES, 'I love restaurant automation')];
    const ev = sigs.map(mkEvidence);
    const r = detectProblem({ topic: 't', canonical: 't', signals: sigs, evidence: ev });
    expect(r.problem).toBeNull();
  });

  it('detects problem when 2+ distinct friction signals exist', () => {
    const sigs = [
      mkSignal('reddit', SourceType.REDDIT_COMMUNITIES, 'I hate confirming reservations manually by WhatsApp'),
      mkSignal('reddit', SourceType.REDDIT_COMMUNITIES, 'How do I automate my restaurant WhatsApp bookings? It is so tedious.'),
      mkSignal('reddit', SourceType.REDDIT_COMMUNITIES, 'This is a broken workflow, I lost two reservations last week'),
    ];
    const ev = sigs.map(mkEvidence);
    const r = detectProblem({ topic: 'restaurant-automation', canonical: 'restaurant-automation', signals: sigs, evidence: ev });
    expect(r.problem).not.toBeNull();
    expect(r.problem!.severity).toBeGreaterThan(0);
    expect(r.problem!.frequency).toBeGreaterThan(0);
    expect(r.problem!.confidence).toBeGreaterThan(0.3);
  });

  it('rejects duplicate friction snippets as a single observation', () => {
    const dup = 'I hate confirming reservations manually by WhatsApp, broken';
    const sigs = [
      mkSignal('reddit', SourceType.REDDIT_COMMUNITIES, dup),
      mkSignal('reddit', SourceType.REDDIT_COMMUNITIES, dup),
      mkSignal('reddit', SourceType.REDDIT_COMMUNITIES, dup),
    ];
    const ev = sigs.map(mkEvidence);
    const r = detectProblem({ topic: 't', canonical: 't', signals: sigs, evidence: ev });
    expect(r.problem).toBeNull();
  });
});

describe('opportunity engine', () => {
  it('generates an opportunity with a transparent score breakdown', () => {
    const sigs = [
      mkSignal('reddit', SourceType.REDDIT_COMMUNITIES, 'I hate confirming reservations manually by WhatsApp'),
      mkSignal('reddit', SourceType.REDDIT_COMMUNITIES, 'How do I automate my restaurant WhatsApp bookings? It is so tedious.'),
      mkSignal('reddit', SourceType.REDDIT_COMMUNITIES, 'This is a broken workflow, I lost two reservations last week'),
      mkSignal('web_search', SourceType.SEARCH_WEB, 'Restaurant automation demand growing in Colombia'),
      mkSignal('web_search', SourceType.SEARCH_WEB, 'WhatsApp booking automation pricing plan'),
    ];
    const ev = sigs.map(mkEvidence);
    const { trend } = detectTrend({ topic: 'restaurant-automation', canonical: 'restaurant-automation', signals: sigs, evidence: ev });
    const { problem } = detectProblem({ topic: 'restaurant-automation', canonical: 'restaurant-automation', signals: sigs, evidence: ev });
    expect(problem).not.toBeNull();

    const { opportunity, weak } = generateOpportunity({
      trend,
      problem: problem!,
      signals: sigs,
      evidence: ev,
      geography: 'Colombia',
    });

    expect(opportunity.title).toBeTruthy();
    expect(opportunity.score).toBeGreaterThanOrEqual(0);
    expect(opportunity.score).toBeLessThanOrEqual(100);
    expect(opportunity.scoreBreakdown).toHaveProperty('demand');
    expect(opportunity.scoreBreakdown).toHaveProperty('competition');
    expect(opportunity.scoreBreakdown).toHaveProperty('uncertainty');
    expect(opportunity.suggestedNextAgent).toBe('AGENTE-LEADS');
    expect(typeof weak).toBe('boolean');
  });

  it('requires at least one of trend or problem', () => {
    const sigs = [mkSignal('web_search', SourceType.SEARCH_WEB, 'generic')];
    const ev = sigs.map(mkEvidence);
    expect(() => generateOpportunity({ signals: sigs, evidence: ev, geography: 'x' })).toThrow();
  });
});
