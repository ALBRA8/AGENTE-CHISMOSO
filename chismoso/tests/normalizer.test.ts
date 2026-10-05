/**
 * Unit tests — Normalizer (sección 13)
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeText,
  tokenize,
  extractKeyword,
  inferSignalType,
  normalizeRawItem,
  dedupSignals,
  rawConfidence,
} from '../src/intelligence/normalizer.js';
import { SignalType, SourceType, TruthLevel } from '../src/models.js';
import type { RawItem } from '../src/providers/base.js';

describe('normalizer', () => {
  it('normalizeText lowercases, strips accents and punctuation', () => {
    expect(normalizeText('Cafés Restaurantes! ¿Hola?')).toBe('cafes restaurantes hola');
  });

  it('tokenize removes stopwords in ES and EN', () => {
    const t = tokenize('Cómo automatizar las reservas en un restaurante pequeño');
    expect(t).not.toContain('como');
    expect(t).not.toContain('las');
    expect(t).not.toContain('en');
    expect(t).not.toContain('un');
    expect(t.some((w) => w === 'automatizar')).toBe(true);
    expect(t.some((w) => w === 'restaurante')).toBe(true);
  });

  it('extractKeyword returns the most frequent non-stopword', () => {
    // booking appears 3 times, restaurant 2 — booking should win.
    expect(extractKeyword('restaurant booking booking booking restaurant')).toBe('booking');
  });

  it('inferSignalType classifies reddit complaints', () => {
    expect(inferSignalType("I hate that I have to manually confirm every reservation by WhatsApp, it's broken", SourceType.REDDIT_COMMUNITIES)).toBe(SignalType.COMPLAINT_SPIKE);
    expect(inferSignalType('How do I automate restaurant reservations on WhatsApp?', SourceType.REDDIT_COMMUNITIES)).toBe(SignalType.QUESTION_SPIKE);
    expect(inferSignalType('We just launched a new restaurant booking tool', SourceType.WEB_CONTENT)).toBe(SignalType.NEW_PRODUCT);
    expect(inferSignalType('The demand for restaurant automation is growing', SourceType.SEARCH_WEB)).toBe(SignalType.DEMAND_SIGNAL);
  });

  it('normalizeRawItem produces a Signal and an Evidence with consistent topic', () => {
    const item: RawItem = {
      providerName: 'web_search',
      sourceType: SourceType.SEARCH_WEB,
      title: 'Test',
      snippet: 'Restaurant reservation automation demand growing in Colombia 2024',
      url: 'https://example.com/article',
      hostName: 'example.com',
      date: '2024-08-01',
    };
    const { signal, evidence } = normalizeRawItem(item, { topic: 'restaurant-automation', geography: 'Colombia' });
    expect(signal.topic).toBe('restaurant-automation');
    expect(evidence.topic).toBe('restaurant-automation');
    expect(signal.sourceType).toBe(SourceType.SEARCH_WEB);
    expect(signal.evidenceType).toBe(TruthLevel.OBSERVED);
    expect(signal.url).toBe('https://example.com/article');
    expect(evidence.url).toBe('https://example.com/article');
    expect(signal.id).toMatch(/^sig_/);
    expect(evidence.id).toMatch(/^ev_/);
  });

  it('rawConfidence boosts URLs and longer snippets', () => {
    const withUrl: RawItem = {
      providerName: 'web_search',
      sourceType: SourceType.SEARCH_WEB,
      snippet: 'x'.repeat(120),
      url: 'https://example.com',
      title: 'title here',
      date: '2024',
    };
    const withoutUrl: RawItem = {
      providerName: 'web_search',
      sourceType: SourceType.SEARCH_WEB,
      snippet: 'short',
    };
    expect(rawConfidence(withUrl)).toBeGreaterThan(rawConfidence(withoutUrl));
  });

  it('dedupSignals removes URL duplicates keeping first', () => {
    const mk = (url: string, snippet: string) => ({
      id: url + snippet,
      topic: 't',
      keyword: 'k',
      source: 'web_search',
      sourceType: SourceType.SEARCH_WEB,
      timestamp: '2024-01-01',
      geography: 'global',
      metric: 'm',
      value: 1,
      normalizedValue: 1,
      direction: 'up' as const,
      velocity: 0,
      confidence: 0.5,
      evidenceType: TruthLevel.OBSERVED,
      signalType: SignalType.MENTION_SPIKE,
      metadata: {},
      rawSnippet: snippet,
      url,
    });
    const sigs = [mk('https://a.com/1', 'aaa'), mk('https://a.com/1', 'aaa dup'), mk('https://b.com/2', 'bbb')];
    const out = dedupSignals(sigs);
    expect(out.length).toBe(2);
  });
});
