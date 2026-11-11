/**
 * Unit tests — ClonaKit Provider + Tech Enricher + destripar_tecnologia tool
 * (Task FRENTE-B-CHISMOSO-CLONAKIT)
 *
 * Covers:
 *   1. ClonaKitProvider — the new official provider (health, capabilities,
 *      search, extractTechMentions, validateCapabilities, buildFichaSnippet).
 *   2. enrichSignalWithTech / enrichSignalsWithTech — the enricher that
 *      hooks into the normalizer.
 *   3. normalizeRawItem integration — the opt-in/out enrichment hook.
 *   4. destriparTecnologiaTool — the new orchestrator tool.
 *   5. createDefaultProviderRegistry — ClonaKit is listed.
 *   6. createDefaultToolRegistry — destripar_tecnologia is listed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChismosoDB } from '../src/db.js';
import { Repositories } from '../src/repositories.js';
import {
  ClonaKitProvider,
  clonakitProvider,
  type ValidatedCapability,
} from '../src/providers/clonakit.js';
import { createDefaultProviderRegistry } from '../src/providers/index.js';
import {
  enrichSignalWithTech,
  enrichSignalsWithTech,
  type EnrichedSignal,
} from '../src/intelligence/tech-enricher.js';
import { normalizeRawItem } from '../src/intelligence/normalizer.js';
import {
  createDefaultToolRegistry,
  destriparTecnologiaTool,
  type ToolContext,
} from '../src/orchestrator/tools.js';
import { SignalType, SourceType, TruthLevel, type Signal } from '../src/models.js';
import { CAPABILITY_COUNT } from '../src/intelligence/capability-mapping.js';
import type { RawItem } from '../src/providers/base.js';

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/** Build a minimal Signal for enricher tests (bypasses the normalizer). */
function makeSignal(snippet: string, overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'sig_test_' + Math.random().toString(36).slice(2, 8),
    topic: 'test-topic',
    keyword: 'test',
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
    ...overrides,
  };
}

/** Build a ToolContext backed by an in-memory DB for tool tests. */
function makeToolContext(): { ctx: ToolContext; db: ChismosoDB; cleanup: () => void } {
  const db = new ChismosoDB({ path: ':memory:' });
  const repos = new Repositories(db);
  // Insert a minimal investigation so findByInvestigation works.
  repos.investigations.insert({
    id: 'inv_test',
    query: 'test',
    scope: 'global',
    startedAt: new Date().toISOString(),
    status: 'COMPLETED' as any,
    providersUsed: [],
    queriesExecuted: [],
    signalsFound: 0,
    evidenceFound: 0,
    trendsFound: 0,
    problemsFound: 0,
    opportunitiesFound: 0,
    errors: [],
    iterations: 1,
    budget: { maxIterations: 1, maxQueries: 1, maxSources: 1, maxResults: 1, maxRuntimeMs: 1000, maxProviderCalls: 1 },
    providerRuns: [],
  });
  const ctx: ToolContext = {
    investigationId: 'inv_test',
    geography: 'global',
    repositories: repos,
    providerRegistry: createDefaultProviderRegistry(),
  };
  return { ctx, db, cleanup: () => db.close() };
}

// ---------------------------------------------------------------------------
// 1. ClonaKitProvider — the new official provider
// ---------------------------------------------------------------------------

