import { NextRequest } from 'next/server';
import {
  alertRepository,
  AlertStatus,
  type Alert,
  type AlertSeverity,
  type AlertPriority,
} from '@/lib/alerts-server';
import { apiOk, apiServerError } from '@/lib/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

/**
 * Hybrid response item: an `Anomaly`-shaped object (so the existing
 * `<AnomalyAlerts>` dashboard component can keep polling `/api/alerts`
 * unchanged) PLUS the alert-specific lifecycle fields (alertId,
 * alertStatus, alertPriority, …) for V2 UIs that want them.
 *
 * The Anomaly shape is reconstructed from the Alert row + its
 * `metadata.baseline` / `metadata.currentValue` / `metadata.anomalySeverity`
 * fields that the AlertManager wrote at emit time.
 */
interface AlertListItem {
  // ----- Anomaly shape (kept for backward compatibility with <AnomalyAlerts>) -----
  id: string;
  topic: string;
  type: string;
  severity: 'low' | 'medium' | 'high';
  observedAt: string;
  baseline: { mean: number; stddev: number; windowDays: number; samples: number };
  currentValue: number;
  zscore: number;
  description: string;
  recommendedAction: string;
  // ----- Alert-specific extension -----
  alertId: string;
  alertStatus: AlertStatus;
  alertSeverity: AlertSeverity;
  alertPriority: AlertPriority;
  alertTitle: string;
  detectedAt: string;
  sentAt?: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  resolvedAt?: string;
  resolutionNote?: string;
  cooldownUntil?: string;
  relatedInvestigationId?: string;
  confidence: number;
  evidenceSummary: string;
  dedupKey: string;
  createdAt?: string;
}

interface AlertListResponse {
  ranAt: string;
  count: number;
  filters: {
    status: string | null;
    priority: string | null;
    topic: string | null;
    limit: number;
  };
  alerts: AlertListItem[];
}

// ---------------------------------------------------------------------------
// GET /api/alerts
// ---------------------------------------------------------------------------

/**
 * GET /api/alerts
 *
 * Lists persisted alerts from the `alerts` table (Task IMP-4, spec §20).
 *
 * Each alert is derived from an anomaly emitted by the AnomalyDetector
 * (see `src/lib/anomaly-detector.ts` and `src/lib/alerts-server.ts`).
 * The lifecycle is DETECTED → SENT → ACKNOWLEDGED → RESOLVED; SUPPRESSED
 * is a transient emit-time result, never persisted.
 *
 * Query params (all optional, AND-combined):
 *   ?status=DETECTED|SENT|ACKNOWLEDGED|RESOLVED
 *   ?priority=P1|P2|P3|P4
 *   ?severity=LOW|MEDIUM|HIGH|CRITICAL
 *   ?topic=<name>
 *   ?limit=N (default 100, max 500)
 *
 * Response shape:
 *   {
 *     ranAt: string (ISO),
 *     count: number,
 *     filters: { status, priority, topic, limit },
 *     alerts: AlertListItem[]   // Anomaly shape + alert-specific fields
 *   }
 *
 * The Anomaly-shape fields (id, topic, type, severity, observedAt,
 * baseline, currentValue, zscore, description, recommendedAction) are
 * reconstructed from the Alert row + its metadata. This keeps the
 * existing `<AnomalyAlerts>` dashboard component working unchanged —
 * it reads `json.alerts` and renders the first 9 fields.
 *
 * V2 UIs can additionally read `alertId`, `alertStatus`, `alertPriority`,
 * `acknowledgedAt`, `resolvedAt`, etc. to render a managed alert feed.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const statusParam = url.searchParams.get('status') ?? undefined;
  const priorityParam = url.searchParams.get('priority') ?? undefined;
  const severityParam = url.searchParams.get('severity') ?? undefined;
  const topic = url.searchParams.get('topic') ?? undefined;
  const limitRaw = parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(500, limitRaw)
    : 100;

  // Validate enum-typed filters; bad values are rejected with 400.
  const status = statusParam ? parseEnum(statusParam, AlertStatus, 'status') : undefined;
  const priority = priorityParam ? parseEnum(priorityParam, ['P1', 'P2', 'P3', 'P4'] as const, 'priority') as AlertPriority | undefined : undefined;
  const severity = severityParam ? parseEnum(severityParam, ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const, 'severity') as AlertSeverity | undefined : undefined;

  try {
    const alerts = alertRepository.list({
      status: status as AlertStatus | undefined,
      priority: priority as AlertPriority | undefined,
      severity: severity as AlertSeverity | undefined,
      topic: topic ?? undefined,
      limit,
    });

    const items = alerts.map(alertToAnomalyItem);

    const body: AlertListResponse = {
      ranAt: new Date().toISOString(),
      count: items.length,
      filters: {
        status: status ?? null,
        priority: priority ?? null,
        topic: topic ?? null,
        limit,
      },
      alerts: items,
    };

    return apiOk(body);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('alerts_query_failed', { message, ranAt: new Date().toISOString() });
  }
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function parseEnum<T extends string>(
  value: string,
  allowed: readonly T[] | { [k: string]: string },
  fieldName: string,
): T {
  const u = value.toUpperCase();
  const allowedValues = Array.isArray(allowed)
    ? allowed
    : Object.values(allowed);
  if (!allowedValues.includes(u as T)) {
    throw new Error(`Invalid ${fieldName}="${value}". Valid values: ${allowedValues.join(', ')}`);
  }
  return u as T;
}

/**
 * Map a persisted Alert row back to the Anomaly shape the dashboard
 * expects, plus the alert-specific extension fields.
 *
 * The Alert stores:
 *   - metadata.baseline = { mean, stddev, windowDays, samples }
 *   - metadata.currentValue = number
 *   - metadata.anomalySeverity = 'low' | 'medium' | 'high'  (chismoso scale)
 *
 * If metadata is missing (legacy row), we fall back to zscore-derived
 * severity and the alert's own detected_at.
 */
