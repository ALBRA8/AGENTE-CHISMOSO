/**
 * CHISMOSO V1.4 — Skills Repository (spec §26, §27, §28)
 *
 * Persistence layer for the Skills + SkillInvocation tables. Knows how to
 * (de)serialize the JSON arrays that SQLite stores as TEXT, but contains
 * NO business logic — that lives in `registry.ts`.
 *
 * The lifecycle state-machine (spec §27) is enforced by `transition()`.
 * Other repositories / engines are NOT allowed to mutate `status` directly
 * — they must call `transition()` so the rule table in `models.ts` is
 * consulted.
 */

import type { ChismosoDB } from '../db.js';
import {
  SkillStatus,
  isAllowedTransition,
  generateSkillId,
  generateInvocationId,
  nowISO,
  type Skill,
  type SkillInput,
  type SkillInvocation,
  type SkillInvocationInput,
  type InvocationStatus,
  type InvocationFeedback,
} from './models.js';

// ---------------------------------------------------------------------------
// Row shape (raw SQLite, before parsing)
// ---------------------------------------------------------------------------

interface SkillRow {
  id: string;
  identity: string;
  purpose: string;
  trigger: string | null;
  prerequisites_json: string | null;
  procedure: string | null;
  tools_required_json: string | null;
  expected_result: string | null;
  verification: string | null;
  pitfalls_json: string | null;
  evidence: string | null;
  version: string;
  confidence: number;
  success_rate: number;
  origin: string;
  last_validated: string | null;
  regression_tests: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  invocations: number;
  successes: number;
  failures: number;
}

interface SkillInvocationRow {
  id: string;
  skill_id: string;
  investigation_id: string | null;
  invoked_at: string;
  completed_at: string | null;
  status: string;
  inputs_json: string | null;
  outputs_json: string | null;
  error: string | null;
  feedback: string | null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SkillNotFoundError extends Error {
  constructor(public needle: string) {
    super(`Skill not found: ${needle}`);
    this.name = 'SkillNotFoundError';
  }
}

export class InvalidTransitionError extends Error {
  constructor(
    public from: string,
    public to: string,
  ) {
    super(`Invalid skill transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export class DuplicateIdentityError extends Error {
  constructor(public identity: string) {
    super(`Skill identity already exists: ${identity}`);
    this.name = 'DuplicateIdentityError';
  }
}

export class InvocationNotFoundError extends Error {
  constructor(public id: string) {
    super(`Skill invocation not found: ${id}`);
    this.name = 'InvocationNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class SkillRepository {
  constructor(private db: ChismosoDB) {}

  // -------------------------------------------------------------------------
  // CREATE / READ / UPDATE / DELETE
  // -------------------------------------------------------------------------

  insert(input: SkillInput): Skill {
    const id = generateSkillId('skill');
    const now = nowISO();
    const status = input.status ?? SkillStatus.PROPOSED;
    const origin = input.origin ?? 'builtin';
    const version = input.version ?? '1.0.0';
    const confidence = input.confidence ?? 0.5;
    try {
      this.db
        .prepare(
          `INSERT INTO skills (
             id, identity, purpose, trigger,
             prerequisites_json, procedure, tools_required_json,
             expected_result, verification, pitfalls_json, evidence,
             version, confidence, success_rate, origin,
             last_validated, regression_tests, status,
             created_at, updated_at,
             invocations, successes, failures
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.identity,
          input.purpose,
          input.trigger ?? null,
          JSON.stringify(input.prerequisites ?? []),
          input.procedure ?? null,
          JSON.stringify(input.tools_required ?? []),
          input.expected_result ?? null,
          input.verification ?? null,
          JSON.stringify(input.pitfalls ?? []),
          input.evidence ?? null,
          version,
          confidence,
          0,
          origin,
          input.last_validated ?? null,
          input.regression_tests ?? null,
          status,
          now,
          now,
          0,
          0,
          0,
        );
    } catch (e: unknown) {
      // better-sqlite3 throws SQLiteError with code 'SQLITE_CONSTRAINT_UNIQUE'
      // when the `identity` UNIQUE constraint is violated. Translate to a
      // typed error so the catalog layer can present a friendly message.
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('UNIQUE') && msg.includes('identity')) {
        throw new DuplicateIdentityError(input.identity);
      }
      throw e;
    }
    return this.findById(id)!;
  }

