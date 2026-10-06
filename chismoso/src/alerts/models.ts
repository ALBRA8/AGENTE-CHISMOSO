/**
 * CHISMOSO V1.0 — Alert models (Task IMP-4, spec §20)
 *
 * An Alert is the managed, persisted, lifecycle-bearing projection of an
 * Anomaly. The AnomalyDetector (anomaly/index.ts) emits raw statistical
 * findings; the AlertManager (manager.ts) takes each Anomaly and decides
 * whether it should:
 *   - create a new Alert row (DETECTED),
 *   - be SUPPRESSED (an existing alert for the same dedup_key is still
 *     within its cooldown window),
 *   - or be silently ignored (existing alert already in a terminal state
 *     but the cooldown has expired → a NEW alert is created).
 *
 * Lifecycle:
 *   DETECTED → SENT → ACKNOWLEDGED → RESOLVED
 *                          ↑
 *                  (transient) SUPPRESSED is NOT a state an Alert row
 *                  enters — it is the result returned by AlertManager.emit
 *                  when no new row is created because cooldown is active.
 *
 * Severity is intrinsic (how big is the deviation); Priority is operational
 * (how urgently should the on-call act).
 */

// ---------------------------------------------------------------------------
// ENUMS
// ---------------------------------------------------------------------------

export enum AlertStatus {
  /** Anomaly detected, alert row created, not yet pushed to a delivery channel. */
  DETECTED = 'DETECTED',
  /** Delivered to the user via UI, email, webhook, push, etc. */
  SENT = 'SENT',
  /** User saw + acknowledged (manual action). */
  ACKNOWLEDGED = 'ACKNOWLEDGED',
  /** Anomaly no longer active (auto-resolved or manually resolved). */
  RESOLVED = 'RESOLVED',
  /**
   * SUPPRESSED is a pseudo-status returned by the AlertManager when an emit
   * call was deduped / cooldown-suppressed. A row that is suppressed is
   * NOT created — the previous alert row keeps its DETECTED/SENT/ACK state.
   *
   * Kept inside the enum so callers can compare `result.reason` against a
   * named constant rather than a magic string. (A row with status='SUPPRESSED'
   * would be a bug — the repository refuses to insert it.)
   */
  SUPPRESSED = 'SUPPRESSED',
}

export enum AlertSeverity {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

export enum AlertPriority {
  /** Critical + active → act now. */
  P1 = 'P1',
  /** High + active → review soon. */
  P2 = 'P2',
  /** Medium → batch review. */
  P3 = 'P3',
  /** Low → informational. */
  P4 = 'P4',
}

// ---------------------------------------------------------------------------
// ALERT INTERFACE
// ---------------------------------------------------------------------------

export interface Alert {
  /** Stable unique id, prefixed `alert_`. */
  id: string;
  /** Ref to the Anomaly.id that triggered this alert, if known. */
  anomaly_id?: string;
  /** Topic the anomaly was detected on. */
  topic: string;
  /** volume_spike | volume_drop | velocity_change | source_diversification | confidence_drift. */
  type: string;
  /** Intrinsic severity (LOW | MEDIUM | HIGH | CRITICAL). */
  severity: AlertSeverity;
  /** Operational priority (P1 | P2 | P3 | P4). */
  priority: AlertPriority;
  /** Human-readable one-liner. */
  title: string;
  /** Long-form description (Anomaly.description). */
  description: string;
  /** Concrete next step recommended to the operator. */
  recommended_action: string;
  /** Compact 1-line summary of evidence (z, baseline mean, current value). */
  evidence_summary: string;
  /** Confidence 0..1 from the underlying anomaly. */
  confidence: number;
  /** Z-score (signed; pseudo-zscore for non-volume types). */
  zscore?: number;
  /** ISO timestamp when the underlying anomaly was detected. */
  detected_at: string;
  /** ISO timestamp when the alert was delivered (DETECTED → SENT). */
  sent_at?: string;
  /** ISO timestamp when the user acknowledged (SENT → ACKNOWLEDGED). */
  acknowledged_at?: string;
  /** Who acknowledged (free-form: 'user', 'ops-alice', 'auto-policy', …). */
  acknowledged_by?: string;
  /** ISO timestamp when the alert was resolved (any → RESOLVED). */
  resolved_at?: string;
  /** Free-form note explaining why it was resolved. */
  resolution_note?: string;
  /** Current lifecycle state. */
  status: AlertStatus;
  /**
   * Hash of `topic:type` — used for cooldown/dedup. Two alerts with the same
   * dedup_key refer to the same logical anomaly across detection runs.
   */
  dedup_key: string;
  /** ISO timestamp; while now < cooldown_until, re-emits are SUPPRESSED. */
  cooldown_until?: string;
  /** Ref to an Investigation.id, if this alert was emitted during one. */
  related_investigation_id?: string;
  /** Free-form extension column (e.g. baseline JSON, source types). */
  metadata?: Record<string, unknown>;
  /** Row creation time (separate from detected_at — used for ordering). */
  created_at?: string;
}

// ---------------------------------------------------------------------------
// EMIT RESULT (returned by AlertManager.emit)
// ---------------------------------------------------------------------------

export interface EmitResult {
  /** The newly-inserted Alert, or null if suppressed. */
  alert: Alert | null;
  /** True when the emit call was deduped / cooldown-suppressed. */
  suppressed: boolean;
  /** Short machine-readable reason: 'emitted' | 'cooldown active' | 'suppressed:existing'. */
  reason: string;
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/**
 * All lifecycle states an Alert row can be in *excluding* SUPPRESSED
 * (which is never persisted). Used by the repository to filter "active"
 * alerts.
 */
export const ACTIVE_STATUSES: AlertStatus[] = [
  AlertStatus.DETECTED,
  AlertStatus.SENT,
  AlertStatus.ACKNOWLEDGED,
];

export const TERMINAL_STATUSES: AlertStatus[] = [
  AlertStatus.RESOLVED,
];

/**
 * Compute the dedup_key for a (topic, type) pair. Centralised here so the
 * manager and the repository agree on the format.
 */
export function makeDedupKey(topic: string, type: string): string {
  return `${topic}:${type}`;
}
