/**
 * CHISMOSO V1.4 — Skills Catalog (spec §26, §27)
 *
 * High-level surface on top of `SkillRepository`. Exposes the lifecycle
 * verbs the spec calls out — `proposeSkill`, `validateSkill`,
 * `deprecateSkill`, `retireSkill` — and the `seedBuiltins()` bootstrap.
 *
 * The repository layer enforces the transition graph itself; this catalog
 * adds the multi-step "validate" flow (PROPOSED -> VALIDATING -> ACTIVE in
 * a single call) and a few conveniences (lookup-by-identity before
 * transition, idempotent seeding).
 *
 * The orchestrator / planner / CLI import from here rather than from
 * `repository.ts` so that the lifecycle rules live in ONE place.
 */

import type { ChismosoDB } from '../db.js';
import { logger } from '../logger.js';
import {
  SkillRepository,
  SkillNotFoundError,
} from './repository.js';
import { BUILTIN_SKILLS } from './builtins.js';
import {
  SkillStatus,
  type Skill,
  type SkillInput,
  type SkillInvocation,
  type SkillInvocationInput,
  type InvocationStatus,
  type InvocationFeedback,
} from './models.js';

// Re-export the types and enums the orchestrator / CLI need so they can
// import from a single module surface.
export {
  SkillStatus,
  type Skill,
  type SkillInput,
  type SkillInvocation,
  type SkillInvocationInput,
  type InvocationStatus,
  type InvocationFeedback,
};
export {
  SkillRepository,
  SkillNotFoundError,
  InvalidTransitionError,
  DuplicateIdentityError,
  InvocationNotFoundError,
} from './repository.js';
export { BUILTIN_SKILLS, BUILTIN_SKILL_IDENTITIES } from './builtins.js';

export class SkillsCatalog {
  readonly repo: SkillRepository;

  constructor(db: ChismosoDB) {
    this.repo = new SkillRepository(db);
  }

  // -------------------------------------------------------------------------
  // LIFECYCLE VERBS (spec §27)
  // -------------------------------------------------------------------------

  /**
   * Propose a new skill. Inserted in PROPOSED status. Cannot be invoked
   * until validate(identity) advances it through VALIDATING to ACTIVE.
   *
   * Throws DuplicateIdentityError if `identity` is already taken (any
   * status — including RETIRED — counts as taken; bump version instead
   * of resurfacing a retired identity).
   */
  propose(input: SkillInput): Skill {
    // Force the status to PROPOSED regardless of what the caller supplied
    // — the only way to enter ACTIVE is via validate().
    return this.repo.insert({ ...input, status: SkillStatus.PROPOSED });
  }

  /**
   * Validate a PROPOSED skill: PROPOSED -> VALIDATING -> ACTIVE.
   *
   * The two-step transition is what the spec calls "validation". The
   * actual regression run is the operator's responsibility (or that of
   * the orchestrator's self-improvement loop, when wired). This method
   * performs the state transitions and stamps `last_validated`.
   *
   * Accepts either the `identity` (string) or the `id` (uuid). We look up
   * by identity first and fall back to id, so callers don't need to know
   * which they're holding.
   */
  validate(identityOrId: string): Skill {
    const skill = this.resolve(identityOrId);
    if (!skill) throw new SkillNotFoundError(identityOrId);

    // If already ACTIVE / DEPRECATED / RETIRED, validate() is a no-op for
    // ACTIVE and an error for the terminal states. The repo.transition
    // call will throw InvalidTransitionError for DEPRECATED/RETIRED — that's
    // the desired behavior.
    if (skill.status === SkillStatus.ACTIVE) return skill;
    if (skill.status === SkillStatus.PROPOSED) {
      const validating = this.repo.transition(skill.id, SkillStatus.VALIDATING);
      return this.repo.transition(validating.id, SkillStatus.ACTIVE);
    }
    // VALIDATING -> ACTIVE direct hop (operator re-running validate).
    if (skill.status === SkillStatus.VALIDATING) {
      return this.repo.transition(skill.id, SkillStatus.ACTIVE);
    }
    // ACTIVE / DEPRECATED / RETIRED — the transition call will throw the
    // right error.
    return this.repo.transition(skill.id, SkillStatus.ACTIVE);
  }

