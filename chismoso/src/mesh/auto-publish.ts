/**
 * CHISMOSO V1.0 — Auto-publish hook (Task EXP-2, FASE-3-QUALITY §3.7)
 *
 * Bridges the orchestrator output to the agent mesh. The orchestrator
 * owns opportunity persistence — we only READ from the opportunities
 * table and call `mesh.publishOpportunity()` for each row. This keeps the
 * orchestrator untouched (no mesh coupling inside orchestrator.ts).
 *
 * Idempotency: `publishOpportunity` skips events that already exist for a
 * given (opportunityId, agentTarget), so calling this multiple times for
 * the same investigation is safe.
 *
 * FASE-3-QUALITY §3.7 — the webhook payload is now the validated
 * OpportunityV1 object (zod schema). When the persisted Opportunity has
 * `metadata.niche/valueProposition/whyNow/risks/leadSearchHints`, those
 * fields are forwarded as the V1 contract; otherwise `toOpportunityV1()`
 * recomputes them. Invalid opportunities (V1 schema parse failure) are
 * logged and skipped — they are NOT published to the mesh, so
 * AGENTE-LEADS never receives a malformed payload.
 */

import type { Repositories } from '../repositories.js';
import type { AgentMesh } from './index.js';
import { logger } from '../logger.js';
import { toOpportunityV1 } from '../intelligence/opportunities.js';
import type { OpportunityV1 } from '../schema/opportunity-v1.js';

/**
 * Loads every Opportunity produced by `investigationId` and publishes each
 * one to the mesh outbox. Returns the number of opportunities published
 * (NOT the number of new rows inserted — re-publishing an already-published
 * opportunity still counts toward the return value, but does not create a
 * duplicate row).
 *
 * If the mesh is disabled (MeshConfig.enabled === false) the function is a
 * no-op and returns 0.
 */
export async function autoPublishOpportunities(
  repos: Repositories,
  mesh: AgentMesh,
  investigationId: string,
): Promise<number> {
  const cfg = mesh.getConfig();
  if (!cfg.enabled) {
    logger.info('Mesh auto-publish skipped (mesh disabled)', { investigationId });
    return 0;
  }
  const opportunities = repos.opportunities.findByInvestigation(investigationId);
  if (opportunities.length === 0) {
    logger.info('Mesh auto-publish — no opportunities to publish', { investigationId });
    return 0;
  }
  let published = 0;
  let skippedInvalid = 0;
  for (const opp of opportunities) {
    // FASE-3-QUALITY §3.7 — reconstruct + validate the V1 payload before
    // publishing. This guarantees AGENTE-LEADS always receives a payload
    // that conforms to the OpportunityV1 contract.
    const { v1, error } = toOpportunityV1(opp);
    if (!v1) {
      skippedInvalid++;
      logger.warn('Mesh auto-publish — opportunity V1 invalid, skipping', {
        investigationId,
        opportunityId: opp.id,
        err: error,
      });
      continue;
    }
    try {
      mesh.publishOpportunityV1(v1);
      published++;
      // Auto-broadcast a YOUTUBE-AUTOMATION y NEX-SCOPE si tiene alta relevancia
      if ((opp.score ?? 0) >= 35) {
        mesh.publishOpportunityV1(v1, 'YOUTUBE-AUTOMATION');
        mesh.publishOpportunityV1(v1, 'NEX-SCOPE');
      }
    } catch (e: any) {
      logger.error('Mesh publish failed for opportunity', {
        investigationId,
        opportunityId: opp.id,
        err: e?.message ?? String(e),
      });
    }
  }
  logger.info('Mesh auto-publish complete', {
    investigationId,
    published,
    skippedInvalid,
    total: opportunities.length,
  });
  return published;
}

/**
 * Re-export the V1 type so callers (CLI, tests) can reference it without
 * pulling in the schema module directly.
 */
export type { OpportunityV1 };
