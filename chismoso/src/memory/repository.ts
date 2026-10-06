/**
 * CHISMOSO V1.0 — MemoryRepository (spec §12-§14)
 *
 * SQLite CRUD for MemoryRecord rows. Owns the row↔record mapping and the
 * decay pass (applyDecay) which recomputes relevance + status for all
 * ACTIVE memories and writes back the deltas in a single transaction.
 *
 * Design notes:
 *   - Same pattern as SignalRepository / EvidenceRepository: a thin wrapper
 *     over ChismosoDB with typed insert/find methods.
 *   - No foreign keys to signals/evidence/investigations — memories are
 *     "soft-linked" via evidence_id and provenance strings so that a
 *     memory can survive even if the underlying evidence row is GC'd by
 *     a future cleanup pass (which V1 doesn't have, but the contract
 *     should support it).
 *   - applyDecay only writes back rows whose status or relevance actually
 *     changed, so a no-op run costs O(N) reads and 0 writes.
 */

import type { ChismosoDB } from '../db.js';
import { generateId, nowISO } from '../models.js';
import { logger } from '../logger.js';
import {
  DEFAULT_HALF_LIFE_DAYS,
  type MemoryRecord,
  type MemoryTruthLevel,
  MemoryStatus,
  MemoryType,
} from './models.js';
import { boostUtility, shouldDecay } from './decay.js';

// ---------------------------------------------------------------------------
// INPUT TYPE — what callers pass to insert()
// ---------------------------------------------------------------------------

/**
 * Subset of MemoryRecord that the caller is responsible for providing.
 * The repository fills in: id, relevance (= confidence), utility (=0),
 * status (=ACTIVE), created_at, updated_at, last_verified.
 */
export type MemoryInsertInput = Omit<
  MemoryRecord,
  | 'id'
  | 'created_at'
  | 'updated_at'
  | 'last_verified'
  | 'relevance'
  | 'utility'
  | 'status'
> &
  Partial<Pick<MemoryRecord, 'utility' | 'status'>>;

// ---------------------------------------------------------------------------
// ROW SHAPE (snake_case from SQLite)
// ---------------------------------------------------------------------------

interface MemoryRow {
  id: string;
  agent_id: string;
  domain: string;
  type: string;
  content: string;
  source: string | null;
  source_type: string | null;
  evidence_id: string | null;
  provenance: string | null;
  confidence: number | null;
  truth_level: string | null;
  relevance: number | null;
  utility: number | null;
  decay_half_life_days: number | null;
  scope: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  last_verified: string;
  related_signal_ids_json: string | null;
  related_topic: string | null;
}

// ---------------------------------------------------------------------------
// REPOSITORY
// ---------------------------------------------------------------------------

export class MemoryRepository {
  constructor(private db: ChismosoDB) {}

  // -------------------------------------------------------------------------
  // INSERT
  // -------------------------------------------------------------------------

