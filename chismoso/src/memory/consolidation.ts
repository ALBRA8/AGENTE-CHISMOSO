/**
 * CHISMOSO V1.0 — Memory Consolidation (spec §14)
 *
 * Implements the spec's consolidation flow:
 *
 *     OBSERVATION → MEMORY CANDIDATE → VALIDATION → DEDUP → CONSOLIDATION → MEMORYDV
 *
 * In CHISMOSO V1, the first three stages happen implicitly inside the
 * orchestrator: every Trend / Problem / Opportunity produced by an
 * Investigation is an OBSERVATION worth promoting to a MemoryCandidate.
 * This file owns the last three stages:
 *
 *   DEDUP          — findSimilar(topic, domain): if a memory already exists
 *                    for this topic+domain, treat the new observation as
 *                    corroboration, not a new memory.
 *
 *   CONSOLIDATION  — for novel observations: insert a new MemoryRecord via
 *                    MemoryRepository.insert(). For corroborations: call
 *                    MemoryRepository.verify() which upgrades truth_level
 *                    to VERIFIED and refreshes last_verified + updated_at
 *                    (so the decay clock resets, keeping corroborated
 *                    memories fresh for longer).
 *
 *   MEMORYDV       — the MemoryRecord row IS the terminal MemoryDV. No
 *                    further stage exists.
 *
 * Domain → MemoryType mapping (spec §12 specializations expressed via `domain`):
 *
 *   trend_detection       → SEMANTIC    (abstracted concept: "X is emerging")
 *   problem_detection     → EPISODIC    (specific observation of friction)
 *   opportunity_detection → PROCEDURAL  (actionable pattern: "do X to capture Y")
 *
 * Per-domain decay defaults (half-life in days):
 *   trend_detection:       30  (signals normalize over a month)
 *   problem_detection:     14  (problems decay fast — they may already be fixed)
 *   opportunity_detection: 60  (opportunities are synthesis — slower to obsolete)
 */

import { MemoryRepository } from './repository.js';
import { AGENT_ID, type MemoryRecord, MemoryStatus, MemoryType } from './models.js';
import type { Repositories } from '../repositories.js';
import type { Investigation, Opportunity, Problem, Trend } from '../models.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// CONSOLIDATION RESULT
// ---------------------------------------------------------------------------

export interface ConsolidationResult {
  /** New memories inserted (CONSOLIDATION stage). */
  ingested: number;
  /** Existing memories corroborated (VALIDATION stage — counted as deduped too). */
  deduped: number;
  /** Subset of `deduped` that were VERIFIED via MemoryRepository.verify(). */
  verified: number;
}

// ---------------------------------------------------------------------------
// CONSOLIDATOR
// ---------------------------------------------------------------------------

export class MemoryConsolidator {
  constructor(
    private memRepo: MemoryRepository,
    // `repos` is not used in V1 but is part of the constructor signature so
    // V2 (semantic-similarity dedup, cross-investigation carry-over) can be
    // added without changing the call site in the orchestrator.
    private repos: Repositories,
  ) {}

