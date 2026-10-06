/**
 * CHISMOSO V1.0 — Feedback repository (spec §28, AUDIT-C §28)
 *
 * Persistence layer for Feedback rows. Mirrors the other repositories in
 * `chismoso/src/repositories.ts` (prepared-statement pattern, JSON-blob
 * for metadata).
 *
 * The repository exposes:
 *   - insert(fb)               → record feedback
 *   - findByTarget(type, id)   → "what feedback exists for this alert?"
 *   - findByType(type, limit)  → "show me the last 20 FALSE_POSITIVE reports"
 *   - list(filter)             → free-form query
 *   - listRecent(limit)        → dashboard feed
 *   - stats()                  → aggregate useful_rate for self-improvement
 *
 * `stats()` is the §29 primitive: a `useful_rate` below ~0.6 means the agent
 * is producing more noise than signal, and the dashboard should surface that.
 */

import type { ChismosoDB } from '../db.js';
import { generateId, nowISO } from '../models.js';
import {
  NEGATIVE_FEEDBACK_TYPES,
  POSITIVE_FEEDBACK_TYPES,
  type Feedback,
  type FeedbackListFilter,
  type FeedbackStats,
  type FeedbackTargetType,
  type FeedbackType,
} from './models.js';

export class FeedbackRepository {
  constructor(private db: ChismosoDB) {}

  insert(fb: Omit<Feedback, 'id' | 'created_at'>): Feedback {
    const row: Feedback = {
      ...fb,
      id: generateId('fb'),
      created_at: nowISO(),
    };

    this.db.prepare(`
      INSERT INTO feedback (
        id, type, target_type, target_id, user_id, note, created_at, metadata_json
      ) VALUES (?,?,?,?,?,?,?,?)
    `).run(
      row.id,
      row.type,
      row.target_type,
      row.target_id,
      row.user_id ?? null,
      row.note ?? null,
      row.created_at,
      row.metadata ? JSON.stringify(row.metadata) : null,
    );

    return row;
  }

  findByTarget(targetType: FeedbackTargetType, targetId: string): Feedback[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM feedback WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC',
      )
      .all(targetType, targetId) as any[];
    return rows.map(parseFeedbackRow);
  }

  findByType(type: FeedbackType, limit = 20): Feedback[] {
    const rows = this.db
      .prepare('SELECT * FROM feedback WHERE type = ? ORDER BY created_at DESC LIMIT ?')
      .all(type, limit) as any[];
    return rows.map(parseFeedbackRow);
  }

  list(filter: FeedbackListFilter = {}): Feedback[] {
    const where: string[] = [];
    const params: any[] = [];
    if (filter.type) {
      where.push('type = ?');
      params.push(filter.type);
    }
    if (filter.target_type) {
      where.push('target_type = ?');
      params.push(filter.target_type);
    }
    if (filter.target_id) {
      where.push('target_id = ?');
      params.push(filter.target_id);
    }
    if (filter.user_id) {
      where.push('user_id = ?');
      params.push(filter.user_id);
    }
    const sql = where.length > 0
      ? `SELECT * FROM feedback WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`
      : 'SELECT * FROM feedback ORDER BY created_at DESC LIMIT ?';
    const rows = this.db.prepare(sql).all(...params, filter.limit ?? 20) as any[];
    return rows.map(parseFeedbackRow);
  }

  listRecent(limit = 20): Feedback[] {
    return this.list({ limit });
  }

  /**
   * Compute aggregate stats for self-improvement (§29).
   *
   * `useful_rate` = positives / (positives + negatives). Feedback rows whose
   * type is neither in POSITIVE nor NEGATIVE sets are ignored (currently all
   * FeedbackType values are in one of the two sets, but this is defensive
   * against future additions).
   *
   * Returns 0 useful_rate when there are zero rated feedback rows (not NaN).
   */
  stats(): FeedbackStats {
    const total = (this.db
      .prepare('SELECT COUNT(*) AS c FROM feedback')
      .get() as { c: number }).c;

    const typeRows = this.db
      .prepare('SELECT type, COUNT(*) AS c FROM feedback GROUP BY type')
      .all() as Array<{ type: string; c: number }>;
    const by_type: Record<string, number> = {};
    let positive_count = 0;
    let negative_count = 0;
    for (const r of typeRows) {
      by_type[r.type] = r.c;
      if (POSITIVE_FEEDBACK_TYPES.has(r.type as FeedbackType)) {
        positive_count += r.c;
      } else if (NEGATIVE_FEEDBACK_TYPES.has(r.type as FeedbackType)) {
        negative_count += r.c;
      }
    }

    const targetRows = this.db
      .prepare('SELECT target_type, COUNT(*) AS c FROM feedback GROUP BY target_type')
      .all() as Array<{ target_type: string; c: number }>;
    const by_target_type: Record<string, number> = {};
    for (const r of targetRows) by_target_type[r.target_type] = r.c;

    const rated = positive_count + negative_count;
    const useful_rate = rated > 0 ? positive_count / rated : 0;

    return {
      total,
      by_type,
      by_target_type,
      useful_rate: Math.round(useful_rate * 1000) / 1000,
      positive_count,
      negative_count,
    };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseFeedbackRow(r: any): Feedback {
  return {
    id: r.id,
    type: r.type as FeedbackType,
    target_type: r.target_type as FeedbackTargetType,
    target_id: r.target_id,
    user_id: r.user_id ?? undefined,
    note: r.note ?? undefined,
    created_at: r.created_at,
    metadata: r.metadata_json ? JSON.parse(r.metadata_json) : undefined,
  };
}