  insert(input: MemoryInsertInput): MemoryRecord {
    const now = nowISO();
    const halfLife = input.decay_half_life_days ?? DEFAULT_HALF_LIFE_DAYS;
    const record: MemoryRecord = {
      ...input,
      id: generateId('mem'),
      utility: input.utility ?? 0,
      status: input.status ?? MemoryStatus.ACTIVE,
      relevance: input.confidence, // initial relevance == confidence; decay recomputes it
      decay_half_life_days: halfLife,
      created_at: now,
      updated_at: now,
      last_verified: now,
    };

    this.db
      .prepare(
        `INSERT INTO memories (
          id, agent_id, domain, type, content, source, source_type, evidence_id,
          provenance, confidence, truth_level, relevance, utility, decay_half_life_days,
          scope, status, created_at, updated_at, last_verified,
          related_signal_ids_json, related_topic
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        record.id,
        record.agent_id,
        record.domain,
        record.type,
        record.content,
        record.source ?? null,
        record.source_type ?? null,
        record.evidence_id ?? null,
        record.provenance,
        record.confidence,
        record.truth_level,
        record.relevance,
        record.utility,
        record.decay_half_life_days,
        record.scope,
        record.status,
        record.created_at,
        record.updated_at,
        record.last_verified,
        record.related_signal_ids ? JSON.stringify(record.related_signal_ids) : null,
        record.related_topic ?? null,
      );

    return record;
  }

  // -------------------------------------------------------------------------
  // READS
  // -------------------------------------------------------------------------

  findById(id: string): MemoryRecord | null {
    const row = this.db
      .prepare('SELECT * FROM memories WHERE id = ?')
      .get(id) as MemoryRow | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  findByDomain(domain: string, limit = 50): MemoryRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM memories WHERE domain = ? ORDER BY relevance DESC, updated_at DESC LIMIT ?')
      .all(domain, limit) as MemoryRow[];
    return rows.map((r) => this.rowToRecord(r));
  }

  findByTopic(topic: string, limit = 50): MemoryRecord[] {
    if (!topic) return [];
    const rows = this.db
      .prepare('SELECT * FROM memories WHERE related_topic = ? ORDER BY relevance DESC, updated_at DESC LIMIT ?')
      .all(topic, limit) as MemoryRow[];
    return rows.map((r) => this.rowToRecord(r));
  }

  findActive(limit = 100): MemoryRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM memories WHERE status = ? ORDER BY relevance DESC, updated_at DESC LIMIT ?')
      .all(MemoryStatus.ACTIVE, limit) as MemoryRow[];
    return rows.map((r) => this.rowToRecord(r));
  }

  /**
   * List memories with optional filters. Used by the CLI / API.
   * Returns rows in descending relevance order so the most relevant memories
   * surface first in dashboards.
   */
  list(opts: {
    domain?: string;
    type?: MemoryType;
    status?: MemoryStatus;
    topic?: string;
    limit?: number;
  } = {}): MemoryRecord[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.domain) {
      where.push('domain = ?');
      params.push(opts.domain);
    }
    if (opts.type) {
      where.push('type = ?');
      params.push(opts.type);
    }
    if (opts.status) {
      where.push('status = ?');
      params.push(opts.status);
    }
    if (opts.topic) {
      where.push('related_topic = ?');
      params.push(opts.topic);
    }
    const limit = opts.limit ?? 50;
    const sql = `SELECT * FROM memories ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY relevance DESC, updated_at DESC LIMIT ?`;
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as MemoryRow[];
    return rows.map((r) => this.rowToRecord(r));
  }

  /**
   * Aggregated counts by domain / type / status. Used by `chismoso memory stats`
   * and the API dashboard. Each group returns { key, count }.
   */
  stats(): {
    byDomain: Array<{ key: string; count: number }>;
    byType: Array<{ key: string; count: number }>;
    byStatus: Array<{ key: string; count: number }>;
    total: number;
  } {
    const byDomain = this.db
      .prepare('SELECT domain AS key, COUNT(*) AS count FROM memories GROUP BY domain ORDER BY count DESC')
      .all() as Array<{ key: string; count: number }>;
    const byType = this.db
      .prepare('SELECT type AS key, COUNT(*) AS count FROM memories GROUP BY type ORDER BY count DESC')
      .all() as Array<{ key: string; count: number }>;
    const byStatus = this.db
      .prepare('SELECT status AS key, COUNT(*) AS count FROM memories GROUP BY status ORDER BY count DESC')
      .all() as Array<{ key: string; count: number }>;
    const total = (this.db.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }).c ?? 0;
    return { byDomain, byType, byStatus, total };
  }

  // -------------------------------------------------------------------------
  // DECAY PASS
  // -------------------------------------------------------------------------

  /**
   * Run temporal decay over all ACTIVE memories.
   *
   * For each ACTIVE row, recompute relevance + status. Only write back rows
   * whose status or relevance actually changed (the cheap path is "nothing
   * changed" — a single UPDATE per row is the worst case).
   *
   * Returns counts: total updated, of which decayed (status→DECAYED) and
   * archived (status→ARCHIVED).
   *
   * DECAYED and ARCHIVED rows are NOT processed again — their relevance is
   * already below threshold, recomputing it adds nothing.
   *
   * Wrapped in a single transaction so concurrent readers see a consistent
   * snapshot.
   */
  applyDecay(now: Date = new Date()): {
    updated: number;
    decayed: number;
    archived: number;
  } {
    const all = this.db
      .prepare('SELECT * FROM memories WHERE status = ?')
      .all(MemoryStatus.ACTIVE) as MemoryRow[];

    let updated = 0;
    let decayed = 0;
    let archived = 0;

    const updateStmt = this.db.prepare(
      'UPDATE memories SET status = ?, relevance = ?, updated_at = ? WHERE id = ?',
    );

    const tx = this.db.transaction(() => {
      for (const row of all) {
        const mem = this.rowToRecord(row);
        const { status, relevance } = shouldDecay(mem, now);
        const relevanceChanged = Math.abs(relevance - mem.relevance) > 1e-9;
        if (status !== mem.status || relevanceChanged) {
          updateStmt.run(status, relevance, nowISO(), mem.id);
          updated++;
          if (status === MemoryStatus.DECAYED) decayed++;
          if (status === MemoryStatus.ARCHIVED) archived++;
        }
      }
    });
    tx();

    if (updated > 0) {
      logger.info('Memory decay applied', { updated, decayed, archived, total: all.length });
    }
    return { updated, decayed, archived };
  }

  // -------------------------------------------------------------------------
  // FEEDBACK / VERIFICATION
  // -------------------------------------------------------------------------

  /**
   * Boost utility after positive feedback (used by the V2 Feedback system).
   * Idempotent — once utility hits 1, further boosts are no-ops.
   */
  boostUtility(id: string, amount: number = 0.1): void {
    const mem = this.findById(id);
    if (!mem) return;
    const newUtility = boostUtility(mem, amount);
    if (newUtility === mem.utility) return; // already maxed
    this.db
      .prepare('UPDATE memories SET utility = ?, updated_at = ? WHERE id = ?')
      .run(newUtility, nowISO(), id);
  }

  /**
   * Mark a memory VERIFIED — corroborating evidence arrived. Updates truth_level
   * and last_verified. Does not change relevance (that's the decay pass's job)
   * but does refresh updated_at so the decay clock resets and the memory
   * effectively "stays fresh" longer.
   */
  verify(id: string): void {
    const now = nowISO();
    this.db
      .prepare(
        'UPDATE memories SET truth_level = ?, last_verified = ?, updated_at = ? WHERE id = ?',
      )
      .run('VERIFIED' as MemoryTruthLevel, now, now, id);
  }

  /**
   * Mark a memory contradicted — new evidence refutes it. Halves confidence
   * and demotes to DECAYED status so it stops polluting active query results.
   *
   * Note: we don't drop the row. MemoryDV is append-only / auditable — a
   * contradicted memory is kept so we can later ask "why did we believe X
   * at time T?".
   */
  markContradicted(id: string): void {
    this.db
      .prepare(
        'UPDATE memories SET confidence = confidence * 0.5, status = ?, updated_at = ? WHERE id = ?',
      )
      .run(MemoryStatus.DECAYED, nowISO(), id);
  }

  /**
   * Manually archive a memory — operator-facing action (CLI / API).
   * Sets status = ARCHIVED. Does NOT change relevance (which is already
   * stale or near-zero) — keeps the original value for audit.
   */
  archive(id: string): void {
    this.db
      .prepare('UPDATE memories SET status = ?, updated_at = ? WHERE id = ?')
      .run(MemoryStatus.ARCHIVED, nowISO(), id);
  }

  /**
   * Manually retire a memory — operator-facing action. RETIRED is the
   * terminal status for memories that should never be queried again but
   * are kept for audit (e.g. they were sourced from a provider we no
   * longer trust).
   */
  retire(id: string): void {
    this.db
      .prepare('UPDATE memories SET status = ?, updated_at = ? WHERE id = ?')
      .run(MemoryStatus.RETIRED, nowISO(), id);
  }

  // -------------------------------------------------------------------------
  // ROW MAPPING
  // -------------------------------------------------------------------------

  private rowToRecord(row: MemoryRow): MemoryRecord {
    return {
      id: row.id,
      agent_id: row.agent_id,
      domain: row.domain,
      type: row.type as MemoryType,
      content: row.content,
      source: row.source ?? '',
      source_type: row.source_type ?? undefined,
      evidence_id: row.evidence_id ?? undefined,
      provenance: row.provenance ?? '',
      confidence: row.confidence ?? 0,
      truth_level: (row.truth_level ?? 'UNKNOWN') as MemoryTruthLevel,
      // Read the stored relevance column directly — it was written by the
      // last applyDecay() pass and is what the system "officially" believes
      // the relevance to be. (If you want "what would it be right now?", call
      // computeRelevance(record, new Date()) from the caller.)
      relevance: row.relevance ?? 0,
      utility: row.utility ?? 0,
      decay_half_life_days: row.decay_half_life_days ?? DEFAULT_HALF_LIFE_DAYS,
      scope: row.scope ?? 'global',
      status: row.status as MemoryStatus,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_verified: row.last_verified,
      related_signal_ids: row.related_signal_ids_json
        ? safeParseStrings(row.related_signal_ids_json)
        : undefined,
      related_topic: row.related_topic ?? undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function safeParseStrings(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