  findById(id: string): Skill | null {
    const row = this.db
      .prepare('SELECT * FROM skills WHERE id = ?')
      .get(id) as SkillRow | undefined;
    return row ? parseSkillRow(row) : null;
  }

  findByIdentity(identity: string): Skill | null {
    const row = this.db
      .prepare('SELECT * FROM skills WHERE identity = ?')
      .get(identity) as SkillRow | undefined;
    return row ? parseSkillRow(row) : null;
  }

  list(filter?: { status?: SkillStatus; origin?: string }): Skill[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter?.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter?.origin) {
      where.push('origin = ?');
      params.push(filter.origin);
    }
    const sql =
      where.length > 0
        ? `SELECT * FROM skills WHERE ${where.join(' AND ')} ORDER BY identity ASC`
        : 'SELECT * FROM skills ORDER BY identity ASC';
    const rows = this.db.prepare(sql).all(...params) as SkillRow[];
    return rows.map(parseSkillRow);
  }

  update(skill: Skill): void {
    const now = nowISO();
    this.db
      .prepare(
        `UPDATE skills SET
           identity = ?,
           purpose = ?,
           trigger = ?,
           prerequisites_json = ?,
           procedure = ?,
           tools_required_json = ?,
           expected_result = ?,
           verification = ?,
           pitfalls_json = ?,
           evidence = ?,
           version = ?,
           confidence = ?,
           success_rate = ?,
           origin = ?,
           last_validated = ?,
           regression_tests = ?,
           status = ?,
           updated_at = ?,
           invocations = ?,
           successes = ?,
           failures = ?
         WHERE id = ?`,
      )
      .run(
        skill.identity,
        skill.purpose,
        skill.trigger,
        JSON.stringify(skill.prerequisites),
        skill.procedure,
        JSON.stringify(skill.tools_required),
        skill.expected_result,
        skill.verification,
        JSON.stringify(skill.pitfalls),
        skill.evidence,
        skill.version,
        skill.confidence,
        skill.success_rate,
        skill.origin,
        skill.last_validated,
        skill.regression_tests ?? null,
        skill.status,
        now,
        skill.invocations,
        skill.successes,
        skill.failures,
        skill.id,
      );
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM skills WHERE id = ?').run(id);
    // Cascade-clear invocations so the foreign key stays clean even if
    // foreign_keys pragma is OFF (defensive — better-sqlite3 has it ON by
    // default in ChismosoDB but tests / external readers may not).
    this.db
      .prepare('DELETE FROM skill_invocations WHERE skill_id = ?')
      .run(id);
  }

  // -------------------------------------------------------------------------
  // LIFECYCLE TRANSITIONS (spec §27)
  // -------------------------------------------------------------------------

  /**
   * Transition a skill between lifecycle states. Enforces the linear graph
   * defined in `ALLOWED_TRANSITIONS`:
   *
   *   PROPOSED → VALIDATING → ACTIVE → DEPRECATED → RETIRED
   *
   * Forbidden transitions throw `InvalidTransitionError`. The two special
   * cases the spec calls out:
   *
   *   - PROPOSED → ACTIVE  (must go via VALIDATING — the whole point of the
   *     lifecycle is to forbid unvalidated skills from going live)
   *   - RETIRED → *       (terminal — once retired, a skill cannot be
   *     re-activated; bump version and create a NEW skill instead)
   *
   * Side effects:
   *   - VALIDATING → ACTIVE also stamps `last_validated` with the current
   *     ISO timestamp, so the catalog surface records when the last
   *     validation pass completed.
   */
  transition(id: string, newStatus: SkillStatus): Skill {
    const current = this.findById(id);
    if (!current) throw new SkillNotFoundError(id);

    const from = current.status as SkillStatus;
    if (from === newStatus) return current; // no-op

    if (!isAllowedTransition(from, newStatus)) {
      throw new InvalidTransitionError(from, newStatus);
    }

    const now = nowISO();
    const updates: string[] = ['status = ?', 'updated_at = ?'];
    const params: (string | null)[] = [newStatus, now];

    // Stamp last_validated when the skill leaves the VALIDATING state —
    // this is the moment the operator says "validation passed".
    if (from === SkillStatus.VALIDATING && newStatus === SkillStatus.ACTIVE) {
      updates.push('last_validated = ?');
      params.push(now);
    }

    params.push(id);
    this.db
      .prepare(`UPDATE skills SET ${updates.join(', ')} WHERE id = ?`)
      .run(...params);

    return this.findById(id)!;
  }

  // -------------------------------------------------------------------------
  // INVOCATIONS (spec §28 — execution + feedback)
  // -------------------------------------------------------------------------

  recordInvocation(input: SkillInvocationInput): SkillInvocation {
    const id = generateInvocationId();
    this.db
      .prepare(
        `INSERT INTO skill_invocations (
           id, skill_id, investigation_id, invoked_at, completed_at,
           status, inputs_json, outputs_json, error, feedback
         ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.skill_id,
        input.investigation_id ?? null,
        input.invoked_at,
        input.completed_at ?? null,
        input.status,
        JSON.stringify(input.inputs ?? {}),
        input.outputs ? JSON.stringify(input.outputs) : null,
        input.error ?? null,
        input.feedback ?? null,
      );
    // Bump the skill.invocations counter (only for 'running' starts —
    // already-completed invocations inserted in one shot still count).
    this.db
      .prepare('UPDATE skills SET invocations = invocations + 1, updated_at = ? WHERE id = ?')
      .run(nowISO(), input.skill_id);
    return this.findInvocation(id)!;
  }

  /**
   * Mark a previously-recorded invocation as completed (success/failure/timeout).
   *
   * Side effects:
   *   - Stamps `completed_at` with the current ISO timestamp.
   *   - Bumps `successes` or `failures` counter on the parent skill.
   *   - Calls `recomputeStats(id)` so `success_rate` reflects the new run.
   *
   * The `running` status is NOT a valid completion target — passing it here
   * throws. Use `recordInvocation()` to START a running invocation.
   */
  completeInvocation(
    id: string,
    status: InvocationStatus,
    outputs?: Record<string, unknown>,
    error?: string,
  ): void {
    const inv = this.findInvocation(id);
    if (!inv) throw new InvocationNotFoundError(id);
    if (status === 'running') {
      throw new Error('completeInvocation does not accept "running" status');
    }
    const now = nowISO();
    this.db
      .prepare(
        `UPDATE skill_invocations SET
           completed_at = ?,
           status = ?,
           outputs_json = ?,
           error = ?
         WHERE id = ?`,
      )
      .run(
        now,
        status,
        outputs ? JSON.stringify(outputs) : null,
        error ?? null,
        id,
      );

    // Bump the parent skill's success/failure counter.
    if (status === 'success') {
      this.db
        .prepare('UPDATE skills SET successes = successes + 1 WHERE id = ?')
        .run(inv.skill_id);
    } else {
      // 'failure' and 'timeout' both count against `failures` — a timeout is
      // a failure mode from the operator's perspective (no useful result).
      this.db
        .prepare('UPDATE skills SET failures = failures + 1 WHERE id = ?')
        .run(inv.skill_id);
    }

    // Recompute success_rate so the parent reflects the new run. Done in a
    // separate query (not derived from the bump above) so we can never
    // drift even if a row was inserted out-of-band by a parallel process.
    this.recomputeStats(inv.skill_id);
  }

  /**
   * Record operator feedback on a completed invocation. Feedback is
   * SEPARATE from success_rate: a skill can succeed technically (returns
   * 200, exits cleanly) while being useless to the operator (wrong scope,
   * wrong timing). Both metrics are tracked independently per spec §28.
   *
   * This method does NOT modify success_rate — only the `feedback` column
   * of the invocation row.
   */
  recordFeedback(
    invocationId: string,
    feedback: InvocationFeedback,
  ): void {
    const inv = this.findInvocation(invocationId);
    if (!inv) throw new InvocationNotFoundError(invocationId);
    this.db
      .prepare('UPDATE skill_invocations SET feedback = ? WHERE id = ?')
      .run(feedback, invocationId);
  }

  findInvocation(id: string): SkillInvocation | null {
    const row = this.db
      .prepare('SELECT * FROM skill_invocations WHERE id = ?')
      .get(id) as SkillInvocationRow | undefined;
    return row ? parseInvocationRow(row) : null;
  }

  listInvocations(
    skillId: string,
    opts?: { limit?: number; status?: InvocationStatus },
  ): SkillInvocation[] {
    const limit = opts?.limit ?? 50;
    const where: string[] = ['skill_id = ?'];
    const params: (string | number)[] = [skillId];
    if (opts?.status) {
      where.push('status = ?');
      params.push(opts.status);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM skill_invocations WHERE ${where.join(' AND ')}
         ORDER BY invoked_at DESC LIMIT ?`,
      )
      .all(...params, limit) as SkillInvocationRow[];
    return rows.map(parseInvocationRow);
  }

  // -------------------------------------------------------------------------
  // STATS
  // -------------------------------------------------------------------------

  /**
   * Recompute `success_rate`, `invocations`, `successes`, `failures` from
   * the actual invocation rows. Useful when the skills table has drifted
   * out of sync (e.g. invocations inserted by a parallel process, or a
   * migration backfill).
   *
   * Formula: success_rate = successes / invocations  (0 when invocations=0)
   *
   * Note: `invocations` here counts EVERY invocation row, including those
   * that are still 'running' (started but not completed). The success_rate
   * denominator is therefore "every attempt", not "every completed run" —
   * this matches the spec §28 example: 10 invocations, 7 successes, 3
   * failures -> success_rate = 0.7.
   */
  recomputeStats(id: string): void {
    const stats = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS successes,
           COALESCE(SUM(CASE WHEN status IN ('failure','timeout') THEN 1 ELSE 0 END), 0) AS failures
         FROM skill_invocations WHERE skill_id = ?`,
      )
      .get(id) as { total: number; successes: number; failures: number };

    const total = stats?.total ?? 0;
    const succ = stats?.successes ?? 0;
    const fail = stats?.failures ?? 0;
    // success_rate = successes / total. The denominator includes 'running'
    // invocations — but since `recomputeStats` is called from
    // `completeInvocation` AFTER the status update, the 'running' count
    // has already been decremented by the bump. For test 10/7/3 the formula
    // gives 7/10 = 0.7.
    const rate = total > 0 ? succ / total : 0;
    this.db
      .prepare(
        `UPDATE skills SET
           invocations = ?,
           successes = ?,
           failures = ?,
           success_rate = ?,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(total, succ, fail, rate, nowISO(), id);
  }
}

