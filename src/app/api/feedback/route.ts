import { NextRequest } from 'next/server';
import { apiOk, apiBadRequest, apiServerError } from '@/lib/api-response';
import { authedPOST } from '@/lib/middleware';
import {
  feedbackRepository,
  FeedbackType,
  type FeedbackTargetType,
} from '@/lib/feedback-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

interface FeedbackAddBody {
  type?: string;
  target_type?: string;
  target_id?: string;
  note?: string;
  user_id?: string;
  metadata?: Record<string, unknown>;
}

const VALID_TARGET_TYPES: FeedbackTargetType[] = [
  'alert',
  'trend',
  'opportunity',
  'signal',
  'memory',
  'skill',
];

// ---------------------------------------------------------------------------
// GET /api/feedback
// ---------------------------------------------------------------------------

/**
 * GET /api/feedback
 *
 * Lists feedback rows. All filters are optional and AND-combined.
 *
 * Query params:
 *   ?type=ALERT_USEFUL|ALERT_USELESS|FALSE_POSITIVE|FALSE_NEGATIVE|TREND_CONFIRMED|TREND_REJECTED|OPPORTUNITY_USEFUL|OPPORTUNITY_IRRELEVANT|SIGNAL_NOISE|SIGNAL_VALUABLE
 *   ?target_type=alert|trend|opportunity|signal|memory|skill
 *   ?target_id=<id>
 *   ?user_id=<user>
 *   ?limit=N (default 20, max 500)
 *
 * Response: { count, feedback: Feedback[] }
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const typeRaw = url.searchParams.get('type') ?? undefined;
  const targetTypeRaw = url.searchParams.get('target_type') ?? undefined;
  const targetId = url.searchParams.get('target_id') ?? undefined;
  const userId = url.searchParams.get('user_id') ?? undefined;
  const limitRaw = parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, limitRaw) : 20;

  // Validate enum-typed filters; bad values are rejected with 400.
  if (typeRaw && !Object.values(FeedbackType).includes(typeRaw as FeedbackType)) {
    return apiBadRequest(
      `Invalid type="${typeRaw}". Valid values: ${Object.values(FeedbackType).join(', ')}`,
    );
  }
  if (targetTypeRaw && !VALID_TARGET_TYPES.includes(targetTypeRaw as FeedbackTargetType)) {
    return apiBadRequest(
      `Invalid target_type="${targetTypeRaw}". Valid values: ${VALID_TARGET_TYPES.join(', ')}`,
    );
  }

  try {
    const items = feedbackRepository.list({
      type: typeRaw as FeedbackType | undefined,
      target_type: targetTypeRaw as FeedbackTargetType | undefined,
      target_id: targetId,
      user_id: userId,
      limit,
    });
    return apiOk({
      count: items.length,
      feedback: items,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('feedback_query_failed', { message });
  }
}

// ---------------------------------------------------------------------------
// POST /api/feedback
// ---------------------------------------------------------------------------

/**
 * POST /api/feedback
 *
 * Records operator feedback on a target (alert, trend, opportunity, signal,
 * memory, or skill). This closes the §28 feedback loop: anomalies are
 * emitted but never confirmed/rejected; this endpoint lets operators do
 * exactly that.
 *
 * Request body (JSON):
 *   {
 *     type:         'ALERT_USEFUL' | 'ALERT_USELESS' | 'FALSE_POSITIVE' |
 *                   'FALSE_NEGATIVE' | 'TREND_CONFIRMED' | 'TREND_REJECTED' |
 *                   'OPPORTUNITY_USEFUL' | 'OPPORTUNITY_IRRELEVANT' |
 *                   'SIGNAL_NOISE' | 'SIGNAL_VALUABLE',
 *     target_type:  'alert' | 'trend' | 'opportunity' | 'signal' | 'memory' | 'skill',
 *     target_id:    string,
 *     note?:        string,
 *     user_id?:     string,
 *     metadata?:    Record<string, unknown>
 *   }
 *
 * Response (201): the persisted Feedback row (with `id` and `created_at`).
 *
 * §34 / audit C2 — Protected by `authedPOST`: feedback mutates operator
 * state on artifacts and feeds into the §29 learning loop. Anonymous
 * callers must not be able to bias downstream scoring with fake feedback.
 */
export const POST = authedPOST(async (req: NextRequest) => {
  let body: FeedbackAddBody;
  try {
    body = (await req.json()) as FeedbackAddBody;
  } catch {
    return apiBadRequest('Invalid JSON body');
  }

  const { type, target_type, target_id, note, user_id, metadata } = body;

  if (!type || !target_type || !target_id) {
    return apiBadRequest(
      'Missing required fields: type, target_type, target_id are all required.',
      {
        received: { type, target_type, target_id },
        valid_types: Object.values(FeedbackType),
        valid_target_types: VALID_TARGET_TYPES,
      },
    );
  }

  if (!Object.values(FeedbackType).includes(type as FeedbackType)) {
    return apiBadRequest(
      `Invalid type="${type}". Valid values: ${Object.values(FeedbackType).join(', ')}`,
    );
  }

  if (!VALID_TARGET_TYPES.includes(target_type as FeedbackTargetType)) {
    return apiBadRequest(
      `Invalid target_type="${target_type}". Valid values: ${VALID_TARGET_TYPES.join(', ')}`,
    );
  }

  if (typeof target_id !== 'string' || target_id.length === 0) {
    return apiBadRequest('target_id must be a non-empty string');
  }

  try {
    const fb = feedbackRepository.insert({
      type: type as FeedbackType,
      target_type: target_type as FeedbackTargetType,
      target_id,
      note: note ?? undefined,
      user_id: user_id ?? undefined,
      metadata: metadata,
    });
    return apiOk({ feedback: fb }, 201);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('feedback_insert_failed', { message });
  }
});
