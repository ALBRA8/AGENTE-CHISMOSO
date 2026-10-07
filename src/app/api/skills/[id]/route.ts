import { NextRequest } from 'next/server';
import type { Database as DB } from 'better-sqlite3';
import { apiBadRequest, apiNotFound, apiOk, apiServerError } from '@/lib/api-response';
import { authedPOST, authedPATCH } from '@/lib/middleware';
import { openSkillsDb } from '../route';
import { SkillsCatalog, SkillStatus } from '../../../../../chismoso/dist/skills/index.js';
import type { ChismosoDB } from '../../../../../chismoso/dist/db.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/skills/[id]
 *
 * Returns the full skill record plus the 20 most recent invocations. The
 * `id` URL segment accepts either the skill's UUID (`skill_<base36>`) OR
 * its unique `identity` slug (e.g. `signal_discovery`) — whichever the
 * caller has on hand.
 *
 * Response shape:
 *   {
 *     skill: Skill,
 *     recentInvocations: SkillInvocation[]   // 20 most recent, newest first
 *   }
 *
 * Errors:
 *   404  Skill not found
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) {
    return apiBadRequest('Missing skill id', { code: 'missing_id' });
  }

  let db: DB | null = null;
  try {
    db = openSkillsDb();
    const catalog = new SkillsCatalog(
      db as unknown as ChismosoDB,
    );
    const skill = catalog.findByIdentity(id) ?? catalog.findById(id);
    if (!skill) {
      return apiNotFound(`Skill not found: ${id}`);
    }
    const recentInvocations = catalog.recentInvocations(skill.id, 20);
    return apiOk({ skill, recentInvocations });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('skills_get_failed', { message });
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}

/**
 * PATCH /api/skills/[id]
 *
 * Update editable fields of a skill. The `id` segment accepts either the
 * skill UUID or its identity slug (same as GET).
 *
 * Updatable fields (any subset):
 *   purpose, trigger, prerequisites, procedure, tools_required,
 *   expected_result, verification, pitfalls, evidence, version,
 *   confidence, regression_tests
 *
 * NOT updatable (managed by the lifecycle verbs + invocation recorder):
 *   id, identity, status, origin, last_validated, created_at, updated_at,
 *   invocations, successes, failures, success_rate
 *
 * Response shape:
 *   { skill: Skill }  // the updated record
 *
 * Errors:
 *   400  Tried to update a non-updatable field
 *   404  Skill not found
 *
 * §34 / audit C2 — Protected by `authedPATCH`: skill updates mutate the
 * skills catalog (potentially activating or retiring a skill).
 */
export const PATCH = authedPATCH(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  if (!id) {
    return apiBadRequest('Missing skill id', { code: 'missing_id' });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return apiBadRequest('Invalid JSON body', { code: 'invalid_json' });
  }

  const IMMUTABLE = new Set([
    'id',
    'identity',
    'status',
    'origin',
    'last_validated',
    'created_at',
    'updated_at',
    'invocations',
    'successes',
    'failures',
    'success_rate',
  ]);
  const illegal = Object.keys(body).filter((k) => IMMUTABLE.has(k));
  if (illegal.length > 0) {
    return apiBadRequest(
      `Cannot PATCH immutable fields: ${illegal.join(', ')}. ` +
        `Use POST /api/skills/[id]/invoke, POST /api/skills/[id]/complete, ` +
        `POST /api/skills/[id]/feedback, or the lifecycle CLI verbs instead.`,
      { illegal_fields: illegal },
    );
  }

  let db: DB | null = null;
  try {
    db = openSkillsDb();
    const catalog = new SkillsCatalog(
      db as unknown as ChismosoDB,
    );
    const skill = catalog.findByIdentity(id) ?? catalog.findById(id);
    if (!skill) {
      return apiNotFound(`Skill not found: ${id}`);
    }

    // Apply patch field-by-field. Skip unknown fields silently (forward
    // compat: if a future caller sends a field the API doesn't know about,
    // we ignore it rather than erroring — PATCH semantics).
    if (typeof body.purpose === 'string') skill.purpose = body.purpose;
    if (typeof body.trigger === 'string') skill.trigger = body.trigger;
    if (Array.isArray(body.prerequisites)) {
      skill.prerequisites = body.prerequisites.filter(
        (x): x is string => typeof x === 'string',
      );
    }
    if (typeof body.procedure === 'string') skill.procedure = body.procedure;
    if (Array.isArray(body.tools_required)) {
      skill.tools_required = body.tools_required.filter(
        (x): x is string => typeof x === 'string',
      );
    }
    if (typeof body.expected_result === 'string')
      skill.expected_result = body.expected_result;
    if (typeof body.verification === 'string')
      skill.verification = body.verification;
    if (Array.isArray(body.pitfalls)) {
      skill.pitfalls = body.pitfalls.filter(
        (x): x is string => typeof x === 'string',
      );
    }
    if (typeof body.evidence === 'string') skill.evidence = body.evidence;
    if (typeof body.version === 'string') skill.version = body.version;
    if (typeof body.confidence === 'number' && Number.isFinite(body.confidence)) {
      skill.confidence = Math.max(0, Math.min(1, body.confidence));
    }
    if (typeof body.regression_tests === 'string' || body.regression_tests === null) {
      skill.regression_tests = body.regression_tests as string | null;
    }

    catalog.repo.update(skill);
    return apiOk({ skill: catalog.findById(skill.id) });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('skills_update_failed', { message });
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
});

