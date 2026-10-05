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
 * GET /api/alerts
 *
 * Thin wrapper over `/api/anomalies` that surfaces only the anomalies whose
 * severity is `medium` or `high`. These are the rows a human operator should
 * look at first.
 *
 * In V1, "alerts" are simply a filtered view of anomalies — there is no
 * separate alert store. A future V2 can add `PUT /api/alerts/{id}` to mark
 * alerts as acknowledged, snoozed, or escalated, and persist that state in
 * a new `alerts` table.
 *
 * Query params:
 *   ?topic=<name>      Restrict detection to a single topic.
 *   ?minSamples=N      Override min-samples threshold (default 5).
 *   ?zscoreThreshold=F Override z-score threshold (default 2.0).
 *   ?severity=low      If `low`, also include low-severity anomalies.
 *
 * Response shape:
 *   {
 *     ranAt: string (ISO),
 *     count: number,
 *     alerts: Anomaly[]
 *   }
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const topic = url.searchParams.get('topic');
  const includeLow = url.searchParams.get('severity') === 'low';

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
    const alerts = anomalies.filter((a) =>
      includeLow
        ? a.severity === 'low' || a.severity === 'medium' || a.severity === 'high'
        : a.severity === 'medium' || a.severity === 'high',
    );

    // Sort by severity (high → medium → low) then by |zscore| descending so
    // the most actionable items bubble to the top of the dashboard.
    const sevRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
    alerts.sort((a, b) => {
      const sa = sevRank[a.severity] ?? 9;
      const sb = sevRank[b.severity] ?? 9;
      if (sa !== sb) return sa - sb;
      return Math.abs(b.zscore) - Math.abs(a.zscore);
    });

    return NextResponse.json({
      ranAt: new Date().toISOString(),
      count: alerts.length,
      alerts,
      config: { ...DEFAULT_ANOMALY_CONFIG, ...config },
    });
  } catch (e: any) {
    return NextResponse.json(
      {
        error: 'alerts_query_failed',
        message: e?.message ?? String(e),
        ranAt: new Date().toISOString(),
        count: 0,
        alerts: [],
      },
      { status: 500 },
    );
  }
}
