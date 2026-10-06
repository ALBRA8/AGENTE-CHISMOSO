/**
 * CHISMOSO V1.0 — server-side Feedback repository (Task IMP-5, spec §28)
 *
 * Thin port of `chismoso/src/feedback/repository.ts` for the Next.js runtime.
 * The chismoso package isn't compiled into the dashboard bundle, so we port
 * the pure-TS logic here.
 *
 * Reads use the readonly singleton (`./db-chismoso.ts`); writes use the
 * writable singleton (`./db-chismoso-writable.ts`). Both singletons point at
 * the same SQLite file (WAL mode → safe concurrent R/W).
 *
 * The schema bootstrap is idempotent — runs `CREATE TABLE IF NOT EXISTS`
 * on every cold start so the API works even if the chismoso CLI hasn't run
 * since the IMP-5 schema was added.
 */

import { chismosoDb } from './db-chismoso';
import { chismosoWritableDb } from './db-chismoso-writable';

// ---------------------------------------------------------------------------
// SCHEMA BOOTSTRAP (idempotent)
// ---------------------------------------------------------------------------

let schemaReady = false;

function ensureSchema(): void {
  if (schemaReady) return;
  chismosoWritableDb.exec(`
    CREATE TABLE IF NOT EXISTS feedback (
      id             TEXT PRIMARY KEY,
      type           TEXT NOT NULL,
      target_type    TEXT NOT NULL,
      target_id      TEXT NOT NULL,
      user_id        TEXT,
      note           TEXT,
      created_at     TEXT NOT NULL,
      metadata_json  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_target  ON feedback(target_type, target_id);
    CREATE INDEX IF NOT EXISTS idx_feedback_type    ON feedback(type);
    CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at DESC);
  `);
  schemaReady = true;
}

// ---------------------------------------------------------------------------
// TYPES (mirror chismoso/src/feedback/models.ts)
// ---------------------------------------------------------------------------

export enum FeedbackType {
  ALERT_USEFUL = 'ALERT_USEFUL',
  ALERT_USELESS = 'ALERT_USELESS',
  FALSE_POSITIVE = 'FALSE_POSITIVE',
  FALSE_NEGATIVE = 'FALSE_NEGATIVE',
  TREND_CONFIRMED = 'TREND_CONFIRMED',
  TREND_REJECTED = 'TREND_REJECTED',
  OPPORTUNITY_USEFUL = 'OPPORTUNITY_USEFUL',
  OPPORTUNITY_IRRELEVANT = 'OPPORTUNITY_IRRELEVANT',
  SIGNAL_NOISE = 'SIGNAL_NOISE',
  SIGNAL_VALUABLE = 'SIGNAL_VALUABLE',
}

export type FeedbackTargetType =
  | 'alert'
  | 'trend'
  | 'opportunity'
  | 'signal'
  | 'memory'
  | 'skill';

export const POSITIVE_FEEDBACK_TYPES: ReadonlySet<FeedbackType> = new Set([
  FeedbackType.ALERT_USEFUL,
  FeedbackType.TREND_CONFIRMED,
  FeedbackType.OPPORTUNITY_USEFUL,
  FeedbackType.SIGNAL_VALUABLE,
]);

export const NEGATIVE_FEEDBACK_TYPES: ReadonlySet<FeedbackType> = new Set([
  FeedbackType.ALERT_USELESS,
  FeedbackType.FALSE_POSITIVE,
  FeedbackType.FALSE_NEGATIVE,
  FeedbackType.TREND_REJECTED,
  FeedbackType.OPPORTUNITY_IRRELEVANT,
  FeedbackType.SIGNAL_NOISE,
]);

export interface Feedback {
  id: string;
  type: FeedbackType;
  target_type: FeedbackTargetType;
  target_id: string;
  user_id?: string;
  note?: string;
  created_at: string;
  metadata?: Record<string, unknown>;
}

export interface FeedbackListFilter {
  type?: FeedbackType;
  target_type?: FeedbackTargetType;
  target_id?: string;
  user_id?: string;
  limit?: number;
}

export interface FeedbackStats {
  total: number;
  by_type: Record<string, number>;
  by_target_type: Record<string, number>;
  useful_rate: number;
  positive_count: number;
  negative_count: number;
}

// ---------------------------------------------------------------------------
// REPOSITORY
// ---------------------------------------------------------------------------

function generateId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${ts}${rnd}`;
}

function nowISO(): string {
  return new Date().toISOString();
}

class FeedbackRepositoryServer {
  insert(fb: Omit<Feedback, 'id' | 'created_at'>): Feedback {
    ensureSchema();
    const row: Feedback = {
      ...fb,
      id: generateId('fb'),
      created_at: nowISO(),
    };
    chismosoWritableDb.prepare(`
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
    ensureSchema();
    const rows = chismosoDb
      .prepare(
        'SELECT * FROM feedback WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC',
      )
      .all(targetType, targetId) as any[];
    return rows.map(parseFeedbackRow);
  }

  list(filter: FeedbackListFilter = {}): Feedback[] {
    ensureSchema();
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
    const rows = chismosoDb.prepare(sql).all(...params, filter.limit ?? 20) as any[];
    return rows.map(parseFeedbackRow);
  }

  listRecent(limit = 20): Feedback[] {
    return this.list({ limit });
  }

  stats(): FeedbackStats {
    ensureSchema();
    const total = (chismosoDb
      .prepare('SELECT COUNT(*) AS c FROM feedback')
      .get() as { c: number }).c;

    const typeRows = chismosoDb
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

    const targetRows = chismosoDb
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

export const feedbackRepository = new FeedbackRepositoryServer();

// ---------------------------------------------------------------------------
// PARSER
// ---------------------------------------------------------------------------

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
