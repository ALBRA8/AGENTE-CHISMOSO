/**
 * Unit tests — FeedbackRepository (spec §28, Task IMP-5)
 *
 * Covers insert, findByTarget, list, and stats (including the useful_rate
 * computation that powers §29 self-improvement).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ChismosoDB } from '../src/db.js';
import {
  FeedbackRepository,
  FeedbackType,
  POSITIVE_FEEDBACK_TYPES,
  NEGATIVE_FEEDBACK_TYPES,
} from '../src/feedback/index.js';

let db: ChismosoDB;
let repo: FeedbackRepository;

beforeEach(() => {
  db = new ChismosoDB({ path: ':memory:' });
  repo = new FeedbackRepository(db);
});

describe('FeedbackRepository.insert', () => {
  it('persists a feedback row and returns it with id + created_at', () => {
    const fb = repo.insert({
      type: FeedbackType.ALERT_USEFUL,
      target_type: 'alert',
      target_id: 'alert_abc',
      note: 'helpful',
      user_id: 'alice',
    });
    expect(fb.id).toMatch(/^fb_/);
    expect(fb.created_at).toBeTruthy();
    expect(fb.type).toBe(FeedbackType.ALERT_USEFUL);
    expect(fb.target_type).toBe('alert');
    expect(fb.target_id).toBe('alert_abc');
    expect(fb.note).toBe('helpful');
    expect(fb.user_id).toBe('alice');
  });

  it('works without optional fields (note, user_id)', () => {
    const fb = repo.insert({
      type: FeedbackType.TREND_REJECTED,
      target_type: 'trend',
      target_id: 'trend_xyz',
    });
    expect(fb.id).toMatch(/^fb_/);
    expect(fb.note).toBeUndefined();
    expect(fb.user_id).toBeUndefined();
  });
});

describe('FeedbackRepository.findByTarget', () => {
  it('returns matching rows for a (target_type, target_id) pair', () => {
    repo.insert({ type: FeedbackType.ALERT_USEFUL, target_type: 'alert', target_id: 'a1' });
    repo.insert({ type: FeedbackType.ALERT_USELESS, target_type: 'alert', target_id: 'a1' });
    repo.insert({ type: FeedbackType.ALERT_USEFUL, target_type: 'alert', target_id: 'a2' });

    const found = repo.findByTarget('alert', 'a1');
    expect(found.length).toBe(2);
    expect(found.every((f) => f.target_id === 'a1')).toBe(true);
  });

  it('returns [] when no feedback exists for that target', () => {
    expect(repo.findByTarget('alert', 'nonexistent')).toEqual([]);
  });

  it('returns feedback ordered by created_at DESC (most recent first)', async () => {
    const f1 = repo.insert({ type: FeedbackType.ALERT_USEFUL, target_type: 'alert', target_id: 'a1' });
    await new Promise((r) => setTimeout(r, 5));
    const f2 = repo.insert({ type: FeedbackType.ALERT_USELESS, target_type: 'alert', target_id: 'a1' });
    const found = repo.findByTarget('alert', 'a1');
    expect(found[0].id).toBe(f2.id);
    expect(found[1].id).toBe(f1.id);
  });
});

describe('FeedbackRepository.findByType', () => {
  it('returns rows of the given type, ordered by created_at DESC', async () => {
    const f1 = repo.insert({ type: FeedbackType.FALSE_POSITIVE, target_type: 'alert', target_id: 'a1' });
    await new Promise((r) => setTimeout(r, 5));
    const f2 = repo.insert({ type: FeedbackType.FALSE_POSITIVE, target_type: 'alert', target_id: 'a2' });
    repo.insert({ type: FeedbackType.ALERT_USEFUL, target_type: 'alert', target_id: 'a3' });

    const found = repo.findByType(FeedbackType.FALSE_POSITIVE, 10);
    expect(found.length).toBe(2);
    expect(found[0].id).toBe(f2.id);
    expect(found[1].id).toBe(f1.id);
    expect(found.every((f) => f.type === FeedbackType.FALSE_POSITIVE)).toBe(true);
  });
});

describe('FeedbackRepository.stats', () => {
  it('computes useful_rate correctly (8 useful / 10 total = 0.8)', () => {
    // 8 useful
    for (let i = 0; i < 5; i++) {
      repo.insert({ type: FeedbackType.ALERT_USEFUL, target_type: 'alert', target_id: `a${i}` });
    }
    for (let i = 0; i < 3; i++) {
      repo.insert({ type: FeedbackType.TREND_CONFIRMED, target_type: 'trend', target_id: `t${i}` });
    }
    // 2 useless
    repo.insert({ type: FeedbackType.ALERT_USELESS, target_type: 'alert', target_id: 'bad1' });
    repo.insert({ type: FeedbackType.OPPORTUNITY_IRRELEVANT, target_type: 'opportunity', target_id: 'bad2' });

    const stats = repo.stats();
    expect(stats.total).toBe(10);
    expect(stats.positive_count).toBe(8);
    expect(stats.negative_count).toBe(2);
    expect(stats.useful_rate).toBeCloseTo(0.8, 2);

    // by_type counts
    expect(stats.by_type[FeedbackType.ALERT_USEFUL]).toBe(5);
    expect(stats.by_type[FeedbackType.TREND_CONFIRMED]).toBe(3);
    expect(stats.by_type[FeedbackType.ALERT_USELESS]).toBe(1);
    expect(stats.by_type[FeedbackType.OPPORTUNITY_IRRELEVANT]).toBe(1);

    // by_target_type counts
    expect(stats.by_target_type.alert).toBe(6);
    expect(stats.by_target_type.trend).toBe(3);
    expect(stats.by_target_type.opportunity).toBe(1);
  });

  it('returns useful_rate=0 when there is no feedback at all', () => {
    const stats = repo.stats();
    expect(stats.total).toBe(0);
    expect(stats.useful_rate).toBe(0);
    expect(stats.positive_count).toBe(0);
    expect(stats.negative_count).toBe(0);
  });

  it('treats FALSE_POSITIVE and FALSE_NEGATIVE as negative (correction feedback)', () => {
    repo.insert({ type: FeedbackType.FALSE_POSITIVE, target_type: 'alert', target_id: 'a1' });
    repo.insert({ type: FeedbackType.FALSE_NEGATIVE, target_type: 'alert', target_id: 'a2' });
    repo.insert({ type: FeedbackType.SIGNAL_VALUABLE, target_type: 'signal', target_id: 's1' });

    const stats = repo.stats();
    expect(stats.positive_count).toBe(1);
    expect(stats.negative_count).toBe(2);
    expect(stats.useful_rate).toBeCloseTo(1 / 3, 2);
  });

  it('POSITIVE/NEGATIVE sets cover all FeedbackType values (no orphan types)', () => {
    const all = Object.values(FeedbackType);
    const positives = all.filter((t) => POSITIVE_FEEDBACK_TYPES.has(t));
    const negatives = all.filter((t) => NEGATIVE_FEEDBACK_TYPES.has(t));
    // Every type must be in exactly one of the two sets.
    expect(positives.length + negatives.length).toBe(all.length);
    // No type should be in both sets.
    for (const t of positives) {
      expect(NEGATIVE_FEEDBACK_TYPES.has(t)).toBe(false);
    }
  });
});

describe('FeedbackRepository.listRecent', () => {
  it('returns newest first (ordered by created_at DESC)', async () => {
    const f1 = repo.insert({ type: FeedbackType.ALERT_USEFUL, target_type: 'alert', target_id: 'a1' });
    await new Promise((r) => setTimeout(r, 5));
    const f2 = repo.insert({ type: FeedbackType.ALERT_USELESS, target_type: 'alert', target_id: 'a2' });
    await new Promise((r) => setTimeout(r, 5));
    const f3 = repo.insert({ type: FeedbackType.TREND_CONFIRMED, target_type: 'trend', target_id: 't1' });

    const recent = repo.listRecent(10);
    expect(recent.length).toBe(3);
    expect(recent[0].id).toBe(f3.id);
    expect(recent[1].id).toBe(f2.id);
    expect(recent[2].id).toBe(f1.id);
  });

  it('honors the limit argument', () => {
    for (let i = 0; i < 10; i++) {
      repo.insert({ type: FeedbackType.ALERT_USEFUL, target_type: 'alert', target_id: `a${i}` });
    }
    const recent = repo.listRecent(3);
    expect(recent.length).toBe(3);
  });

  it('returns [] when there is no feedback at all', () => {
    expect(repo.listRecent(10)).toEqual([]);
  });
});

describe('FeedbackRepository.list with filters', () => {
  it('filters by target_type AND target_id', () => {
    repo.insert({ type: FeedbackType.ALERT_USEFUL, target_type: 'alert', target_id: 'a1' });
    repo.insert({ type: FeedbackType.ALERT_USELESS, target_type: 'alert', target_id: 'a1' });
    repo.insert({ type: FeedbackType.ALERT_USEFUL, target_type: 'alert', target_id: 'a2' });
    repo.insert({ type: FeedbackType.TREND_CONFIRMED, target_type: 'trend', target_id: 't1' });

    const found = repo.list({ target_type: 'alert', target_id: 'a1' });
    expect(found.length).toBe(2);
    expect(found.every((f) => f.target_id === 'a1' && f.target_type === 'alert')).toBe(true);
  });

  it('filters by user_id', () => {
    repo.insert({ type: FeedbackType.ALERT_USEFUL, target_type: 'alert', target_id: 'a1', user_id: 'alice' });
    repo.insert({ type: FeedbackType.ALERT_USEFUL, target_type: 'alert', target_id: 'a2', user_id: 'bob' });
    const found = repo.list({ user_id: 'alice' });
    expect(found.length).toBe(1);
    expect(found[0].user_id).toBe('alice');
  });

  it('honors the limit argument', () => {
    for (let i = 0; i < 10; i++) {
      repo.insert({ type: FeedbackType.ALERT_USEFUL, target_type: 'alert', target_id: `a${i}` });
    }
    const found = repo.list({ limit: 5 });
    expect(found.length).toBe(5);
  });
});