  /**
   * Ingest the outputs of a completed Investigation: convert trends,
   * problems, and opportunities into MemoryRecord rows (or verify existing
   * ones if a memory for the same topic+domain already exists).
   *
   * Best-effort: any error on a single item is logged and skipped; the
   * rest of the batch still completes. The function never throws.
   */
  async ingestInvestigation(
    inv: Investigation,
    trends: Trend[],
    problems: Problem[],
    opportunities: Opportunity[],
  ): Promise<ConsolidationResult> {
    let ingested = 0;
    let deduped = 0;
    let verified = 0;

    // -------------------------------------------------------------------
    // TRENDS → SEMANTIC memories ("X is an emerging trend")
    // -------------------------------------------------------------------
    for (const trend of trends) {
      try {
        // Skip noise — noise observations are not memory-worthy.
        if (trend.state === 'NOISE') continue;

        const existing = this.findSimilar(trend.topic, 'trend_detection');
        if (existing) {
          // VALIDATION: corroborate existing memory
          this.memRepo.verify(existing.id);
          verified++;
          deduped++;
        } else {
          // CONSOLIDATION: new memory
          this.memRepo.insert({
            agent_id: AGENT_ID,
            domain: 'trend_detection',
            type: MemoryType.SEMANTIC,
            content: `Trend "${trend.topic}": ${trend.state} (score ${trend.score.toFixed(1)}, confidence ${(trend.confidence * 100).toFixed(0)}%). ${trend.description}`.trim(),
            source: 'orchestrator',
            provenance: `investigation:${inv.id}`,
            confidence: trend.confidence,
            truth_level: 'OBSERVED',
            decay_half_life_days: 30,
            scope: inv.scope,
            related_topic: trend.topic,
          });
          ingested++;
        }
      } catch (e: any) {
        logger.warn('Memory consolidation: trend ingest failed', {
          investigationId: inv.id,
          topic: trend.topic,
          err: e?.message ?? String(e),
        });
      }
    }

    // -------------------------------------------------------------------
    // PROBLEMS → EPISODIC memories ("users on platform X reported Y")
    // -------------------------------------------------------------------
    for (const problem of problems) {
      try {
        const existing = this.findSimilar(problem.topic, 'problem_detection');
        if (existing) {
          this.memRepo.verify(existing.id);
          verified++;
          deduped++;
        } else {
          this.memRepo.insert({
            agent_id: AGENT_ID,
            domain: 'problem_detection',
            type: MemoryType.EPISODIC,
            content: `Problem on "${problem.topic}": severity ${(problem.severity ?? 0).toFixed(0)}/100, frequency ${(problem.frequency ?? 0).toFixed(0)}/100. ${problem.description}`.trim(),
            source: 'orchestrator',
            provenance: `investigation:${inv.id}`,
            confidence: problem.confidence,
            truth_level: 'OBSERVED',
            decay_half_life_days: 14, // problems decay faster — they may already be fixed
            scope: inv.scope,
            related_topic: problem.topic,
          });
          ingested++;
        }
      } catch (e: any) {
        logger.warn('Memory consolidation: problem ingest failed', {
          investigationId: inv.id,
          topic: problem.topic,
          err: e?.message ?? String(e),
        });
      }
    }

    // -------------------------------------------------------------------
    // OPPORTUNITIES → PROCEDURAL memories ("if you target segment X with Y, ...")
    // -------------------------------------------------------------------
    // Opportunities are NOT deduped against existing memories in V1: each
    // opportunity is a synthesis unique to its investigation (different
    // trends + problems combine into different opportunities). V2 may add
    // similarity-based dedup here.
    for (const opp of opportunities) {
      try {
        this.memRepo.insert({
          agent_id: AGENT_ID,
          domain: 'opportunity_detection',
          type: MemoryType.PROCEDURAL,
          content: `Opportunity "${opp.title}" — score ${opp.score.toFixed(1)}/100. ${opp.description} Target: ${opp.targetSegment} @ ${opp.geography}.`.trim(),
          source: 'orchestrator',
          provenance: `investigation:${inv.id}`,
          confidence: opp.confidence,
          truth_level: 'INFERRED', // opportunities are synthesis, not raw observation
          decay_half_life_days: 60, // opportunities decay slow — worth tracking long-term
          scope: opp.geography,
          related_topic: opp.targetSegment,
        });
        ingested++;
      } catch (e: any) {
        logger.warn('Memory consolidation: opportunity ingest failed', {
          investigationId: inv.id,
          title: opp.title,
          err: e?.message ?? String(e),
        });
      }
    }

    logger.info('Memory consolidation complete', {
      investigationId: inv.id,
      ingested,
      deduped,
      verified,
      trends: trends.length,
      problems: problems.length,
      opportunities: opportunities.length,
    });

    return { ingested, deduped, verified };
  }

  // -------------------------------------------------------------------
  // DEDUP — find a similar existing memory
  // -------------------------------------------------------------------

  /**
   * Find an existing ACTIVE memory with the same `related_topic` AND whose
   * `domain` matches the supplied `domain` argument.
   *
   * V1 strategy: exact topic match. This is intentionally simple — V2 will
   * upgrade this to embedding-based similarity (the same EmbeddingClient
   * used by semantic clustering) so memories about "vibe coding" and
   * "AI-assisted coding" can be recognized as the same memory.
   *
   * Returns the first match or null.
   */
  private findSimilar(topic: string, domain: string): MemoryRecord | null {
    if (!topic) return null;
    const candidates = this.memRepo.findByTopic(topic, 5);
    return (
      candidates.find((c) => c.domain === domain && c.status === MemoryStatus.ACTIVE) ?? null
    );
  }
}
