/**
 * CHISMOSO V1.0 — MemoryDV models (spec §12 MemoryDV · §13 Memory Contract)
 *
 * Implements the spec's Memory Data View contract: a record that captures
 * a single memory owned by an agent, scoped by domain, typed by cognitive
 * role, and continuously re-scored by temporal decay + utility feedback.
 *
 * Spec §13 required fields:
 *   id, agent_id, domain, type, content, source, evidence, provenance,
 *   confidence, truth_level, created_at, updated_at, last_verified,
 *   relevance, utility, decay, scope, status
 *
 * MemoryDV specializations per spec §12 (signal / trend / event / temporal
 * / anomaly / opportunity / source / evidence / historical) are NOT separate
 * TypeScript interfaces — they are all expressed via the `domain` field on a
 * single `MemoryRecord`. This is intentional: the §13 contract is uniform
 * across all memory kinds, so we keep one row shape and let `domain` carry
 * the cognitive role.
 *
 * The 4 MemoryType values map to the cognitive stages in §14:
 *   EPISODIC    — specific event observation ("on 2024-05-01 a user on r/foo said X")
 *   SEMANTIC    — concept/fact abstracted from many observations ("X is a growing trend")
 *   FACTUAL     — extracted factual claim with corroborating evidence
 *   PROCEDURAL  — how-to / pattern / actionable recipe ("when X happens, do Y")
 *
 * Status lifecycle:
 *   ACTIVE   → freshly inserted, relevance >= 0.1
 *   DECAYED  → relevance < 0.1 (still queryable but de-prioritized)
 *   ARCHIVED → relevance < 0.01 (effectively forgotten, kept for audit only)
 *   RETIRED  → manually retired (e.g. contradicted by new evidence)
 */

// ---------------------------------------------------------------------------
// MEMORY TYPE
// ---------------------------------------------------------------------------

export enum MemoryType {
  EPISODIC = 'EPISODIC', // specific event observation
  SEMANTIC = 'SEMANTIC', // concept/fact
  FACTUAL = 'FACTUAL', // extracted factual claim
  PROCEDURAL = 'PROCEDURAL', // how-to / pattern
}

export const ALL_MEMORY_TYPES: MemoryType[] = Object.values(MemoryType);

// ---------------------------------------------------------------------------
// MEMORY STATUS
// ---------------------------------------------------------------------------

export enum MemoryStatus {
  ACTIVE = 'ACTIVE',
  DECAYED = 'DECAYED',
  ARCHIVED = 'ARCHIVED',
  RETIRED = 'RETIRED',
}

export const ALL_MEMORY_STATUSES: MemoryStatus[] = Object.values(MemoryStatus);

// ---------------------------------------------------------------------------
// TRUTH LEVEL
// ---------------------------------------------------------------------------
//
// The §13 spec uses OBSERVED | VERIFIED | INFERRED | ESTIMATED | UNVERIFIED |
// UNKNOWN. We mirror that vocabulary here directly (instead of reusing the
// TruthLevel enum from models.ts which uses OBSERVED | DERIVED | INFERRED |
// PREDICTED | UNKNOWN) so the MemoryDV contract matches the spec literally.
// This resolves audit finding [AUDIT-B-018].

export type MemoryTruthLevel =
  | 'OBSERVED'
  | 'VERIFIED'
  | 'INFERRED'
  | 'ESTIMATED'
  | 'UNVERIFIED'
  | 'UNKNOWN';

// ---------------------------------------------------------------------------
// MEMORY RECORD — the §13 contract
// ---------------------------------------------------------------------------

export interface MemoryRecord {
  /** Stable unique ID (generated as `mem_<base36-ts><rnd>`). */
  id: string;
  /** Owning agent. Always `AGENTE-CHISMOSO` in V1. */
  agent_id: string;
  /** Cognitive domain: trend_detection | problem_detection | opportunity_detection | signal_intelligence | ... */
  domain: string;
  /** Cognitive type (EPISODIC / SEMANTIC / FACTUAL / PROCEDURAL). */
  type: MemoryType;
  /** The memory payload — natural language sentence or structured note. */
  content: string;
  /** Provider name that produced the underlying observation (e.g. `web_search`). */
  source: string;
  /** SourceType enum value (SEARCH_WEB | REDDIT_COMMUNITIES | ...) if known. */
  source_type?: string;
  /** Back-reference to the Evidence row this memory was derived from, if any. */
  evidence_id?: string;
  /** How we got it — `investigation:<id>` | `consolidation:<id>` | `manual:<user>` | ... */
  provenance: string;
  /** Initial confidence 0..1 at insertion time. */
  confidence: number;
  /** Truth-level classification (OBSERVED | VERIFIED | INFERRED | ESTIMATED | UNVERIFIED | UNKNOWN). */
  truth_level: MemoryTruthLevel;
  /** Current relevance after decay — recomputed by MemoryRepository.applyDecay(). 0..1. */
  relevance: number;
  /** Historical utility — boosted by positive feedback. 0..1. */
  utility: number;
  /** Half-life in days. Default 30. Controls decay speed (see decay.ts). */
  decay_half_life_days: number;
  /** Scope: `global` | topic | geography | segment. */
  scope: string;
  /** Lifecycle status (ACTIVE / DECAYED / ARCHIVED / RETIRED). */
  status: MemoryStatus;
  /** ISO timestamp — when this memory was first inserted. */
  created_at: string;
  /** ISO timestamp — last time the row was mutated (relevance recompute, verify, ...). */
  updated_at: string;
  /** ISO timestamp — last time this memory was re-verified (corroborating evidence arrived). */
  last_verified: string;
  /** Optional back-references to signal IDs (for EPISODIC memories of signal events). */
  related_signal_ids?: string[];
  /** Optional topic label — used by the consolidation dedup pass. */
  related_topic?: string;
}

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

/**
 * Default decay half-life in days. A memory with this half-life drops to
 * 50% relevance after 30 days, 25% after 60 days, and 6.25% after 120 days.
 *
 * Half-life is per-memory overridable (MemoryRecord.decay_half_life_days),
 * which lets e.g. opportunities (long-lived synthesis) decay slower than
 * episodic observations (volatile noise). See consolidation.ts for the
 * per-domain defaults.
 */
export const DEFAULT_HALF_LIFE_DAYS = 30;

/**
 * The canonical agent ID. Hard-coded in V1 — V2 will read this from the
 * agent registry once the Mesh track exposes it.
 */
export const AGENT_ID = 'AGENTE-CHISMOSO';