/**
 * POST /api/skills/[id]/invoke
 *
 * Record the START of an invocation. The skill MUST be ACTIVE —
 * PROPOSED / VALIDATING / DEPRECATED / RETIRED all refuse (the lifecycle
 * rule that says "unvalidated skills cannot be invoked" is enforced here).
 *
 * Body:
 *   {
 *     inputs?: Record<string, unknown>,     // default {}
 *     investigation_id?: string             // default null (no linked inv.)
 *   }
 *
 * Response (201):
 *   {
 *     invocation: SkillInvocation            // includes the new invocation id
 *   }
 *
 * Errors:
 *   400  Skill is not ACTIVE
 *   404  Skill not found
 */
async function invoke(
  req: NextRequest,
  catalog: SkillsCatalog,
  skillId: string,
) {
  let body: { inputs?: Record<string, unknown>; investigation_id?: string };
  try {
    body = (await req.json()) as { inputs?: Record<string, unknown>; investigation_id?: string };
  } catch {
    body = {};
  }
  const inputs =
    body.inputs && typeof body.inputs === 'object' && !Array.isArray(body.inputs)
      ? (body.inputs as Record<string, unknown>)
      : {};
  const inv = catalog.startInvocation(
    skillId,
    inputs,
    body.investigation_id && typeof body.investigation_id === 'string'
      ? body.investigation_id
      : undefined,
  );
  return apiOk({ invocation: inv }, 201);
}

/**
 * POST /api/skills/[id]/complete
 *
 * Mark a previously-recorded invocation as completed. Bumps the skill's
 * success/failure counter and recomputes success_rate.
 *
 * Body:
 *   {
 *     invocation_id: string,                 // required
 *     status: 'success' | 'failure' | 'timeout',
 *     outputs?: Record<string, unknown>,
 *     error?: string
 *   }
 *
 * Response (200):
 *   { ok: true, invocation: SkillInvocation, skill: Skill }   // both refreshed
 *
 * Errors:
 *   400  Missing invocation_id / invalid status
 *   404  Invocation or skill not found
 */
