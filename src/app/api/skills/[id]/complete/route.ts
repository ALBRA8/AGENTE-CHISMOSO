import { NextRequest } from 'next/server';
import type { Database as DB } from 'better-sqlite3';
import { apiBadRequest, apiNotFound, apiOk, apiServerError } from '@/lib/api-response';
import { authedPOST } from '@/lib/middleware';
import { openSkillsDb } from '../../route';
import { SkillsCatalog } from '../../../../../../chismoso/dist/skills/index.js';
import type { ChismosoDB } from '../../../../../../chismoso/dist/db.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_COMPLETION_STATUSES = ['success', 'failure', 'timeout'] as const;
type CompletionStatus = (typeof VALID_COMPLETION_STATUSES)[number];

/**
 * POST /api/skills/[id]/complete
 *
 * Mark a previously-recorded invocation as completed. Bumps the skill's
 * success/failure counter and recomputes `success_rate` from the
 * invocation history (successes / total). The skill `id` in the URL
 * identifies the parent skill; the specific invocation is identified by
 * `invocation_id` in the JSON body.
 *
 * The `id` URL segment accepts either the skill's UUID OR its `identity`
 * slug (e.g. `signal_discovery`) — same convention as the other sub-routes.
 *
 * Body:
 *   {
 *     invocation_id: string,                 // required — the id returned by /invoke
 *     status: 'success' | 'failure' | 'timeout',
 *     outputs?: Record<string, unknown>,     // default null
 *     error?: string                         // default null
 *   }
 *
 * Response (200):
 *   { ok: true, invocation: SkillInvocation, skill: Skill }
 *   // both `invocation` and `skill` are refreshed from DB after the update,
 *   // so the caller sees the recomputed success_rate without a second GET.
 *
 * Errors:
 *   400  Missing invocation_id / invalid status / invocation-skill mismatch
 *   404  Skill or invocation not found
 *
 * §34 / audit C2 — Protected by `authedPOST`: completing an invocation
 * mutates the skill's success_rate and counters (operator-affecting metric).
 */
export const POST = authedPOST(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  if (!id) {
    return apiBadRequest('Missing skill id', { code: 'missing_id' });
  }

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

  const invocationId = typeof body.invocation_id === 'string' ? body.invocation_id : '';
  if (!invocationId) {
    return apiBadRequest('Field "invocation_id" is required', {
      code: 'missing_invocation_id',
    });
  }

  const status = typeof body.status === 'string' ? body.status : '';
  if (!VALID_COMPLETION_STATUSES.includes(status as CompletionStatus)) {
    return apiBadRequest(
      'Field "status" must be one of: success, failure, timeout',
      { got: status || null },
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

    const inv = catalog.repo.findInvocation(invocationId);
    if (!inv) {
      return apiNotFound(`Skill invocation not found: ${invocationId}`);
    }
    // Defensive: the invocation must belong to the skill in the URL —
    // mismatched pairs indicate a caller bug. Return 400 rather than
    // silently completing the wrong skill's invocation.
    if (inv.skill_id !== skill.id) {
      return apiBadRequest(
        `Invocation ${invocationId} does not belong to skill ${id}`,
        {
          code: 'invocation_skill_mismatch',
          invocation_skill_id: inv.skill_id,
          url_skill_id: skill.id,
        },
      );
    }

    catalog.completeInvocation(
      invocationId,
      status as CompletionStatus,
      body.outputs,
      body.error,
    );
    const refreshedInv = catalog.repo.findInvocation(invocationId)!;
    const refreshedSkill = catalog.findById(skill.id);
    return apiOk({ ok: true, invocation: refreshedInv, skill: refreshedSkill });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('skills_complete_failed', { message });
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
});