function alertToAnomalyItem(a: Alert): AlertListItem {
  const meta = (a.metadata ?? {}) as {
    baseline?: Alert['metadata'] extends infer M ? (M extends Record<string, unknown> ? M : never) : never;
    currentValue?: number;
    anomalySeverity?: string;
  };

  const baseline = (meta.baseline ?? {
    mean: 0,
    stddev: 0,
    windowDays: 30,
    samples: 0,
  }) as { mean: number; stddev: number; windowDays: number; samples: number };

  const currentValue = typeof meta.currentValue === 'number' ? meta.currentValue : (a.zscore ?? 0);

  // anomalySeverity is on the chismoso scale (low|medium|high); we map it
  // back. If missing, derive from |zscore|.
  const anomalySeverity: 'low' | 'medium' | 'high' =
    typeof meta.anomalySeverity === 'string' && ['low', 'medium', 'high'].includes(meta.anomalySeverity)
      ? (meta.anomalySeverity as 'low' | 'medium' | 'high')
      : deriveAnomalySeverity(a.zscore);

  return {
    // Anomaly shape
    id: a.anomaly_id ?? a.id,
    topic: a.topic,
    type: a.type,
    severity: anomalySeverity,
    observedAt: a.detected_at,
    baseline,
    currentValue,
    zscore: a.zscore ?? 0,
    description: a.description,
    recommendedAction: a.recommended_action,
    // Alert extension
    alertId: a.id,
    alertStatus: a.status,
    alertSeverity: a.severity,
    alertPriority: a.priority,
    alertTitle: a.title,
    detectedAt: a.detected_at,
    sentAt: a.sent_at,
    acknowledgedAt: a.acknowledged_at,
    acknowledgedBy: a.acknowledged_by,
    resolvedAt: a.resolved_at,
    resolutionNote: a.resolution_note,
    cooldownUntil: a.cooldown_until,
    relatedInvestigationId: a.related_investigation_id,
    confidence: a.confidence,
    evidenceSummary: a.evidence_summary,
    dedupKey: a.dedup_key,
    createdAt: a.created_at,
  };
}

function deriveAnomalySeverity(z: number | undefined): 'low' | 'medium' | 'high' {
  const a = Math.abs(z ?? 0);
  if (a > 3) return 'high';
  if (a > 2.5) return 'medium';
  return 'low';
}
