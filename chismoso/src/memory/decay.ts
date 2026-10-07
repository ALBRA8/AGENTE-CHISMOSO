/**
 * CHISMOSO V1.0 — Memory temporal decay (spec §12 MemoryDV · §14 Consolidation)
 *
 * The MemoryDV contract mandates a `decay` field per memory. We implement it
 * as an exponential half-life decay (the same shape used by radioactive
 * isotopes and most relevance systems, e.g. Reddit's hot ranking):
 *
 *     relevance_now = confidence * 0.5^(age_days / half_life_days) * (1 + 0.5 * utility)
 *
 * Rationale for each factor:
 *
 *   confidence     — the initial trust we placed in the observation. A memory
 *                    we were 0.9 sure about stays relevant longer than one we
 *                    were 0.3 sure about.
 *
 *   0.5^(age/half) — the temporal decay. Halves every `half_life_days`. This
 *                    shape is parameterized per-memory (problems decay fast,
 *                    opportunities decay slow) so we can express domain
 *                    semantics ("noise today is signal tomorrow" vs "patterns
 *                    observed today hold for months").
 *
 *   (1 + 0.5 * u)  — utility boost. Utility is a feedback signal: when a memory
 *                    is consulted and the result is judged useful (e.g. via
 *                    the V2 Feedback system), utility += 0.1. A utility of 1
 *                    multiplies relevance by 1.5x — useful memories decay
 *                    slower than untested ones.
 *
 * The result is clamped to [0, 1].
 */

import {
  DEFAULT_HALF_LIFE_DAYS,
  type MemoryRecord,
  type MemoryStatus,
  MemoryStatus as MemoryStatusEnum,
} from './models.js';

// ---------------------------------------------------------------------------
// CORE DECAY
// ---------------------------------------------------------------------------

/**
 * Compute the current relevance of a memory, given `now`.
 *
 * Returns a number in [0, 1]. Pure function — does not mutate `memory`.
 *
 * Edge cases:
 *   - If `memory.updated_at` is in the future (clock skew), age is negative
 *     and 0.5^(negative) > 1, so the formula returns > confidence — but we
 *     clamp to 1.
 *   - If `memory.decay_half_life_days` is 0 (misconfiguration), we fall back
 *     to DEFAULT_HALF_LIFE_DAYS to avoid divide-by-zero producing Infinity.
 *   - If `memory.confidence` is NaN/Infinity, the result is clamped to 0.
 */
export function computeRelevance(memory: MemoryRecord, now: Date = new Date()): number {
  const updatedAt = new Date(memory.updated_at).getTime();
  if (!Number.isFinite(updatedAt)) {
    // Malformed timestamp — we have no reliable way to compute age. Returning
    // confidence would make the memory permanently ACTIVE (a bug); returning
    // 0 effectively retires it. We choose the latter: a memory with a
    // corrupt timestamp is suspect, not trustworthy.
    return 0;
  }

  const ageMs = now.getTime() - updatedAt;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  const halfLife = memory.decay_half_life_days > 0
    ? memory.decay_half_life_days
    : DEFAULT_HALF_LIFE_DAYS;

  const decayFactor = Math.pow(0.5, ageDays / halfLife);
  const utilityBoost = 1 + memory.utility * 0.5; // u=0→1x, u=1→1.5x

  const raw = memory.confidence * decayFactor * utilityBoost;
  return clamp01(raw);
}

// ---------------------------------------------------------------------------
// STATUS TRANSITION
// ---------------------------------------------------------------------------

/**
 * Determine the lifecycle status a memory SHOULD be in given its current
 * relevance, alongside the recomputed relevance value.
 *
 * Thresholds (per spec §12 + AUDIT-B recommendation):
 *   relevance >= 0.1       → ACTIVE
 *   0.01 <= relevance < 0.1 → DECAYED  (still queryable, de-prioritized)
 *   relevance < 0.01       → ARCHIVED (effectively forgotten, kept for audit)
 *
 * RETIRED is intentionally not produced here — it is only set manually via
 * MemoryRepository.retire() when a memory is contradicted by new evidence.
 *
 * Returns the status as the `MemoryStatus` enum value (not a string) so
 * callers can compare against `MemoryStatus.ACTIVE` directly.
 */
export function shouldDecay(
  memory: MemoryRecord,
  now: Date = new Date(),
): { status: MemoryStatus; relevance: number } {
  const relevance = computeRelevance(memory, now);
  let status: MemoryStatus;
  if (relevance < 0.01) status = MemoryStatusEnum.ARCHIVED;
  else if (relevance < 0.1) status = MemoryStatusEnum.DECAYED;
  else status = MemoryStatusEnum.ACTIVE;
  return { status, relevance };
}

// ---------------------------------------------------------------------------
// UTILITY BOOST
// ---------------------------------------------------------------------------

/**
 * Compute the new utility after a positive feedback event.
 *
 * Each boost adds `amount` (default 0.1) to the current utility, capped at 1.
 * Utility is monotonically non-decreasing within V1 — there is no "downvote"
 * path; a memory that turns out to be wrong is contradicted (markContradicted)
 * which lowers confidence and sets status DECAYED, but does not lower utility
 * (the utility signal is "this memory was consulted and useful at the time",
 * not "this memory is still true now").
 *
 * Pure function — does not mutate `memory`. Returns the new utility value.
 */
export function boostUtility(memory: MemoryRecord, amount: number = 0.1): number {
  if (!Number.isFinite(amount) || amount <= 0) return memory.utility;
  return Math.min(1, memory.utility + amount);
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
