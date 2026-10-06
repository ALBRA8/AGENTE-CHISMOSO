import { NextRequest } from 'next/server';
import type { Database as DB } from 'better-sqlite3';
import { apiBadRequest, apiNotFound, apiOk, apiServerError } from '@/lib/api-response';
import { authedPOST } from '@/lib/middleware';
import { openSkillsDb } from '../../route';
import { SkillsCatalog } from '../../../../../../chismoso/dist/skills/index.js';
import type { ChismosoDB } from '../../../../../../chismoso/dist/db.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/skills/[id]/invoke
 *
 * Record the START of a skill invocation. The skill MUST be ACTIVE —
 * PROPOSED / VALIDATING / DEPRECATED / RETIRED all refuse (the lifecycle
 * rule that says "unvalidated skills cannot be invoked" is enforced by
 * `SkillsCatalog.startInvocation()`).
 *
 * The `id` URL segment accepts either the skill's UUID (`skill_<base36>`)
 * OR its unique `identity` slug (e.g. `signal_discovery`) — whichever the
 * caller has on hand.
 *
 * Body:
 *   {
 *     inputs?: Record<string, unknown>,     // default {}
 *     investigation_id?: string             // default null (no linked inv.)
 *   }
 *
 * Response (201 Created):
 *   { invocation: SkillInvocation }   // includes the new invocation id
 *
 * Errors:
 *   400  Skill is not ACTIVE / invalid body
 *   404  Skill not found
 *
 * §34 / audit C2 — Protected by `authedPOST`: skill invocation can trigger
 * side effects (web_search, deepen_content, MCP tool calls), so anonymous
 * callers must not be able to invoke them.
 */
export const POST = authedPOST(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  if (!id) {
    return apiBadRequest('Missing skill id', { code: 'missing_id' });
  }

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
  const investigationId =
    body.investigation_id && typeof body.investigation_id === 'string'
      ? body.investigation_id
      : undefined;

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

    // startInvocation refuses non-ACTIVE skills with a thrown Error —
    // surface that as a 400 to the caller.
    const invocation = catalog.startInvocation(skill.id, inputs, investigationId);
    return apiOk({ invocation }, 201);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes('cannot be invoked')) {
      return apiBadRequest(message, {
        code: 'skill_not_invocable',
      });
    }
    return apiServerError('skills_invoke_failed', { message });
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
});
