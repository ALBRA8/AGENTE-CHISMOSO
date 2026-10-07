/**
 * CHISMOSO V1.4 — Skills model (spec §26, §27, §28)
 *
 * A Skill is a reusable, versioned, measurable capability that the orchestrator
 * can invoke. Skills are NOT tools — a tool is a low-level primitive (search_web,
 * search_community); a skill is a higher-level procedure that *uses* tools to
 * accomplish a goal (e.g. "signal_discovery" runs search_web + search_community
 * + normalizer + clustering).
 *
 * Skills live a full lifecycle (spec §27):
 *
 *   PROPOSED → VALIDATING → ACTIVE → DEPRECATED → RETIRED
 *
 * Every transition is validated. A PROPOSED skill CANNOT be invoked until it
 * passes validation (PROPOSED→VALIDATING→ACTIVE). RETIRED is terminal.
 *
 * Skills record every invocation so that `success_rate` is *measured* from
 * observed runs rather than guessed. Operator feedback (`useful` / `useless`)
 * is a SEPARATE metric from success_rate: a skill can succeed technically
 * (returns 200, exits cleanly) while being useless to the operator (wrong
 * scope, wrong timing).
 *
 * This module owns ONLY the type surface — no SQL, no side effects. The
 * repository (`repository.ts`) owns persistence; the catalog (`registry.ts`)
 * owns lifecycle transitions.
 */

// ---------------------------------------------------------------------------
// SKILL LIFECYCLE (spec §27)
// ---------------------------------------------------------------------------

export enum SkillStatus {
  PROPOSED = 'PROPOSED', // Just created, not yet validated. CANNOT be invoked.
  VALIDATING = 'VALIDATING', // Being tested against regression suite / dry runs.
  ACTIVE = 'ACTIVE', // Live — can be invoked by the orchestrator.
  DEPRECATED = 'DEPRECATED', // Superseded — kept for audit, NOT invoked by default.
  RETIRED = 'RETIRED', // Terminal state. Cannot be re-activated.
}

export const ALL_SKILL_STATUSES: SkillStatus[] = Object.values(SkillStatus);

/**
 * Allowed transitions of the lifecycle state machine (spec §27).
 *
 * The graph is strictly linear:
 *
 *   PROPOSED   → VALIDATING
 *   VALIDATING → ACTIVE
 *   ACTIVE     → DEPRECATED
 *   DEPRECATED → RETIRED
 *
 * Forbidden:
 *   - PROPOSED → ACTIVE     (must go via VALIDATING — this is the whole point)
 *   - RETIRED → *           (terminal — no escape from the graveyard)
 *   - DEPRECATED → ACTIVE   (deprecation is one-way; bump version + revalidate)
 *   - VALIDATING → PROPOSED (one-way forward — fix forward, never roll back)
 *   - ACTIVE → PROPOSED     (likewise)
 */
export const ALLOWED_TRANSITIONS: Record<SkillStatus, SkillStatus[]> = {
  [SkillStatus.PROPOSED]: [SkillStatus.VALIDATING],
  [SkillStatus.VALIDATING]: [SkillStatus.ACTIVE],
  [SkillStatus.ACTIVE]: [SkillStatus.DEPRECATED],
  [SkillStatus.DEPRECATED]: [SkillStatus.RETIRED],
  [SkillStatus.RETIRED]: [], // terminal
};

// ---------------------------------------------------------------------------
// SKILL ORIGIN
// ---------------------------------------------------------------------------

export type SkillOrigin = 'builtin' | 'learned' | 'imported';

// ---------------------------------------------------------------------------
// SKILL (spec §26 — full field list)
// ---------------------------------------------------------------------------

export interface Skill {
  id: string;
  identity: string; // unique name e.g. "restaurant_trend_detection"
  purpose: string; // what it does (1 sentence)
  trigger: string; // when to invoke (condition / situation)
  prerequisites: string[]; // required prior skills/data (by identity)
  procedure: string; // step-by-step description (markdown)
  tools_required: string[]; // tool names that this skill depends on
  expected_result: string; // what should happen (success criteria)
  verification: string; // how to verify it worked (regression recipe)
  pitfalls: string[]; // known gotchas / failure modes
  evidence: string; // supporting evidence (rationale, citations)
  version: string; // semver
  confidence: number; // 0..1 — how confident we are in this skill's design
  success_rate: number; // 0..1 — measured from invocations (successes / total)
  origin: SkillOrigin; // 'builtin' | 'learned' | 'imported'
  last_validated: string | null; // ISO timestamp of last VALIDATING→ACTIVE pass
  regression_tests?: string | null; // test file path
  status: SkillStatus;
  created_at: string; // ISO
  updated_at: string; // ISO
  invocations: number; // count of times invoked
  successes: number; // count of times succeeded
  failures: number; // count of times failed (includes timeouts)
}

/**
 * Fields a caller supplies when creating a NEW skill. The repository fills in
 * `id`, `created_at`, `updated_at`, `invocations`, `successes`, `failures`
 * (all derived / generated server-side).
 *
 * `last_validated` is optional — it's stamped by the catalog when the
 * skill transitions VALIDATING -> ACTIVE. Callers proposing a NEW skill
 * should leave it null; builtins that ship ACTIVE may supply a timestamp.
 */
export type SkillInput = Omit<
  Skill,
  | 'id'
  | 'created_at'
  | 'updated_at'
  | 'invocations'
  | 'successes'
  | 'failures'
  | 'success_rate'
  | 'last_validated'
> & {
  last_validated?: string | null;
};

// ---------------------------------------------------------------------------
// SKILL INVOCATION (spec §28 — feedback-capture half)
// ---------------------------------------------------------------------------

export type InvocationStatus = 'running' | 'success' | 'failure' | 'timeout';

export type InvocationFeedback = 'useful' | 'useless';

export interface SkillInvocation {
  id: string;
  skill_id: string;
  investigation_id?: string;
  invoked_at: string; // ISO
  completed_at?: string; // ISO
  status: InvocationStatus;
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  error?: string;
  feedback?: InvocationFeedback | null;
}

/**
 * Fields a caller supplies when recording an invocation start. The repository
 * fills in `id`.
 */
export type SkillInvocationInput = Omit<SkillInvocation, 'id'>;

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/**
 * Generate a prefixed ID. Same shape as `generateId` in models.ts but kept
 * local so the skills module is self-contained (no circular import).
 */
export function generateSkillId(prefix: string = 'skill'): string {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${ts}${rnd}`;
}

export function generateInvocationId(): string {
  return generateSkillId('skinv');
}

export function nowISO(): string {
  return new Date().toISOString();
}

/**
 * Determine whether a transition is legal per the spec §27 state machine.
 */
export function isAllowedTransition(
  from: SkillStatus,
  to: SkillStatus,
): boolean {
  if (from === to) return false; // no-op transitions are not "allowed" — caller should know
  return ALLOWED_TRANSITIONS[from].includes(to);
}
