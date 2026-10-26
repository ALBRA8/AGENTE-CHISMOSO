/**
 * Unit tests — Capability mapping (IMP-CLONA-3, ported from ClonaKit's
 * `herramientas/capacidades.mjs`).
 *
 * Verifies the lookup, detection, and aggregation helpers that feed:
 *  - normalizer.ts (signal.metadata.detected_tech)
 *  - opportunities.ts (Opportunity.tech_recommendations + marketFit bump)
 */

import { describe, it, expect } from 'vitest';
import {
  CAPABILITY_MAPPING,
  CAPABILITY_COUNT,
  lookupCapability,
  detectTechMentions,
  listByCategory,
  categoryStats,
} from '../src/intelligence/capability-mapping.js';

describe('capability-mapping — lookupCapability', () => {
  it('returns the AVFoundation entry when queried by its canonical name', () => {
    const entry = lookupCapability('AVFoundation');
    expect(entry).toBeDefined();
    expect(entry!.framework).toBe('AVFoundation');
    expect(entry!.web_equivalent).toContain('getUserMedia');
    expect(entry!.category).toBe('audio_video');
  });

  it('is case-insensitive (avfoundation → same entry as AVFoundation)', () => {
    const a = lookupCapability('AVFoundation');
    const b = lookupCapability('avfoundation');
    const c = lookupCapability('AvFoUnDaTiOn');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(c).toBeDefined();
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('returns undefined for an unknown framework', () => {
    expect(lookupCapability('UnknownFramework')).toBeUndefined();
    expect(lookupCapability('NotInTable')).toBeUndefined();
  });

  it('returns undefined for empty input (defensive)', () => {
    expect(lookupCapability('')).toBeUndefined();
  });

  it('round-trips every key in CAPABILITY_MAPPING through lookupCapability', () => {
    // Strong invariant: every key in the table must resolve to its own entry.
    for (const key of Object.keys(CAPABILITY_MAPPING)) {
      const entry = lookupCapability(key);
      expect(entry, `lookupCapability('${key}') must resolve`).toBeDefined();
      expect(entry!.framework).toBe(key);
    }
  });
});

describe('capability-mapping — detectTechMentions', () => {
  it('detects two frameworks in a sentence', () => {
    const mentions = detectTechMentions('This app uses AVFoundation and CoreData');
    // Exactly 2 distinct frameworks, no spurious matches.
    expect(mentions).toHaveLength(2);
    const frameworks = mentions.map((m) => m.entry.framework).sort();
    expect(frameworks).toEqual(['AVFoundation', 'CoreData']);
    // Each mention carries at least one position offset into the lowercased text.
    for (const m of mentions) {
      expect(m.positions.length).toBeGreaterThan(0);
      for (const p of m.positions) {
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThan('this app uses avfoundation and coredata'.length);
      }
    }
  });

  it('does not match a framework name that is a substring of another word', () => {
    // AVFoundation contains "Foundation" — the standalone Foundation entry
    // must NOT match here (no word boundary between "AV" and "Foundation").
    const mentions = detectTechMentions('AVFoundation is used here');
    const frameworks = mentions.map((m) => m.entry.framework);
    expect(frameworks).toContain('AVFoundation');
    expect(frameworks).not.toContain('Foundation');
  });

  it('returns an empty array when no tech is mentioned', () => {
    expect(detectTechMentions('no tech mentioned here')).toEqual([]);
  });

  it('returns an empty array for empty input (defensive)', () => {
    expect(detectTechMentions('')).toEqual([]);
    expect(detectTechMentions('   ')).toEqual([]);
  });

  it('finds every occurrence of a framework in a snippet', () => {
    // Metal mentioned twice → positions array has length 2.
    const mentions = detectTechMentions('Metal is fast. Metal is also low-level.');
    const metal = mentions.find((m) => m.entry.framework === 'Metal');
    expect(metal).toBeDefined();
    expect(metal!.positions).toHaveLength(2);
  });

  it('is case-insensitive when scanning', () => {
    const mentions = detectTechMentions('this app uses AVFOUNDATION and COREDATA');
    const frameworks = mentions.map((m) => m.entry.framework).sort();
    expect(frameworks).toEqual(['AVFoundation', 'CoreData']);
  });
});

describe('capability-mapping — listByCategory', () => {
  it('returns multiple audio_video entries', () => {
    const entries = listByCategory('audio_video');
    expect(entries.length).toBeGreaterThan(3);
    // Every returned entry must belong to the requested category.
    for (const e of entries) {
      expect(e.category).toBe('audio_video');
    }
    // Spot-check a known member.
    expect(entries.some((e) => e.framework === 'AVFoundation')).toBe(true);
  });

  it('returns an empty array for the reserved-but-unused storage category', () => {
    // The `storage` category is in the union type but no entries use it yet.
    // listByCategory must return [] (not undefined, not throw).
    expect(listByCategory('storage')).toEqual([]);
  });

  it('the union of all categories equals the full CAPABILITY_MAPPING', () => {
    const all: string[] = [];
    for (const cat of [
      'audio_video', 'graphics', 'ui', 'data', 'network', 'security',
      'hardware', 'ai', 'system', 'storage', 'location', 'media',
    ] as const) {
      all.push(...listByCategory(cat).map((e) => e.framework));
    }
    expect(all.length).toBe(Object.keys(CAPABILITY_MAPPING).length);
    // No framework should be listed twice across categories.
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('capability-mapping — categoryStats', () => {
  it('returns an object whose keys are the known categories', () => {
    const stats = categoryStats();
    const expectedCategories = [
      'audio_video', 'graphics', 'ui', 'data', 'network', 'security',
      'hardware', 'ai', 'system', 'storage', 'location', 'media',
    ];
    for (const c of expectedCategories) {
      expect(stats[c]).toBeDefined();
      expect(typeof stats[c]).toBe('number');
    }
  });

  it('the sum of category counts equals CAPABILITY_COUNT', () => {
    const stats = categoryStats();
    const total = Object.values(stats).reduce<number>((a, b) => a + b, 0);
    expect(total).toBe(CAPABILITY_COUNT);
  });

  it('reports audio_video with at least 3 entries', () => {
    expect(categoryStats().audio_video).toBeGreaterThanOrEqual(3);
  });
});
