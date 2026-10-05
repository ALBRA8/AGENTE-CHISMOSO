import { NextRequest, NextResponse } from 'next/server';
import {
  detectAnomalies,
  type Anomaly,
  type AnomalyDetectorConfig,
  DEFAULT_ANOMALY_CONFIG,
} from '@/lib/anomaly-detector';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/anomalies
 *
 * Returns all anomalies currently detectable from the chismoso
 * `topic_observations` history. The detector is read-only and side-effect-free.
 *
 * Query params:
 *   ?topic=<name>      Restrict detection to a single topic.
 *   ?minSamples=N      Override min-samples threshold (default 5).
 *   ?zscoreThreshold=F Override z-score threshold (default 2.0).
 *
 * Response shape:
 *   {
 *     ranAt: string (ISO),
 *     topic: string | null,
 *     count: number,
 *     anomalies: Anomaly[]
 *   }
 *
 * Anomaly shape:
 *   {
 *     id, topic, type, severity, observedAt,
 *     baseline: { mean, stddev, windowDays, samples },
 *     currentValue, zscore, description, recommendedAction
 *   }
 *
 * Topics with fewer than `minSamples` observations are silently skipped —
 * they appear neither as anomalies nor as an error.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const topic = url.searchParams.get('topic');
  const minSamplesArg = parseInt(url.searchParams.get('minSamples') ?? '', 10);
  const zscoreThresholdArg = parseFloat(url.searchParams.get('zscoreThreshold') ?? '');

  const config: Partial<AnomalyDetectorConfig> = {};
  if (Number.isFinite(minSamplesArg) && minSamplesArg > 0) {
    config.minSamples = minSamplesArg;
  }
  if (Number.isFinite(zscoreThresholdArg) && zscoreThresholdArg > 0) {
    config.zscoreThreshold = zscoreThresholdArg;
  }

  try {
    const anomalies: Anomaly[] = detectAnomalies(topic, config);
    return NextResponse.json({
      ranAt: new Date().toISOString(),
      topic,
      count: anomalies.length,
      anomalies,
      config: { ...DEFAULT_ANOMALY_CONFIG, ...config },
    });
  } catch (e: any) {
    return NextResponse.json(
      {
        error: 'anomaly_detection_failed',
        message: e?.message ?? String(e),
        ranAt: new Date().toISOString(),
        topic,
        count: 0,
        anomalies: [],
      },
      { status: 500 },
    );
  }
}
