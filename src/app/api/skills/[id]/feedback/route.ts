import { NextRequest } from 'next/server';
import type { Database as DB } from 'better-sqlite3';
import { apiBadRequest, apiNotFound, apiOk, apiServerError } from '@/lib/api-response';
import { authedPOST } from '@/lib/middleware';
import { openSkillsDb } from '../../route';
import { SkillsCatalog } from '../../../../../../chismoso/dist/skills/index.js';
import type { ChismosoDB } from '../../../../../../chismoso/dist/db.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_FEEDBACK = ['useful', 'useless'] as const;
type FeedbackValue = (typeof VALID_FEEDBACK)[number];

/**
 * POST /api/skills/[id]/feedback
 *
 * Record operator feedback on a completed invocation. Feedback is a
 * SEPARATE metric from `success_rate`: a skill can succeed technically
 * (returns 200, exits cleanly) while being useless to the operator
 * (wrong scope, wrong timing). Both are tracked independently per spec §28.
 *
 * This endpoint does NOT modify `success_rate` — only the `feedback`
 * column of the invocation row. The skill `id` in the URL identifies the
 * parent skill; the specific invocation is identified by `invocation_id`
 * in the JSON body.
 *
 * The `id` URL segment accepts either the skill's UUID OR its `identity`
 * slug (e.g. `signal_discovery`) — same convention as the other sub-routes.
 *
 * Body:
 *   {
 *     invocation_id: string,         // required — the id returned by /invoke
 *     feedback: 'useful' | 'useless'
 *   }
 *
 * Response (200):
 *   { ok: true, invocation: SkillInvocation }   // with feedback stamped
 *
 * Errors:
 *   400  Missing invocation_id / invalid feedback / invocation-skill mismatch
 *   404  Skill or invocation not found
 *
 * §34 / audit C2 — Protected by `authedPOST`: feedback mutates the
 * invocation row and feeds the self-improvement loop (skill retirement
 * decisions), so anonymous callers must not be able to stamp feedback.
 */
export const POST = authedPOST(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  if (!id) {
    return apiBadRequest('Missing skill id', { code: 'missing_id' });
  }

  let body: { invocation_id?: string; feedback?: string };
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

  const feedbackRaw = typeof body.feedback === 'string' ? body.feedback : '';
  if (!VALID_FEEDBACK.includes(feedbackRaw as FeedbackValue)) {
    return apiBadRequest('Field "feedback" must be one of: useful, useless', {
      got: feedbackRaw || null,
    });
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
    // silently stamping feedback on the wrong skill's invocation.
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

    catalog.recordFeedback(invocationId, feedbackRaw as FeedbackValue);
    return apiOk({
      ok: true,
      invocation: catalog.repo.findInvocation(invocationId)!,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('skills_feedback_failed', { message });
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
});