// ---------------------------------------------------------------------------
// Row parsers (pure functions — no DB access)
// ---------------------------------------------------------------------------

function parseSkillRow(r: SkillRow): Skill {
  return {
    id: r.id,
    identity: r.identity,
    purpose: r.purpose,
    trigger: r.trigger ?? '',
    prerequisites: r.prerequisites_json ? JSON.parse(r.prerequisites_json) : [],
    procedure: r.procedure ?? '',
    tools_required: r.tools_required_json ? JSON.parse(r.tools_required_json) : [],
    expected_result: r.expected_result ?? '',
    verification: r.verification ?? '',
    pitfalls: r.pitfalls_json ? JSON.parse(r.pitfalls_json) : [],
    evidence: r.evidence ?? '',
    version: r.version,
    confidence: r.confidence,
    success_rate: r.success_rate,
    origin: r.origin as Skill['origin'],
    last_validated: r.last_validated,
    regression_tests: r.regression_tests,
    status: r.status as SkillStatus,
    created_at: r.created_at,
    updated_at: r.updated_at,
    invocations: r.invocations,
    successes: r.successes,
    failures: r.failures,
  };
}

function parseInvocationRow(r: SkillInvocationRow): SkillInvocation {
  return {
    id: r.id,
    skill_id: r.skill_id,
    investigation_id: r.investigation_id ?? undefined,
    invoked_at: r.invoked_at,
    completed_at: r.completed_at ?? undefined,
    status: r.status as SkillInvocation['status'],
    inputs: r.inputs_json ? JSON.parse(r.inputs_json) : {},
    outputs: r.outputs_json ? JSON.parse(r.outputs_json) : undefined,
    error: r.error ?? undefined,
    feedback: r.feedback ? (r.feedback as InvocationFeedback) : null,
  };
}
