/**
 * CHISMOSO V1.0 — Alert manager (Task IMP-4, spec §20)
 *
 * Lifecycle owner: takes a raw `Anomaly` (from AnomalyDetector) and either
 *   - creates a new Alert row (DETECTED),
 *   - or returns SUPPRESSED (the most-recent alert for the same dedup_key
 *     is still inside its cooldown window).
 *
 * Lifecycle:
 *   DETECTED → SENT → ACKNOWLEDGED → RESOLVED
 *
 * The manager is the ONLY component that constructs Alert objects; the
 * repository knows nothing about Anomalies, the detector knows nothing
 * about persistence.
 *
 * To avoid a tight circular dependency on `chismoso/src/anomaly/index.ts`,
 * we accept a *structural* `Anomaly` interface here. The chismoso
 * `Anomaly` interface satisfies this shape, and so does the Next.js port
 * in `src/lib/anomaly-detector.ts`.
 */

import {
  AlertStatus,
  AlertSeverity,
  AlertPriority,
  makeDedupKey,
  type Alert,
  type EmitResult,
} from './models.js';
import type { AlertRepository } from './repository.js';
import { generateId, nowISO } from '../models.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// STRUCTURAL ANOMALY TYPE
// ---------------------------------------------------------------------------

/**
 * Minimal shape the AlertManager needs from an anomaly. The chismoso
 * AnomalyDetector.Anomaly satisfies this; the Next.js port's Anomaly also
 * satisfies this. We deliberately don't import from `../anomaly/index.js`
 * to avoid a circular dependency.
 */
export interface AnomalyLike {
  id: string;
  topic: string;
  type: string;
  severity: string; // 'low' | 'medium' | 'high' from the detector
  observedAt: string;
  baseline: { mean: number; stddev: number; windowDays: number; samples: number };
  currentValue: number;
  zscore: number;
  description: string;
  recommendedAction: string;
  /** Optional — defaults to 0.5 if absent. */
  confidence?: number;
}

/**
 * Structural interface for the AnomalyDetector so autoResolve() can accept
 * any detector that exposes `detectAll(): AnomalyLike[]`.
 */
export interface AnomalyDetectorLike {
  detectAll(): AnomalyLike[];
}

// ---------------------------------------------------------------------------
// MANAGER
// ---------------------------------------------------------------------------

export interface AlertManagerOptions {
  /** Cooldown window in minutes (default: 60). */
  cooldownMinutes?: number;
  /**
   * If true, also call markSent() on the alert right after emitting it.
   * Defaults to false: the SENT transition is the responsibility of the
   * delivery layer (UI render, email send, webhook push).
   */
  markSentOnEmit?: boolean;
}

export class AlertManager {
  private readonly cooldownMinutes: number;
  private readonly markSentOnEmit: boolean;

  constructor(
    private repo: AlertRepository,
    opts: AlertManagerOptions = {},
  ) {
    this.cooldownMinutes = opts.cooldownMinutes ?? 60;
    this.markSentOnEmit = opts.markSentOnEmit ?? false;
  }

  // -------------------------------------------------------------------------
  // EMIT
  // -------------------------------------------------------------------------

  /**
   * Take an Anomaly and either create a new Alert (DETECTED) or report
   * SUPPRESSED. The decision is made by inspecting the most-recent alert
   * with the same dedup_key:
   *   - If none exists, or the latest one is in a terminal state
   *     (RESOLVED) → emit a new alert.
   *   - If the latest one is in DETECTED/SENT/ACK state AND
   *     cooldown_until > now → SUPPRESSED (don't re-emit).
   *   - If the latest one is in DETECTED/SENT/ACK state AND cooldown has
   *     expired → emit a new alert (the previous one stays in its state;
   *     a fresh alert is created so the user gets a new notification).
   */
  emit(anomaly: AnomalyLike, investigationId?: string): EmitResult {
    const dedupKey = makeDedupKey(anomaly.topic, anomaly.type);
    const existing = this.repo.findByDedupKey(dedupKey);

    if (existing && existing.status !== AlertStatus.RESOLVED) {
      const cooldownUntilMs = existing.cooldown_until
        ? new Date(existing.cooldown_until).getTime()
        : 0;
      if (cooldownUntilMs > Date.now()) {
        logger.debug('Alert suppressed (cooldown active)', {
          dedupKey,
          alertId: existing.id,
          cooldownUntil: existing.cooldown_until,
        });
        return {
          alert: null,
          suppressed: true,
          reason: 'cooldown active',
        };
      }
    }

    const severity = this.mapSeverity(anomaly);
    const priority = this.mapPriority(severity);

    const detectedAt = anomaly.observedAt ?? nowISO();
    const alertId = generateId('alert');
    const cooldownUntil = new Date(
      Date.now() + this.cooldownMinutes * 60 * 1000,
    ).toISOString();

    const alert = {
      id: alertId,
      anomaly_id: anomaly.id,
      topic: anomaly.topic,
      type: anomaly.type,
      severity,
      priority,
      title: this.buildTitle(anomaly),
      description: anomaly.description,
      recommended_action: anomaly.recommendedAction,
      evidence_summary: this.buildEvidenceSummary(anomaly),
      confidence: anomaly.confidence ?? 0.5,
      zscore: anomaly.zscore,
      detected_at: detectedAt,
      status: AlertStatus.DETECTED,
      dedup_key: dedupKey,
      cooldown_until: cooldownUntil,
      related_investigation_id: investigationId,
      metadata: {
        baseline: anomaly.baseline,
        currentValue: anomaly.currentValue,
        anomalySeverity: anomaly.severity,
      },
    };

    const inserted = this.repo.insert(alert);

    if (this.markSentOnEmit) {
      this.repo.updateStatus(inserted.id, AlertStatus.SENT, {
        sent_at: nowISO(),
      });
    }

    logger.info('Alert emitted', {
      alertId: inserted.id,
      topic: anomaly.topic,
      type: anomaly.type,
      severity,
      priority,
      dedupKey,
    });

    return {
      alert: this.repo.findById(inserted.id) ?? inserted,
      suppressed: false,
      reason: 'emitted',
    };
  }

