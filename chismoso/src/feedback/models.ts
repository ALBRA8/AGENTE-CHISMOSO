/**
 * CHISMOSO V1.0 — Feedback models (spec §28, AUDIT-C §28)
 *
 * Feedback is the operator's signal back to CHISMOSO about the quality of
 * what it produced. Without it, the agent has no learning loop: anomalies
 * are emitted but never confirmed/rejected; opportunities are scored but
 * never marked useful/irrelevant; trends are detected but never confirmed.
 *
 * The schema mirrors the spec §28 vocabulary:
 *   - target_type × type captures "what is the feedback about + what's the verdict?"
 *   - target_id points to the specific row in that target table
 *   - user_id / note are optional context for the human reviewer
 *   - metadata_json allows carrying structured context (e.g. scores, reasons)
 *
 * The repository (feedback/repository.ts) exposes a `stats()` method that
 * computes `useful_rate` — the fraction of feedback rows that are "positive"
 * (USEFUL / CONFIRMED / VALUABLE) over the total. This is the simplest
 * possible §29 self-improvement primitive.
 */

/**
 * The verdict a user gives to a target. Naming follows spec §28.
 *
 * POSITIVE verdicts (count toward `useful_rate`):
 *   - ALERT_USEFUL
 *   - TREND_CONFIRMED
 *   - OPPORTUNITY_USEFUL
 *   - SIGNAL_VALUABLE
 *
 * NEGATIVE verdicts (count against `useful_rate`):
 *   - ALERT_USELESS
 *   - TREND_REJECTED
 *   - OPPORTUNITY_IRRELEVANT
 *   - SIGNAL_NOISE
 *
 * CORRECTION verdicts (treated as negative — the agent was wrong):
 *   - FALSE_POSITIVE   (an alert fired but shouldn't have)
 *   - FALSE_NEGATIVE   (an alert SHOULD have fired but didn't — recorded
 *                       against the alert that was missing, with target_id
 *                       pointing to the topic/condition)
 */
export enum FeedbackType {
  ALERT_USEFUL = 'ALERT_USEFUL',
  ALERT_USELESS = 'ALERT_USELESS',
  FALSE_POSITIVE = 'FALSE_POSITIVE',
  FALSE_NEGATIVE = 'FALSE_NEGATIVE',
  TREND_CONFIRMED = 'TREND_CONFIRMED',
  TREND_REJECTED = 'TREND_REJECTED',
  OPPORTUNITY_USEFUL = 'OPPORTUNITY_USEFUL',
  OPPORTUNITY_IRRELEVANT = 'OPPORTUNITY_IRRELEVANT',
  SIGNAL_NOISE = 'SIGNAL_NOISE',
  SIGNAL_VALUABLE = 'SIGNAL_VALUABLE',
}

/**
 * Targets are deliberately a fixed enum — adding a new target type requires
 * a code change, which forces a review of the stats() helper.
 */
export type FeedbackTargetType =
  | 'alert'
  | 'trend'
  | 'opportunity'
  | 'signal'
  | 'memory'
  | 'skill';

export const POSITIVE_FEEDBACK_TYPES: ReadonlySet<FeedbackType> = new Set([
  FeedbackType.ALERT_USEFUL,
  FeedbackType.TREND_CONFIRMED,
  FeedbackType.OPPORTUNITY_USEFUL,
  FeedbackType.SIGNAL_VALUABLE,
]);

export const NEGATIVE_FEEDBACK_TYPES: ReadonlySet<FeedbackType> = new Set([
  FeedbackType.ALERT_USELESS,
  FeedbackType.FALSE_POSITIVE,
  FeedbackType.FALSE_NEGATIVE,
  FeedbackType.TREND_REJECTED,
  FeedbackType.OPPORTUNITY_IRRELEVANT,
  FeedbackType.SIGNAL_NOISE,
]);

export interface Feedback {
  id: string;
  type: FeedbackType;
  target_type: FeedbackTargetType;
  target_id: string;
  user_id?: string;
  note?: string;
  created_at: string;
  metadata?: Record<string, unknown>;
}

export interface FeedbackListFilter {
  type?: FeedbackType;
  target_type?: FeedbackTargetType;
  target_id?: string;
  user_id?: string;
  limit?: number;
}

export interface FeedbackStats {
  total: number;
  by_type: Record<string, number>;
  by_target_type: Record<string, number>;
  useful_rate: number; // 0..1 — positives / (positives + negatives)
  positive_count: number;
  negative_count: number;
}
