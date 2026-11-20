/**
 * RONDA-2 Point 4 — Relevance noise-filter tests
 *
 * Loads `tests/fixtures/noise-signals.json` (3 deliberately irrelevant
 * signals) and asserts the §3.1 relevance scorer either filters them out
 * or applies a measurable penalty:
 *
 *   1. Off-topic article (school bullying for a restaurants-Colombia query)
 *      → MUST be filtered out (irrelevant=true, score below threshold).
 *
 *   2. Stale 2019-dated note about restaurants in Colombia
 *      → MUST receive a decay penalty (score strictly lower than the same
 *        signal with a fresh 2025 observedAt). It MAY still pass the
 *        threshold because lexical overlap is high; what we assert is the
 *        penalty delta, not the binary verdict.
 *
 *   3. US-based (.com, US market) article about restaurant POS
 *      → MUST receive ZERO Colombia geography boost (score strictly lower
 *        than the same signal hosted on a Colombian `.co` domain). The
 *        relevance scorer gives a +0.15 / +0.05 boost for local domains;
 *        a US .com domain receives neither.
 *
 * Together these prove the relevance scorer is doing real work — without
 * these assertions, an "irrelevant" regression that lets everything pass
 * would be invisible.
 *
 * Why we build Signal objects directly (instead of using normalizeRawItem):
 * the normalizer sets `signal.topic = ctx.topic`, and in production ctx.topic
 * is the query string derived from the objective. The relevance scorer
 * includes `signal.topic` in the scored text, so a topic that overlaps with
 * the objective would inflate every signal's score (this is why the eval
 * fixtures show 100% relevance — they were tagged with topic=objective).
 *
 * For these noise tests we want to validate the scorer's behavior on the
 * SNIPPET alone, so we set `topic` to a neutral string and let the snippet
 * drive the score. This is the cleanest way to assert "the scorer correctly
 * rejects an off-topic snippet even when no topic hint is present."
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyRelevance,
  filterRelevant,
  scoreRelevance,
  DEFAULT_RELEVANCE_THRESHOLD,
} from '../src/intelligence/relevance.js';
import { SignalType, SourceType, TruthLevel } from '../src/models.js';
import type { Signal } from '../src/models.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OBJECTIVE = 'Oportunidades de negocio en restaurantes en Colombia';
const GEOGRAPHY = 'Colombia';
const NEUTRAL_TOPIC = 'noise-fixture-signal';

interface FixtureItem {
  title: string;
  link: string;
  snippet: string;
  date: string;
  position: number;
}

function loadNoiseFixture(): FixtureItem[] {
  const fixturePath = path.resolve(__dirname, 'fixtures', 'noise-signals.json');
  const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
  return (raw.organic ?? []) as FixtureItem[];
}

function mkSignal(item: FixtureItem, observedAtOverride?: string): Signal {
  return {
    id: `sig_noise_${Math.random().toString(36).slice(2, 8)}`,
    // Neutral topic — does NOT overlap with the objective tokens. We want
    // the relevance scorer to be driven by the snippet content alone.
    topic: NEUTRAL_TOPIC,
    keyword: item.title.split(' ')[0].toLowerCase(),
    source: 'web_search',
    sourceType: SourceType.SEARCH_WEB,
    timestamp: new Date().toISOString(),
    observedAt: observedAtOverride ?? `${item.date}T00:00:00.000Z`,
    geography: GEOGRAPHY,
    metric: 'mention_count',
    value: 1,
    normalizedValue: 1,
    direction: 'up',
    velocity: 0,
    confidence: 0.5,
    evidenceType: TruthLevel.OBSERVED,
    signalType: SignalType.MENTION_SPIKE,
    metadata: {},
    rawSnippet: `${item.title}. ${item.snippet}`,
    url: item.link,
  };
}

describe('RONDA-2 Point 4 — noise fixtures filtered / penalized by §3.1 relevance scorer', () => {
  it('loads 3 deliberately irrelevant signals', () => {
    const items = loadNoiseFixture();
    expect(items.length).toBe(3);
    const titles = items.map((i) => i.title);
    expect(titles).toEqual([
      'Bullying escolar: cómo prevenir el acoso en escuelas primarias',
      'Restaurantes en Colombia: crecimiento del sector 2019',
      'Best restaurant POS systems in the United States 2025',
    ]);
  });

  it('filters out the off-topic school-bullying signal', () => {
    const items = loadNoiseFixture();
    const bullying = items[0];
    const signal = mkSignal(bullying);
    const verdict = applyRelevance(signal, { objective: OBJECTIVE, geography: GEOGRAPHY });
    const meta = verdict.metadata?.relevance as { score: number; irrelevant: boolean };
    expect(meta.irrelevant).toBe(true);
    expect(meta.score).toBeLessThan(DEFAULT_RELEVANCE_THRESHOLD);
  });

  it('applies a decay penalty to the stale 2019 note vs a fresh 2025 equivalent', () => {
    const items = loadNoiseFixture();
    const stale = items[1];
    // Build the "fresh" equivalent: identical content but observedAt = today.
    const freshObservedAt = new Date().toISOString();
    const staleSignal = mkSignal(stale); // observedAt = 2019-03-10
    const freshSignal = mkSignal(stale, freshObservedAt);

    const staleScore = scoreRelevance(staleSignal, OBJECTIVE, GEOGRAPHY);
    const freshScore = scoreRelevance(freshSignal, OBJECTIVE, GEOGRAPHY);

    // The stale signal MUST score strictly lower than the fresh equivalent
    // (the decay penalty is what we're validating). The penalty ceiling is
    // 0.25, so the delta must be at least 0.05 and at most 0.25.
    expect(staleScore).toBeLessThan(freshScore);
    expect(freshScore - staleScore).toBeGreaterThanOrEqual(0.05);
    expect(freshScore - staleScore).toBeLessThanOrEqual(0.25);
  });

  it('applies NO Colombia geography boost to the US-based .com signal', () => {
    const items = loadNoiseFixture();
    const usItem = items[2];

    // Build the "local" equivalent: identical content but hosted on a
    // Colombian news domain (larepublica.co). The snippet is kept IDENTICAL
    // and the observedAt is set to TODAY for both (no decay) so the only
    // score difference comes from the geographyBoost (+0.15 for matching
    // a known Colombian domain + 0.05 for the `.co` TLD).
    const localItem: FixtureItem = {
      ...usItem,
      link: 'https://www.larepublica.co/tecnologia/pos-restaurantes-colombia-2025',
    };
    // Use today's date so decay=0 for both signals. We're isolating the
    // geographyBoost contribution; mixing in decay would muddy the delta.
    const todayIso = new Date().toISOString();
    const usSignal = mkSignal(usItem, todayIso);
    const localSignal = mkSignal(localItem, todayIso);

    const usScore = scoreRelevance(usSignal, OBJECTIVE, GEOGRAPHY);
    const localScore = scoreRelevance(localSignal, OBJECTIVE, GEOGRAPHY);

    // The local signal MUST score strictly higher because of the
    // geographyBoost (+0.15 for the matching Colombian domain +
    // +0.05 for the .co TLD). The lexical overlap is identical (same
    // snippet + same neutral topic), decay is 0 for both, so the
    // entire delta comes from the geography boost.
    expect(localScore).toBeGreaterThan(usScore);
    expect(localScore - usScore).toBeGreaterThanOrEqual(0.15);
  });

  it('filterRelevant discards the off-topic signal and reports the count', () => {
    const items = loadNoiseFixture();
    const signals = items.map((i) => mkSignal(i));
    const result = filterRelevant(signals, { objective: OBJECTIVE, geography: GEOGRAPHY });
    // At least the bullying signal is discarded; the stale and US-based
    // signals may or may not pass depending on their lexical overlap, but
    // the bullying signal (no restaurant tokens at all) is guaranteed to
    // be below threshold.
    expect(result.discarded).toBeGreaterThanOrEqual(1);
    expect(result.total).toBe(3);
    // Every kept signal has its verdict recorded in metadata.
    for (const s of result.relevant) {
      expect(s.metadata?.relevance).toBeDefined();
      expect((s.metadata?.relevance as { irrelevant?: boolean }).irrelevant).toBe(false);
    }
  });
});