async function complete(
  req: NextRequest,
  catalog: SkillsCatalog,
  _skillId: string,
) {
  let body: {
    invocation_id?: string;
    status?: string;
    outputs?: Record<string, unknown>;
    error?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  const invId = typeof body.invocation_id === 'string' ? body.invocation_id : '';
  const status = typeof body.status === 'string' ? body.status : '';
  if (!invId) {
    return apiBadRequest('Field "invocation_id" is required', {
      code: 'missing_invocation_id',
    });
  }
  if (!['success', 'failure', 'timeout'].includes(status)) {
    return apiBadRequest('Field "status" must be one of: success, failure, timeout', {
      got: status || null,
    });
  }

  const inv = catalog.repo.findInvocation(invId);
  if (!inv) {
    return apiNotFound(`Skill invocation not found: ${invId}`);
  }

  catalog.completeInvocation(
    invId,
    status as 'success' | 'failure' | 'timeout',
    body.outputs,
    body.error,
  );
  const refreshedInv = catalog.repo.findInvocation(invId)!;
  const refreshedSkill = catalog.findById(refreshedInv.skill_id);
  return apiOk({ ok: true, invocation: refreshedInv, skill: refreshedSkill });
}

/**
 * POST /api/skills/[id]/feedback
 *
 * Record operator feedback on an invocation. Independent metric from
 * success_rate — a skill can succeed technically (returns 200, exits
 * cleanly) while being useless to the operator (wrong scope, wrong
 * timing). Both are tracked.
 *
 * Body:
 *   {
 *     invocation_id: string,         // required
 *     feedback: 'useful' | 'useless'
 *   }
 *
 * Response (200):
 *   { ok: true, invocation: SkillInvocation }   // with feedback stamped
 *
 * Errors:
 *   400  Missing invocation_id / invalid feedback
 *   404  Invocation not found
 */
async function feedback(
  req: NextRequest,
  catalog: SkillsCatalog,
  _skillId: string,
) {
  let body: { invocation_id?: string; feedback?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  const invId = typeof body.invocation_id === 'string' ? body.invocation_id : '';
  const fb = typeof body.feedback === 'string' ? body.feedback : '';
  if (!invId) {
    return apiBadRequest('Field "invocation_id" is required', {
      code: 'missing_invocation_id',
    });
  }
  if (!['useful', 'useless'].includes(fb)) {
    return apiBadRequest('Field "feedback" must be one of: useful, useless', {
      got: fb || null,
    });
  }

  const inv = catalog.repo.findInvocation(invId);
  if (!inv) {
    return apiNotFound(`Skill invocation not found: ${invId}`);
  }
  catalog.recordFeedback(invId, fb as 'useful' | 'useless');
  return apiOk({
    ok: true,
    invocation: catalog.repo.findInvocation(invId)!,
  });
}

/**
 * POST /api/skills/[id]
 *
 * Action dispatcher for invocation-related endpoints. The action is
 * specified by the `?action=` query parameter (or a `action` field in the
 * JSON body — query wins). This keeps the route surface tiny while
 * supporting the three sub-actions the spec calls out:
 *
 *   POST /api/skills/[id]?action=invoke      Start an invocation
 *   POST /api/skills/[id]?action=complete    Mark an invocation completed
 *   POST /api/skills/[id]?action=feedback    Record operator feedback
 *
 * Default action (no `?action=`) is `invoke`.
 *
 * §34 / audit C2 — Protected by `authedPOST`: skill invocation can trigger
 * side effects (web_search, deepen_content, MCP tool calls). Feedback
 * mutates the skill's success_rate.
 */
export const POST = authedPOST(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  if (!id) {
    return apiBadRequest('Missing skill id', { code: 'missing_id' });
  }

  const url = new URL(req.url);
  let action = url.searchParams.get('action');
  if (!action) {
    // Fall back to a JSON body field for callers that prefer not to put
    // the action in the URL. Either form works.
    try {
      const peek = (await req.clone().json()) as { action?: string };
      if (typeof peek.action === 'string') action = peek.action;
    } catch {
      /* body was not JSON — leave action undefined, default below */
    }
  }
  if (!action) action = 'invoke';
  if (!['invoke', 'complete', 'feedback'].includes(action)) {
    return apiBadRequest(
      `Invalid ?action=${action}. Must be one of: invoke, complete, feedback.`,
      { code: 'invalid_action' },
    );
  }

  let db: DB | null = null;
  try {
    db = openSkillsDb();
    const catalog = new SkillsCatalog(
      db as unknown as ChismosoDB,
    );
    const skill = catalog.findByIdentity(id) ?? catalog.findById(id);
    if (!skill) {
      return apiNotFound(`Skill not found: ${id}`);
    }

    if (action === 'invoke') {
      // startInvocation refuses non-ACTIVE skills with a thrown Error —
      // surface that as a 400 to the caller.
      try {
        return await invoke(req, catalog, skill.id);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        if (message.includes('cannot be invoked')) {
          return apiBadRequest(message, {
            code: 'skill_not_invocable',
            status: skill.status,
          });
        }
        throw e;
      }
    }
    if (action === 'complete') {
      return await complete(req, catalog, skill.id);
    }
    // action === 'feedback'
    return await feedback(req, catalog, skill.id);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('skills_action_failed', { message, action });
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
});

/**
 * Re-export SkillStatus so consumers that import the route file (e.g. tests)
 * have access to the lifecycle enum without a second import.
 *
 * IMP-4 note: uses `export ... from` re-export form (not a local-binding
 * re-export) because Turbopack's SWC parser rejects `export { X };` after
 * a function-expression assignment (treats it as a stray token in an arg
 * list — see IMP-4 worklog).
 * IMP-2 note: fixed the re-export path (was 4 `../`, needs 5 to reach
 * /home/z/my-project/chismoso/dist from src/app/api/skills/[id]/route.ts).
 */
export { SkillStatus } from '../../../../../chismoso/dist/skills/index.js';
