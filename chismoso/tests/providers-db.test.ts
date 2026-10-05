/**
 * Unit tests — Provider abstraction + DB persistence (integration)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChismosoDB } from '../src/db.js';
import { Repositories } from '../src/repositories.js';
import { GoogleTrendsProvider } from '../src/providers/google-trends.js';
import { ProviderHealth, SignalType, SourceType, TruthLevel } from '../src/models.js';
import { ErrorCode } from '../src/errors.js';

describe('GoogleTrendsProvider (UNAVAILABLE)', () => {
  it('reports UNAVAILABLE in capabilities', () => {
    const p = new GoogleTrendsProvider();
    expect(p.capabilities().status).toBe(ProviderHealth.UNAVAILABLE);
  });

  it('health() returns UNAVAILABLE', async () => {
    const p = new GoogleTrendsProvider();
    expect(await p.health()).toBe(ProviderHealth.UNAVAILABLE);
  });

  it('search() returns empty items with PROVIDER_UNAVAILABLE — does NOT simulate', async () => {
    const p = new GoogleTrendsProvider();
    const r = await p.search({ query: 'anything' });
    expect(r.items.length).toBe(0);
    expect(r.errorCode).toBe(ErrorCode.PROVIDER_UNAVAILABLE);
    expect(r.error).toMatch(/UNAVAILABLE/);
  });
});

describe('DB persistence', () => {
  let db: ChismosoDB;
  let repos: Repositories;

  beforeEach(() => {
    db = new ChismosoDB({ path: ':memory:' });
    repos = new Repositories(db);
  });

  afterEach(() => {
    db.close();
  });

  it('persists signals and reads them back by investigation', () => {
    const sig: any = {
      id: 'sig_test1',
      topic: 'test-topic',
      keyword: 'whatsapp',
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
      metadata: { foo: 'bar' },
      rawSnippet: 'test snippet',
      url: 'https://example.com/test',
    };
    repos.signals.insert(sig, 'inv_1');
    const out = repos.signals.findByInvestigation('inv_1');
    expect(out.length).toBe(1);
    expect(out[0].id).toBe('sig_test1');
    expect(out[0].topic).toBe('test-topic');
    expect(out[0].metadata).toEqual({ foo: 'bar' });
  });

  it('topic observation history grows', () => {
    repos.topics.recordObservation('t', 2, 5, 3, 0.6, 'EMERGING_TREND');
    repos.topics.recordObservation('t', 3, 8, 6, 0.75, 'STRONG_TREND');
    const h = repos.topics.getHistory('t');
    expect(h.length).toBe(2);
    expect(h[0].confidence).toBe(0.75);
  });

  it('inserts and reads an investigation', () => {
    const inv = {
      id: 'inv_test',
      query: 'test',
      scope: 'global',
      startedAt: new Date().toISOString(),
      status: 'COMPLETED' as const,
      providersUsed: ['web_search'],
      queriesExecuted: ['web_search: test'],
      signalsFound: 1,
      evidenceFound: 1,
      trendsFound: 0,
      problemsFound: 0,
      opportunitiesFound: 0,
      errors: [],
      iterations: 1,
      budget: { maxIterations: 1, maxQueries: 1, maxSources: 5, maxResults: 30, maxRuntimeMs: 60000, maxProviderCalls: 5 },
      providerRuns: [],
    };
    repos.investigations.insert(inv);
    const r = repos.investigations.get('inv_test');
    expect(r).not.toBeNull();
    expect(r!.query).toBe('test');
    expect(r!.status).toBe('COMPLETED');
  });
});
