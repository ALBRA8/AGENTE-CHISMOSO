import { apiOk, apiServerError } from '@/lib/api-response';
import { feedbackRepository } from '@/lib/feedback-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/feedback/stats
 *
 * Aggregate feedback stats for self-improvement (spec §29).
 *
 * Response shape:
 *   {
 *     total:           number,
 *     by_type:         Record<string, number>,
 *     by_target_type:  Record<string, number>,
 *     useful_rate:     number, // 0..1 — positives / (positives + negatives)
 *     positive_count:  number,
 *     negative_count:  number
 *   }
 *
 * `useful_rate` below ~0.6 means the agent is producing more noise than
 * signal — the dashboard should surface that.
 */
export async function GET() {
  try {
    const stats = feedbackRepository.stats();
    return apiOk(stats);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('feedback_stats_failed', { message });
  }
}
