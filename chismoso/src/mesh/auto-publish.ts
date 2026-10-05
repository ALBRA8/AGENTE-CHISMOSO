/**
 * CHISMOSO V1.0 — Auto-publish hook (Task EXP-2)
 *
 * Bridges the orchestrator output to the agent mesh. The orchestrator
 * owns opportunity persistence — we only READ from the opportunities
 * table and call `mesh.publishOpportunity()` for each row. This keeps the
 * orchestrator untouched (no mesh coupling inside orchestrator.ts).
 *
 * Idempotency: `publishOpportunity` skips events that already exist for a
 * given (opportunityId, agentTarget), so calling this multiple times for
 * the same investigation is safe.
 */

import type { Repositories } from '../repositories.js';
import type { AgentMesh } from './index.js';
import { logger } from '../logger.js';

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
  for (const opp of opportunities) {
    try {
      mesh.publishOpportunity(opp);
      published++;
    } catch (e: any) {
      logger.error('Mesh publish failed for opportunity', {
        investigationId,
        opportunityId: opp.id,
        err: e?.message ?? String(e),
      });
    }
  }
  logger.info('Mesh auto-publish complete', { investigationId, published, total: opportunities.length });
  return published;
}