  // -------------------------------------------------------------------------
  // LIFECYCLE TRANSITIONS
  // -------------------------------------------------------------------------

  /** Promote a DETECTED alert to SENT (called when delivered to a user). */
  markSent(id: string): void {
    this.repo.updateStatus(id, AlertStatus.SENT, { sent_at: nowISO() });
  }

  /** User acknowledged the alert. */
  acknowledge(id: string, by: string = 'user'): void {
    this.repo.acknowledge(id, by);
  }

  /** Anomaly no longer active (manually or auto). */
  resolve(id: string, note: string = 'auto-resolved'): void {
    this.repo.resolve(id, note);
  }

  // -------------------------------------------------------------------------
  // AUTO-RESOLVE
  // -------------------------------------------------------------------------

  /**
   * For every active alert whose dedup_key is NOT in the set of currently
   * detected anomalies, move it to RESOLVED.
   *
   * Only SENT alerts are auto-resolved. DETECTED alerts (never delivered)
   * are left alone — they'll auto-expire on cooldown. ACKNOWLEDGED alerts
   * are left for the human to formally close (they're already being acted on).
   *
   * Caller is expected to pass the same AnomalyDetector instance whose
   * `detectAll()` reflects the current DB state.
   *
   * Returns the count of alerts that were resolved in this call.
   */
  autoResolve(detector: AnomalyDetectorLike): { resolved: number } {
    // Snapshot active alerts BEFORE calling detectAll — detectAll may emit
    // new alerts (suppressed by cooldown), but those aren't in our snapshot.
    const active = this.repo.findActive();
    if (active.length === 0) return { resolved: 0 };

    let detectedKeys: Set<string>;
    try {
      const currently = detector.detectAll();
      detectedKeys = new Set(currently.map((a) => `${a.topic}:${a.type}`));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn('autoResolve: detector.detectAll() failed; skipping cycle', { error: msg });
      return { resolved: 0 };
    }

    let resolved = 0;
    for (const alert of active) {
      if (alert.status !== AlertStatus.SENT) continue;
      if (!detectedKeys.has(alert.dedup_key)) {
        this.resolve(alert.id, 'anomaly cleared');
        resolved++;
      }
    }
    if (resolved > 0) {
      logger.info('Auto-resolved alerts', { resolved });
    }
    return { resolved };
  }

  // -------------------------------------------------------------------------
  // SEVERITY / PRIORITY MAPPING
  // -------------------------------------------------------------------------

  /**
   * Map a raw Anomaly to an AlertSeverity.
   *
   *   z > 4 OR anomaly.severity === 'high'  → CRITICAL
   *   z > 3 OR anomaly.severity === 'medium' → HIGH
   *   z > 2                                 → MEDIUM
   *   else                                  → LOW
   *
   * The anomaly's intrinsic severity ('low'|'medium'|'high') is folded in
   * because the detector already classifies pseudo-zscores from velocity /
   * source-diversification / confidence-drift (which can't be compared
   * apples-to-apples with raw volume z-scores).
   */
  private mapSeverity(anomaly: AnomalyLike): AlertSeverity {
    const z = Math.abs(anomaly.zscore);
    if (z > 4 || anomaly.severity === 'high') return AlertSeverity.CRITICAL;
    if (z > 3 || anomaly.severity === 'medium') return AlertSeverity.HIGH;
    if (z > 2) return AlertSeverity.MEDIUM;
    return AlertSeverity.LOW;
  }

  /**
   * Map a severity to a priority. Critical → P1, High → P2, Medium → P3,
   * Low → P4. Future V2 may factor in recency, on-call schedule, and
   * related-investigation priority.
   */
  private mapPriority(severity: AlertSeverity): AlertPriority {
    switch (severity) {
      case AlertSeverity.CRITICAL: return AlertPriority.P1;
      case AlertSeverity.HIGH:     return AlertPriority.P2;
      case AlertSeverity.MEDIUM:   return AlertPriority.P3;
      case AlertSeverity.LOW:      return AlertPriority.P4;
    }
  }

  // -------------------------------------------------------------------------
  // TEXT BUILDERS
  // -------------------------------------------------------------------------

  private buildTitle(anomaly: AnomalyLike): string {
    const typeLabel = anomaly.type.replace(/_/g, ' ');
    return `${typeLabel} en "${anomaly.topic}"`;
  }

  private buildEvidenceSummary(anomaly: AnomalyLike): string {
    const z = Number.isFinite(anomaly.zscore)
      ? anomaly.zscore.toFixed(2)
      : 'n/a';
    const mean = Number.isFinite(anomaly.baseline.mean)
      ? anomaly.baseline.mean.toFixed(2)
      : 'n/a';
    return `z=${z}, baseline mean=${mean}, current=${anomaly.currentValue}`;
  }
}
