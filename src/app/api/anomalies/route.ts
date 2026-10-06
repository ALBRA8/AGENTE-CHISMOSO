import { NextRequest } from 'next/server';
import {
  detectAnomalies,
  type Anomaly,
  type AnomalyDetectorConfig,
  DEFAULT_ANOMALY_CONFIG,
} from '@/lib/anomaly-detector';
import { emitAlertsForAnomalies } from '@/lib/alerts-server';
import { apiOk, apiServerError } from '@/lib/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/anomalies
 *
 * Returns all anomalies currently detectable from the chismoso
 * `topic_observations` history. The detector itself is read-only with
 * respect to topic_observations / signals — but as of Task IMP-4 (spec
 * §20), each detected anomaly is ALSO emitted as an Alert via the
 * `AlertManager` (idempotent: re-emits within cooldown are SUPPRESSED).
 *
 * This is the entry point that keeps the `alerts` table populated as
 * anomalies fire. The dashboard polls /api/anomalies on a 30s cycle;
 * each poll re-runs detection and emits any new alerts that have
 * appeared since the previous cycle.
 *
 * Query params:
 *   ?topic=<name>      Restrict detection to a single topic.
 *   ?minSamples=N      Override min-samples threshold (default 5).
 *   ?zscoreThreshold=F Override z-score threshold (default 2.0).
 *   ?emitAlerts=0      Skip the alert-emit side effect (read-only poll).
 *
 * Response shape:
 *   {
 *     ranAt: string (ISO),
 *     topic: string | null,
 *     count: number,
 *     anomalies: Anomaly[],
 *     config: AnomalyDetectorConfig,
 *     alertsEmitted: number,    // NEW: count of alerts persisted this call
 *     alertsSuppressed: number  // NEW: count of emits suppressed by cooldown
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
  const emitAlerts = (url.searchParams.get('emitAlerts') ?? '1') !== '0';

  const config: Partial<AnomalyDetectorConfig> = {};
  if (Number.isFinite(minSamplesArg) && minSamplesArg > 0) {
    config.minSamples = minSamplesArg;
  }
  if (Number.isFinite(zscoreThresholdArg) && zscoreThresholdArg > 0) {
    config.zscoreThreshold = zscoreThresholdArg;
  }

  try {
    const anomalies: Anomaly[] = detectAnomalies(topic, config);

    let alertsEmitted = 0;
    let alertsSuppressed = 0;
    if (emitAlerts && anomalies.length > 0) {
      // Emit a managed Alert for each detected anomaly. The manager handles
      // dedup + cooldown — duplicates are silently SUPPRESSED.
      const result = emitAlertsForAnomalies(anomalies);
      alertsEmitted = result.emitted;
      alertsSuppressed = result.suppressed;
    }

    return apiOk({
      ranAt: new Date().toISOString(),
      topic,
      count: anomalies.length,
      anomalies,
      config: { ...DEFAULT_ANOMALY_CONFIG, ...config },
      alertsEmitted,
      alertsSuppressed,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('anomaly_detection_failed', { message, ranAt: new Date().toISOString(), topic });
  }
}