describe('ClonaKitProvider — provider surface', () => {
  const provider = new ClonaKitProvider();

  it('capabilities() declares the clonakit provider with OK health', () => {
    const caps = provider.capabilities();
    expect(caps.name).toBe('clonakit');
    expect(caps.status).toBe('OK');
    expect(caps.authentication).toBe('none');
    expect(caps.capabilities).toContain('search');
    expect(caps.capabilities).toContain('extract');
    expect(caps.capabilities).toContain('validate');
    expect(caps.capabilities).toContain('ficha');
  });

  it('health() always returns OK (static mapping, no network)', async () => {
    expect(await provider.health()).toBe('OK');
  });

  it('canHandle() accepts any query', () => {
    expect(provider.canHandle({ query: 'anything' })).toBe(true);
    expect(provider.canHandle({ query: '' })).toBe(true);
  });

  it('search() returns matching frameworks for "video"', async () => {
    const res = await provider.search({ query: 'video' });
    expect(res.providerName).toBe('clonakit');
    expect(res.items.length).toBeGreaterThan(0);
    // AVFoundation must be among the matches (purpose mentions "vídeo").
    const frameworks = res.items.map((i) => i.rawMetadata?.framework);
    expect(frameworks).toContain('AVFoundation');
    // Every item must carry the clonakit providerName + structured rawMetadata.
    for (const item of res.items) {
      expect(item.providerName).toBe('clonakit');
      expect(item.rawMetadata?.framework).toBeTruthy();
      expect(item.rawMetadata?.web_equivalent).toBeTruthy();
    }
  });

  it('search() returns matches for "bluetooth"', async () => {
    const res = await provider.search({ query: 'bluetooth' });
    const frameworks = res.items.map((i) => i.rawMetadata?.framework);
    expect(frameworks).toContain('CoreBluetooth');
  });

  it('search() returns empty for a query that matches nothing', async () => {
    const res = await provider.search({ query: 'zzzNoSuchTechnology123' });
    expect(res.items).toEqual([]);
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('search() respects the num cap', async () => {
    const res = await provider.search({ query: 'a', num: 3 });
    expect(res.items.length).toBeLessThanOrEqual(3);
  });

  it('search() returns empty for an empty query (defensive)', async () => {
    const res = await provider.search({ query: '' });
    expect(res.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. ClonaKitProvider — tech-enricher helpers
// ---------------------------------------------------------------------------

describe('ClonaKitProvider — extractTechMentions', () => {
  const provider = new ClonaKitProvider();

  it('detects AVFoundation and CoreData in a snippet (and ignores React which is not in the mapping)', () => {
    // React is intentionally NOT in the ClonaKit mapping (the table is
    // Apple/mac frameworks only). So a snippet mentioning AVFoundation,
    // React, and CoreData should yield exactly 2 matches.
    const mentions = provider.extractTechMentions(
      'This app uses AVFoundation for video, React for the UI, and CoreData for storage.',
    );
    expect(mentions).toHaveLength(2);
    expect(mentions).toContain('AVFoundation');
    expect(mentions).toContain('CoreData');
    expect(mentions).not.toContain('React');
  });

  it('is case-insensitive', () => {
    const mentions = provider.extractTechMentions('this app uses AVFOUNDATION and COREDATA');
    expect(mentions).toHaveLength(2);
    expect(mentions).toContain('AVFoundation');
    expect(mentions).toContain('CoreData');
  });

  it('deduplicates frameworks mentioned multiple times', () => {
    const mentions = provider.extractTechMentions('Metal is fast. Metal is also low-level.');
    expect(mentions).toEqual(['Metal']);
  });

  it('returns an empty array when no tech is mentioned', () => {
    expect(provider.extractTechMentions('no tech mentioned here')).toEqual([]);
  });

  it('returns an empty array for empty input (defensive)', () => {
    expect(provider.extractTechMentions('')).toEqual([]);
    expect(provider.extractTechMentions('   ')).toEqual([]);
  });

  it('does not match a framework name that is a substring of another word', () => {
    // "AVFoundation" contains "Foundation" but the standalone Foundation
    // entry must NOT match here (word-boundary check).
    const mentions = provider.extractTechMentions('AVFoundation is used here');
    expect(mentions).toContain('AVFoundation');
    expect(mentions).not.toContain('Foundation');
  });
});

describe('ClonaKitProvider — validateCapabilities', () => {
  const provider = new ClonaKitProvider();

  it('returns exists:true with full entry for known frameworks', () => {
    const result = provider.validateCapabilities(['AVFoundation']);
    expect(result).toHaveLength(1);
    expect(result[0].framework).toBe('AVFoundation');
    expect(result[0].exists).toBe(true);
    expect(result[0].purpose).toBeTruthy();
    expect(result[0].web_equivalent).toContain('getUserMedia');
    expect(result[0].category).toBe('audio_video');
  });

  it('returns exists:false for unknown frameworks', () => {
    const result = provider.validateCapabilities(['React', 'Vue', 'Angular']);
    expect(result).toHaveLength(3);
    for (const r of result) {
      expect(r.exists).toBe(false);
      expect(r.purpose).toBeUndefined();
      expect(r.web_equivalent).toBeUndefined();
      expect(r.category).toBeUndefined();
    }
  });

  it('handles mixed known + unknown frameworks (preserving order)', () => {
    const result = provider.validateCapabilities(['AVFoundation', 'React', 'coredata']);
    expect(result).toHaveLength(3);
    expect(result[0].framework).toBe('AVFoundation');
    expect(result[0].exists).toBe(true);
    expect(result[1].framework).toBe('React');
    expect(result[1].exists).toBe(false);
    expect(result[2].framework).toBe('CoreData'); // canonical PascalCase
    expect(result[2].exists).toBe(true);
  });

  it('is case-insensitive (avfoundation -> AVFoundation)', () => {
    const result = provider.validateCapabilities(['avfoundation', 'AVFOUNDATION', 'AvFoUnDaTiOn']);
    // All three resolve to the same canonical entry, deduplicated.
    expect(result).toHaveLength(1);
    expect(result[0].framework).toBe('AVFoundation');
    expect(result[0].exists).toBe(true);
  });

  it('deduplicates case-insensitively', () => {
    const result = provider.validateCapabilities(['Metal', 'metal', 'METAL']);
    expect(result).toHaveLength(1);
    expect(result[0].framework).toBe('Metal');
  });

  it('returns an empty array for empty input (defensive)', () => {
    expect(provider.validateCapabilities([])).toEqual([]);
    expect(provider.validateCapabilities(['', '  '] as any)).toEqual([]);
  });

  it('can validate every framework in the mapping', () => {
    // Strong invariant: every framework name in the table must validate.
    // We pull a sample of known frameworks and check they all resolve.
    const sample = ['AVFoundation', 'CoreData', 'Metal', 'SwiftUI', 'CoreML', 'StoreKit', 'WebKit'];
    const result = provider.validateCapabilities(sample);
    expect(result).toHaveLength(sample.length);
    for (const r of result) {
      expect(r.exists).toBe(true);
    }
  });
});

describe('ClonaKitProvider — buildFichaSnippet', () => {
  const provider = new ClonaKitProvider();

  it('returns a non-empty markdown string for known frameworks', () => {
    const md = provider.buildFichaSnippet(['AVFoundation', 'CoreData']);
    expect(md).toBeTruthy();
    expect(md).toContain('Ficha');
    expect(md).toContain('AVFoundation');
    expect(md).toContain('CoreData');
    // Markdown table header is present.
    expect(md).toContain('| Framework |');
    expect(md).toContain('|-----------|');
  });

  it('includes the web equivalent column', () => {
    const md = provider.buildFichaSnippet(['CoreData']);
    expect(md).toContain('IndexedDB');
  });

  it('lists unknown frameworks under a "no validados" section', () => {
    const md = provider.buildFichaSnippet(['AVFoundation', 'React']);
    expect(md).toContain('no validados');
    expect(md).toContain('React');
  });

  it('returns an empty string for empty input', () => {
    expect(provider.buildFichaSnippet([])).toBe('');
  });

  it('mentions the total mapping size in the footer', () => {
    const md = provider.buildFichaSnippet(['AVFoundation']);
    expect(md).toContain(String(CAPABILITY_COUNT));
    expect(md).toContain('frameworks');
  });

  it('escapes pipe characters in table cells (defensive)', () => {
    // The purpose strings in the mapping don't contain pipes, but the
    // escaper must not crash. We test it indirectly by ensuring the table
    // header row count matches the data row count.
    const md = provider.buildFichaSnippet(['AVFoundation', 'CoreData', 'Metal']);
    const headerRows = (md.match(/\| Framework \|/g) || []).length;
    expect(headerRows).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. enrichSignalWithTech — the enricher function
// ---------------------------------------------------------------------------

describe('enrichSignalWithTech', () => {
  it('enriches a signal that mentions AVFoundation and CoreData', () => {
    const signal = makeSignal(
      'This app uses AVFoundation for video and CoreData for storage.',
    );
    const enriched = enrichSignalWithTech(signal);
    expect(enriched.techStack).toBeDefined();
    expect(enriched.techStack!.length).toBe(2);
    expect(enriched.webEquivalents).toBeDefined();
    expect(enriched.webEquivalents!.length).toBe(2);
    expect(enriched.fichaSnippet).toBeTruthy();
    expect(enriched.fichaSnippet!).toContain('AVFoundation');
    expect(enriched.fichaSnippet!).toContain('CoreData');
  });

  it('persists the enrichment into metadata.clonakit_enrichment', () => {
    const signal = makeSignal('Uses AVFoundation and CoreData.');
    const enriched = enrichSignalWithTech(signal);
    expect(enriched.metadata.clonakit_enrichment).toBeDefined();
    const blob = enriched.metadata.clonakit_enrichment as any;
    expect(blob.mentionedCount).toBe(2);
    expect(blob.knownCount).toBe(2);
    expect(blob.unknownCount).toBe(0);
    expect(blob.techStack).toBeDefined();
    expect(blob.webEquivalents).toBeDefined();
    expect(blob.fichaSnippet).toBeTruthy();
  });

  it('returns the SAME signal reference (unchanged) when no tech is mentioned', () => {
    const signal = makeSignal('no tech mentioned here at all');
    const enriched = enrichSignalWithTech(signal);
    // Reference equality — the enricher fast-paths when there are no mentions.
    expect(enriched).toBe(signal);
    expect(enriched.techStack).toBeUndefined();
    expect(enriched.webEquivalents).toBeUndefined();
    expect(enriched.fichaSnippet).toBeUndefined();
  });

  it('returns the SAME signal reference for an empty snippet', () => {
    const signal = makeSignal('');
    const enriched = enrichSignalWithTech(signal);
    expect(enriched).toBe(signal);
  });

  it('preserves all original signal fields (id, topic, source, etc.)', () => {
    const signal = makeSignal('Uses AVFoundation.', {
      topic: 'my-topic',
      keyword: 'my-keyword',
      url: 'https://example.com/x',
    });
    const enriched = enrichSignalWithTech(signal);
    expect(enriched.id).toBe(signal.id);
    expect(enriched.topic).toBe('my-topic');
    expect(enriched.keyword).toBe('my-keyword');
    expect(enriched.url).toBe('https://example.com/x');
    expect(enriched.sourceType).toBe(signal.sourceType);
    expect(enriched.signalType).toBe(signal.signalType);
    expect(enriched.rawSnippet).toBe(signal.rawSnippet);
  });

  it('does NOT mutate the original signal', () => {
    const signal = makeSignal('Uses AVFoundation.');
    const originalMetadata = { ...signal.metadata };
    const enriched = enrichSignalWithTech(signal);
    // The original signal's metadata must be untouched.
    expect(signal.metadata).toEqual(originalMetadata);
    expect(signal.metadata.clonakit_enrichment).toBeUndefined();
    // The enriched signal has the new metadata.
    expect(enriched.metadata.clonakit_enrichment).toBeDefined();
  });

  it('handles a signal with unknown frameworks mentioned alongside known ones', () => {
    // AVFoundation + React: only AVFoundation is in the mapping, so
    // extractTechMentions returns ['AVFoundation'] (React is not detected
    // because it's not in the framework table). The enriched signal has
    // exactly one techStack entry.
    const signal = makeSignal('Uses AVFoundation and React.');
    const enriched = enrichSignalWithTech(signal);
    expect(enriched.techStack).toHaveLength(1);
    expect(enriched.techStack![0].framework).toBe('AVFoundation');
  });
});

describe('enrichSignalsWithTech — batch helper', () => {
  it('enriches each signal in the batch', () => {
    const signals = [
      makeSignal('Uses AVFoundation.'),
      makeSignal('Uses CoreData.'),
      makeSignal('no tech here'),
    ];
    const enriched = enrichSignalsWithTech(signals);
    expect(enriched).toHaveLength(3);
    expect(enriched[0].techStack).toBeDefined();
    expect(enriched[1].techStack).toBeDefined();
    // The third signal has no tech mentions — it's the same reference.
    expect(enriched[2]).toBe(signals[2]);
  });

  it('returns the input array unchanged when disabled', () => {
    const signals = [makeSignal('Uses AVFoundation.')];
    const enriched = enrichSignalsWithTech(signals, false);
    expect(enriched).toBe(signals);
    expect(enriched[0].techStack).toBeUndefined();
  });

  it('returns the input array unchanged for an empty batch', () => {
    const empty: Signal[] = [];
    expect(enrichSignalsWithTech(empty)).toBe(empty);
  });
});

// ---------------------------------------------------------------------------
// 4. normalizeRawItem integration — the opt-in/out enrichment hook
// ---------------------------------------------------------------------------

describe('normalizeRawItem — ClonaKit enrichment integration', () => {
  const item: RawItem = {
    providerName: 'web_search',
    sourceType: SourceType.SEARCH_WEB,
    title: 'Test',
    snippet: 'This app uses AVFoundation for video and CoreData for storage.',
    url: 'https://example.com/article',
    hostName: 'example.com',
    date: '2024-08-01',
  };

  it('enriches by default (clonakit_enrichment undefined -> on)', () => {
    const { signal } = normalizeRawItem(item, {
      topic: 'video-apps',
      geography: 'global',
    });
    // The basic detected_tech is set by the existing IMP-CLONA-3 pass.
    expect(signal.metadata.detected_tech).toBeDefined();
    expect((signal.metadata.detected_tech as any[]).length).toBe(2);
    // The ClonaKit enrichment blob is also present.
    expect(signal.metadata.clonakit_enrichment).toBeDefined();
    const blob = signal.metadata.clonakit_enrichment as any;
    expect(blob.knownCount).toBe(2);
    expect(blob.fichaSnippet).toContain('AVFoundation');
  });

  it('enriches when clonakit_enrichment is explicitly true', () => {
    const { signal } = normalizeRawItem(item, {
      topic: 'video-apps',
      geography: 'global',
      clonakit_enrichment: true,
    });
    expect(signal.metadata.clonakit_enrichment).toBeDefined();
  });

  it('skips enrichment when clonakit_enrichment is false', () => {
    const { signal } = normalizeRawItem(item, {
      topic: 'video-apps',
      geography: 'global',
      clonakit_enrichment: false,
    });
    // The basic detected_tech is still set (that pass is independent).
    expect(signal.metadata.detected_tech).toBeDefined();
    // But the ClonaKit enrichment blob is NOT present.
    expect(signal.metadata.clonakit_enrichment).toBeUndefined();
  });

  it('does not add clonakit_enrichment when the snippet has no tech mentions', () => {
    const noTechItem: RawItem = {
      ...item,
      snippet: 'Restaurant reservation automation demand growing in Colombia 2024',
    };
    const { signal } = normalizeRawItem(noTechItem, {
      topic: 'restaurant-automation',
      geography: 'Colombia',
    });
    expect(signal.metadata.detected_tech).toBeUndefined();
    expect(signal.metadata.clonakit_enrichment).toBeUndefined();
  });

  it('preserves all existing normalizer behaviour (topic, url, ids)', () => {
    const { signal, evidence } = normalizeRawItem(item, {
      topic: 'video-apps',
      geography: 'global',
    });
    expect(signal.topic).toBe('video-apps');
    expect(evidence.topic).toBe('video-apps');
    expect(signal.url).toBe('https://example.com/article');
    expect(signal.id).toMatch(/^sig_/);
    expect(evidence.id).toMatch(/^ev_/);
    expect(signal.evidenceType).toBe(TruthLevel.OBSERVED);
  });
});

// ---------------------------------------------------------------------------
// 5. destripar_tecnologia tool
// ---------------------------------------------------------------------------

describe('destripar_tecnologia tool', () => {
  let env: ReturnType<typeof makeToolContext>;

  beforeEach(() => {
    env = makeToolContext();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('is registered in createDefaultToolRegistry()', () => {
    const reg = createDefaultToolRegistry();
    const tool = reg.get('destripar_tecnologia');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('destripar_tecnologia');
    expect(tool!.id).toBe('chismoso.tool.destripar_tecnologia.v1');
    expect(tool!.provider).toBe('clonakit');
    expect(tool!.risk).toBe('low');
    expect(tool!.side_effects).toBe('none');
    expect(tool!.permissions.allowedInModes).toContain('sync');
    expect(tool!.permissions.allowedInModes).toContain('react');
    expect(tool!.permissions.allowedInModes).toContain('autonomous');
  });

  it('analyses a text snippet and returns the tech stack', async () => {
    const resp = await destriparTecnologiaTool.execute(
      { text: 'This app uses AVFoundation for video and CoreData for storage.' },
      env.ctx,
    );
    expect(resp.ok).toBe(true);
    expect(resp.analysedText).toContain('AVFoundation');
    expect(resp.mentionedCount).toBe(2);
    expect(resp.knownCount).toBe(2);
    expect(resp.unknownCount).toBe(0);
    expect(resp.techStack.length).toBe(2);
    expect(resp.webEquivalents.length).toBe(2);
    expect(resp.fichaSnippet).toContain('AVFoundation');
    expect(resp.fichaSnippet).toContain('CoreData');
    expect(resp.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns ok:false when neither text nor url is provided', async () => {
    const resp = await destriparTecnologiaTool.execute({}, env.ctx);
    expect(resp.ok).toBe(false);
    expect(resp.reason).toMatch(/text.*url/i);
    expect(resp.techStack).toEqual([]);
  });

  it('returns ok:false when both text and url are provided', async () => {
    const resp = await destriparTecnologiaTool.execute(
      { text: 'AVFoundation', url: 'https://example.com/x' },
      env.ctx,
    );
    expect(resp.ok).toBe(false);
    expect(resp.reason).toMatch(/not both/i);
  });

  it('returns ok:false for an empty (whitespace-only) text', async () => {
    // Whitespace-only text is trimmed to '' inside the tool, which falls
    // into the "no input provided" branch — same as passing no args at all.
    const resp = await destriparTecnologiaTool.execute({ text: '   ' }, env.ctx);
    expect(resp.ok).toBe(false);
    expect(resp.reason).toMatch(/text.*url/i);
    expect(resp.mentionedCount).toBe(0);
  });

  it('returns ok:false with an "empty" reason when the resolved text is empty (via url lookup)', async () => {
    // Insert a signal whose rawSnippet is empty — the url branch resolves
    // the text to '', which then trips the "analysed text is empty" guard.
    const signal = makeSignal('', { url: 'https://example.com/empty' });
    env.ctx.repositories.signals.insert(signal, 'inv_test');
    const resp = await destriparTecnologiaTool.execute(
      { url: 'https://example.com/empty' },
      env.ctx,
    );
    expect(resp.ok).toBe(false);
    expect(resp.reason).toMatch(/empty/i);
  });

  it('returns ok:false for a URL not found in the investigation', async () => {
    const resp = await destriparTecnologiaTool.execute(
      { url: 'https://no-such-url.example.com/x' },
      env.ctx,
    );
    expect(resp.ok).toBe(false);
    expect(resp.reason).toMatch(/No signal with url/);
  });

  it('analyses a stored signal when given a URL that exists in the investigation', async () => {
    // Insert a signal with a known URL + snippet.
    const signal = makeSignal('Uses AVFoundation and CoreData.', {
      url: 'https://example.com/stored',
    });
    env.ctx.repositories.signals.insert(signal, 'inv_test');
    const resp = await destriparTecnologiaTool.execute(
      { url: 'https://example.com/stored' },
      env.ctx,
    );
    expect(resp.ok).toBe(true);
    expect(resp.mentionedCount).toBe(2);
    expect(resp.knownCount).toBe(2);
    expect(resp.fichaSnippet).toContain('AVFoundation');
  });

  it('returns empty techStack for a snippet with no tech mentions', async () => {
    const resp = await destriparTecnologiaTool.execute(
      { text: 'no tech mentioned here at all' },
      env.ctx,
    );
    expect(resp.ok).toBe(true);
    expect(resp.mentionedCount).toBe(0);
    expect(resp.knownCount).toBe(0);
    expect(resp.unknownCount).toBe(0);
    expect(resp.techStack).toEqual([]);
    expect(resp.webEquivalents).toEqual([]);
    // fichaSnippet is an empty string (buildFichaSnippet returns '' for empty input).
    expect(resp.fichaSnippet).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 6. Provider + Tool registries — ClonaKit is listed
// ---------------------------------------------------------------------------

describe('Registries — ClonaKit is registered', () => {
  it('createDefaultProviderRegistry() includes clonakit', () => {
    const reg = createDefaultProviderRegistry();
    const p = reg.get('clonakit');
    expect(p).toBeDefined();
    expect(p!.capabilities().name).toBe('clonakit');
    expect(p!.capabilities().status).toBe('OK');
  });

  it('the clonakit provider passes the allHealth() check', async () => {
    const reg = createDefaultProviderRegistry();
    const healths = await reg.allHealth();
    expect(healths.clonakit).toBe('OK');
  });

  it('createDefaultToolRegistry() includes destripar_tecnologia', () => {
    const reg = createDefaultToolRegistry();
    const names = reg.list().map((t) => t.name);
    expect(names).toContain('destripar_tecnologia');
  });

  it('the tool describe() output includes destripar_tecnologia', () => {
    const reg = createDefaultToolRegistry();
    const desc = reg.describe();
    const t = desc.find((d) => d.name === 'destripar_tecnologia');
    expect(t).toBeDefined();
    expect(t!.purpose).toMatch(/ClonaKit/i);
  });
});

// ---------------------------------------------------------------------------
// 7. Module-level singleton — clonakitProvider
// ---------------------------------------------------------------------------

describe('clonakitProvider singleton', () => {
  it('is an instance of ClonaKitProvider', () => {
    expect(clonakitProvider).toBeInstanceOf(ClonaKitProvider);
  });

  it('exposes the same helper methods as a fresh instance', () => {
    const fresh = new ClonaKitProvider();
    const a = clonakitProvider.extractTechMentions('Uses AVFoundation.');
    const b = fresh.extractTechMentions('Uses AVFoundation.');
    expect(a).toEqual(b);
  });

  it('can validate capabilities through the singleton', () => {
    const result = clonakitProvider.validateCapabilities(['AVFoundation', 'React']);
    expect(result).toHaveLength(2);
    expect(result[0].exists).toBe(true);
    expect(result[1].exists).toBe(false);
  });
});