  /**
   * Deprecate an ACTIVE skill: ACTIVE -> DEPRECATED.
   * Used when a skill is superseded but kept for audit history.
   */
  deprecate(identityOrId: string): Skill {
    const skill = this.resolve(identityOrId);
    if (!skill) throw new SkillNotFoundError(identityOrId);
    return this.repo.transition(skill.id, SkillStatus.DEPRECATED);
  }

  /**
   * Retire a DEPRECATED skill: DEPRECATED -> RETIRED.
   * Terminal state — the skill cannot be re-activated.
   */
  retire(identityOrId: string): Skill {
    const skill = this.resolve(identityOrId);
    if (!skill) throw new SkillNotFoundError(identityOrId);
    return this.repo.transition(skill.id, SkillStatus.RETIRED);
  }

  // -------------------------------------------------------------------------
  // INVOCATION RECORDER (spec §28)
  // -------------------------------------------------------------------------

  /**
   * Record the start of an invocation. Only ACTIVE skills can be invoked —
   * PROPOSED / VALIDATING / DEPRECATED / RETIRED all refuse. The
   * orchestrator is expected to consult `listActive()` first.
   */
  startInvocation(
    identityOrId: string,
    inputs: Record<string, unknown>,
    investigationId?: string,
  ): SkillInvocation {
    const skill = this.resolve(identityOrId);
    if (!skill) throw new SkillNotFoundError(identityOrId);
    if (skill.status !== SkillStatus.ACTIVE) {
      throw new Error(
        `Skill ${skill.identity} cannot be invoked in status ${skill.status}`,
      );
    }
    return this.repo.recordInvocation({
      skill_id: skill.id,
      investigation_id: investigationId,
      invoked_at: new Date().toISOString(),
      status: 'running',
      inputs,
    });
  }

  /**
   * Mark an invocation as success / failure / timeout. Bumps the skill's
   * success/failure counter and recomputes success_rate.
   */
  completeInvocation(
    invocationId: string,
    status: 'success' | 'failure' | 'timeout',
    outputs?: Record<string, unknown>,
    error?: string,
  ): void {
    this.repo.completeInvocation(invocationId, status, outputs, error);
  }

  /**
   * Record operator feedback on an invocation. Independent metric from
   * success_rate — does not modify it.
   */
  recordFeedback(
    invocationId: string,
    feedback: InvocationFeedback,
  ): void {
    this.repo.recordFeedback(invocationId, feedback);
  }

  // -------------------------------------------------------------------------
  // QUERIES
  // -------------------------------------------------------------------------

  findById(id: string): Skill | null {
    return this.repo.findById(id);
  }

  findByIdentity(identity: string): Skill | null {
    return this.repo.findByIdentity(identity);
  }

  list(filter?: { status?: SkillStatus; origin?: string }): Skill[] {
    return this.repo.list(filter);
  }

  /** Convenience: only ACTIVE skills (the invocable set). */
  listActive(): Skill[] {
    return this.repo.list({ status: SkillStatus.ACTIVE });
  }

  recentInvocations(skillId: string, limit = 20): SkillInvocation[] {
    return this.repo.listInvocations(skillId, { limit });
  }

  // -------------------------------------------------------------------------
  // SEEDING
  // -------------------------------------------------------------------------

  /**
   * Idempotently insert every builtin skill. Skills that already exist (by
   * identity) are skipped — we do NOT overwrite an existing skill that an
   * operator may have edited (e.g. tweaked procedure / bumped version).
   *
   * Returns the count of NEW skills inserted (not the total in DB).
   */
  seedBuiltins(): number {
    let inserted = 0;
    for (const def of BUILTIN_SKILLS) {
      const existing = this.repo.findByIdentity(def.identity);
      if (existing) {
        // Skip — never clobber an operator's edits.
        continue;
      }
      try {
        this.repo.insert(def);
        inserted++;
        logger.info('Skill seeded', { identity: def.identity });
      } catch (e) {
        // Duplicate identity between two builtin definitions would land
        // here — log and continue rather than abort the seed.
        logger.warn('Skill seed failed', {
          identity: def.identity,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return inserted;
  }

  // -------------------------------------------------------------------------
  // INTERNAL HELPERS
  // -------------------------------------------------------------------------

  /**
   * Look up a skill by identity OR id. Used by the lifecycle verbs so
   * callers can pass whichever they have on hand (the CLI passes identity,
   * the orchestrator passes id).
   */
  private resolve(identityOrId: string): Skill | null {
    return (
      this.repo.findByIdentity(identityOrId) ??
      this.repo.findById(identityOrId)
    );
  }
}
