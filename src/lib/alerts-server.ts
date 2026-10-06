/**
 * CHISMOSO V1.0 — Server-side alerts module (Task IMP-4, spec §20)
 *
 * This is a port of `chismoso/src/alerts/{models,repository,manager}.ts`
 * for the Next.js runtime. The chismoso package isn't compiled into the
 * dashboard bundle, so we port the pure-TS logic (no chismoso imports).
 *
 * Reads use the readonly singleton (`./db-chismoso.ts`); writes use the
 * writable singleton (`./db-chismoso-writable.ts`). Both singletons point
 * at the same SQLite file (WAL mode → safe concurrent R/W).
 *
 * Lifecycle: DETECTED → SENT → ACKNOWLEDGED → RESOLVED
 * (SUPPRESSED is a transient result of `AlertManager.emit()` when cooldown
 * is active — never persisted as a row.)
 */

import type Database from 'better-sqlite3';
import { chismosoDb } from './db-chismoso';
import { chismosoWritableDb } from './db-chismoso-writable';
import type { Anomaly } from './anomaly-detector';

// ---------------------------------------------------------------------------
// ENUMS
// ---------------------------------------------------------------------------

export enum AlertStatus {
  DETECTED = 'DETECTED',
  SENT = 'SENT',
  ACKNOWLEDGED = 'ACKNOWLEDGED',
  RESOLVED = 'RESOLVED',
  SUPPRESSED = 'SUPPRESSED',
}

export enum AlertSeverity {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

export enum AlertPriority {
  P1 = 'P1',
  P2 = 'P2',
  P3 = 'P3',
  P4 = 'P4',
}

export const ACTIVE_STATUSES: AlertStatus[] = [
  AlertStatus.DETECTED,
  AlertStatus.SENT,
  AlertStatus.ACKNOWLEDGED,
];

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface Alert {
  id: string;
  anomaly_id?: string;
  topic: string;
  type: string;
  severity: AlertSeverity;
  priority: AlertPriority;
  title: string;
  description: string;
  recommended_action: string;
  evidence_summary: string;
  confidence: number;
  zscore?: number;
  detected_at: string;
  sent_at?: string;
  acknowledged_at?: string;
  acknowledged_by?: string;
  resolved_at?: string;
  resolution_note?: string;
  status: AlertStatus;
  dedup_key: string;
  cooldown_until?: string;
  related_investigation_id?: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export interface EmitResult {
  alert: Alert | null;
  suppressed: boolean;
  reason: string;
}

export function makeDedupKey(topic: string, type: string): string {
  return `${topic}:${type}`;
}

// ---------------------------------------------------------------------------
// ROW SHAPE
// ---------------------------------------------------------------------------

interface AlertRow {
  id: string;
  anomaly_id: string | null;
  topic: string;
  type: string;
  severity: string;
  priority: string;
  title: string;
  description: string | null;
  recommended_action: string | null;
  evidence_summary: string | null;
  confidence: number | null;
  zscore: number | null;
  detected_at: string;
  sent_at: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  status: string;
  dedup_key: string;
  cooldown_until: string | null;
  related_investigation_id: string | null;
  metadata_json: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// REPOSITORY
// ---------------------------------------------------------------------------

type DbLike = Database.Database;

export class AlertRepository {
  constructor(
    private reader: DbLike = chismosoDb,
    private writer: DbLike = chismosoWritableDb,
  ) {}

  insert(alert: Omit<Alert, 'created_at'> & { created_at?: string }): Alert {
    const now = new Date().toISOString();
    const createdAt = alert.created_at ?? now;
    const metadataJson = alert.metadata ? JSON.stringify(alert.metadata) : null;

    this.writer.prepare(`
      INSERT INTO alerts (
        id, anomaly_id, topic, type, severity, priority,
        title, description, recommended_action, evidence_summary,
        confidence, zscore, detected_at, sent_at,
        acknowledged_at, acknowledged_by, resolved_at, resolution_note,
        status, dedup_key, cooldown_until, related_investigation_id,
        metadata_json, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      alert.id,
      alert.anomaly_id ?? null,
      alert.topic,
      alert.type,
      alert.severity,
      alert.priority,
      alert.title,
      alert.description ?? null,
      alert.recommended_action ?? null,
      alert.evidence_summary ?? null,
      alert.confidence ?? null,
      alert.zscore ?? null,
      alert.detected_at,
      alert.sent_at ?? null,
      alert.acknowledged_at ?? null,
      alert.acknowledged_by ?? null,
      alert.resolved_at ?? null,
      alert.resolution_note ?? null,
      alert.status,
      alert.dedup_key,
      alert.cooldown_until ?? null,
      alert.related_investigation_id ?? null,
      metadataJson,
      createdAt,
    );

    return this.findById(alert.id)!;
  }

  updateStatus(id: string, status: AlertStatus, extra: Partial<Alert> = {}): void {
    const sets: string[] = ['status = ?'];
    const vals: (string | number | null)[] = [status];

    const fieldMap: Record<string, string> = {
      sent_at: 'sent_at',
      acknowledged_at: 'acknowledged_at',
      acknowledged_by: 'acknowledged_by',
      resolved_at: 'resolved_at',
      resolution_note: 'resolution_note',
      severity: 'severity',
      priority: 'priority',
      title: 'title',
      description: 'description',
      recommended_action: 'recommended_action',
      evidence_summary: 'evidence_summary',
      confidence: 'confidence',
      zscore: 'zscore',
      cooldown_until: 'cooldown_until',
      related_investigation_id: 'related_investigation_id',
    };

    for (const [k, v] of Object.entries(extra)) {
      const column = fieldMap[k];
      if (!column) continue;
      sets.push(`${column} = ?`);
      vals.push(v as string | number | null);
    }

    vals.push(id);
    this.writer.prepare(`UPDATE alerts SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  acknowledge(id: string, by: string): void {
    const now = new Date().toISOString();
    this.writer.prepare(`
      UPDATE alerts
      SET status = ?,
          acknowledged_at = ?,
          acknowledged_by = ?
      WHERE id = ?
    `).run(AlertStatus.ACKNOWLEDGED, now, by, id);
  }

  resolve(id: string, note: string): void {
    const now = new Date().toISOString();
    this.writer.prepare(`
      UPDATE alerts
      SET status = ?,
          resolved_at = ?,
          resolution_note = ?
      WHERE id = ?
    `).run(AlertStatus.RESOLVED, now, note, id);
  }

  findById(id: string): Alert | null {
    const row = this.reader.prepare('SELECT * FROM alerts WHERE id = ?').get(id) as AlertRow | undefined;
    return row ? parseAlertRow(row) : null;
  }

  findByDedupKey(key: string): Alert | null {
    const row = this.reader
      .prepare('SELECT * FROM alerts WHERE dedup_key = ? ORDER BY created_at DESC, id DESC LIMIT 1')
      .get(key) as AlertRow | undefined;
    return row ? parseAlertRow(row) : null;
  }

  findActive(): Alert[] {
    const placeholders = ACTIVE_STATUSES.map(() => '?').join(',');
    const rows = this.reader
      .prepare(`SELECT * FROM alerts WHERE status IN (${placeholders}) ORDER BY detected_at DESC`)
      .all(...ACTIVE_STATUSES) as AlertRow[];
    return rows.map(parseAlertRow);
  }

  findByStatus(status: AlertStatus): Alert[] {
    const rows = this.reader
      .prepare('SELECT * FROM alerts WHERE status = ? ORDER BY detected_at DESC')
      .all(status) as AlertRow[];
    return rows.map(parseAlertRow);
  }

  findByTopic(topic: string): Alert[] {
    const rows = this.reader
      .prepare('SELECT * FROM alerts WHERE topic = ? ORDER BY detected_at DESC')
      .all(topic) as AlertRow[];
    return rows.map(parseAlertRow);
  }

  listRecent(limit: number): Alert[] {
    const rows = this.reader
      .prepare('SELECT * FROM alerts ORDER BY detected_at DESC, created_at DESC LIMIT ?')
      .all(limit) as AlertRow[];
    return rows.map(parseAlertRow);
  }

  list(opts: {
    status?: AlertStatus;
    priority?: AlertPriority;
    topic?: string;
    severity?: AlertSeverity;
    limit?: number;
  }): Alert[] {
    const where: string[] = [];
    const vals: (string | number)[] = [];
    if (opts.status) {
      where.push('status = ?');
      vals.push(opts.status);
    }
    if (opts.priority) {
      where.push('priority = ?');
      vals.push(opts.priority);
    }
    if (opts.severity) {
      where.push('severity = ?');
      vals.push(opts.severity);
    }
    if (opts.topic) {
      where.push('topic = ?');
      vals.push(opts.topic);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = opts.limit ?? 100;
    const rows = this.reader
      .prepare(`SELECT * FROM alerts ${whereSql} ORDER BY detected_at DESC, created_at DESC LIMIT ?`)
      .all(...vals, limit) as AlertRow[];
    return rows.map(parseAlertRow);
  }

  stats(): {
    byStatus: Record<string, number>;
    bySeverity: Record<string, number>;
    byPriority: Record<string, number>;
    total: number;
  } {
    const byStatus: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    const byPriority: Record<string, number> = {};
    let total = 0;
    for (const s of Object.values(AlertStatus)) byStatus[s] = 0;
    for (const s of ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']) bySeverity[s] = 0;
    for (const p of ['P1', 'P2', 'P3', 'P4']) byPriority[p] = 0;

    try {
      const rows = this.reader
        .prepare('SELECT status, severity, priority FROM alerts')
        .all() as Array<{ status: string; severity: string; priority: string }>;
      for (const r of rows) {
        byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
        bySeverity[r.severity] = (bySeverity[r.severity] ?? 0) + 1;
        byPriority[r.priority] = (byPriority[r.priority] ?? 0) + 1;
        total++;
      }
    } catch {
      // Table may not exist yet on a fresh install — return zeros.
    }
    return { byStatus, bySeverity, byPriority, total };
  }
}

// ---------------------------------------------------------------------------
// MANAGER
// ---------------------------------------------------------------------------

export interface AlertManagerOptions {
  cooldownMinutes?: number;
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

  emit(anomaly: Anomaly, investigationId?: string): EmitResult {
    const dedupKey = makeDedupKey(anomaly.topic, anomaly.type);
    const existing = this.repo.findByDedupKey(dedupKey);

    if (existing && existing.status !== AlertStatus.RESOLVED) {
      const cooldownUntilMs = existing.cooldown_until
        ? new Date(existing.cooldown_until).getTime()
        : 0;
      if (cooldownUntilMs > Date.now()) {
        return {
          alert: null,
          suppressed: true,
          reason: 'cooldown active',
        };
      }
    }

    const severity = this.mapSeverity(anomaly);
    const priority = this.mapPriority(severity);

    const detectedAt = anomaly.observedAt ?? new Date().toISOString();
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
      confidence: 0.5,
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
        sent_at: new Date().toISOString(),
      });
    }

    return {
      alert: this.repo.findById(inserted.id) ?? inserted,
      suppressed: false,
      reason: 'emitted',
    };
  }

  markSent(id: string): void {
    this.repo.updateStatus(id, AlertStatus.SENT, {
      sent_at: new Date().toISOString(),
    });
  }

  acknowledge(id: string, by: string = 'user'): void {
    this.repo.acknowledge(id, by);
  }

  resolve(id: string, note: string = 'auto-resolved'): void {
    this.repo.resolve(id, note);
  }

  /**
   * For every active SENT alert whose dedup_key is NOT in the set of
   * currently-detected anomalies, move it to RESOLVED. Returns the count.
   *
   * Only SENT alerts are auto-resolved. DETECTED alerts (never delivered)
   * are left alone — they'll auto-expire on cooldown. ACKNOWLEDGED alerts
   * are left for the human to formally close (they're already being acted
   * on).
   */
  autoResolve(currentAnomalies: Anomaly[]): { resolved: number } {
    const active = this.repo.findActive();
    if (active.length === 0) return { resolved: 0 };

    const detectedKeys = new Set(currentAnomalies.map((a) => `${a.topic}:${a.type}`));

    let resolved = 0;
    for (const alert of active) {
      if (alert.status !== AlertStatus.SENT) continue;
      if (!detectedKeys.has(alert.dedup_key)) {
        this.resolve(alert.id, 'anomaly cleared');
        resolved++;
      }
    }
    return { resolved };
  }

  private mapSeverity(anomaly: Anomaly): AlertSeverity {
    const z = Math.abs(anomaly.zscore);
    if (z > 4 || anomaly.severity === 'high') return AlertSeverity.CRITICAL;
    if (z > 3 || anomaly.severity === 'medium') return AlertSeverity.HIGH;
    if (z > 2) return AlertSeverity.MEDIUM;
    return AlertSeverity.LOW;
  }

  private mapPriority(severity: AlertSeverity): AlertPriority {
    switch (severity) {
      case AlertSeverity.CRITICAL: return AlertPriority.P1;
      case AlertSeverity.HIGH:     return AlertPriority.P2;
      case AlertSeverity.MEDIUM:   return AlertPriority.P3;
      case AlertSeverity.LOW:      return AlertPriority.P4;
    }
  }

  private buildTitle(anomaly: Anomaly): string {
    const typeLabel = anomaly.type.replace(/_/g, ' ');
    return `${typeLabel} en "${anomaly.topic}"`;
  }

  private buildEvidenceSummary(anomaly: Anomaly): string {
    const z = Number.isFinite(anomaly.zscore)
      ? anomaly.zscore.toFixed(2)
      : 'n/a';
    const mean = Number.isFinite(anomaly.baseline.mean)
      ? anomaly.baseline.mean.toFixed(2)
      : 'n/a';
    return `z=${z}, baseline mean=${mean}, current=${anomaly.currentValue}`;
  }
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function parseAlertRow(r: AlertRow): Alert {
  return {
    id: r.id,
    anomaly_id: r.anomaly_id ?? undefined,
    topic: r.topic,
    type: r.type,
    severity: r.severity as AlertSeverity,
    priority: r.priority as AlertPriority,
    title: r.title,
    description: r.description ?? '',
    recommended_action: r.recommended_action ?? '',
    evidence_summary: r.evidence_summary ?? '',
    confidence: r.confidence ?? 0,
    zscore: r.zscore ?? undefined,
    detected_at: r.detected_at,
    sent_at: r.sent_at ?? undefined,
    acknowledged_at: r.acknowledged_at ?? undefined,
    acknowledged_by: r.acknowledged_by ?? undefined,
    resolved_at: r.resolved_at ?? undefined,
    resolution_note: r.resolution_note ?? undefined,
    status: r.status as AlertStatus,
    dedup_key: r.dedup_key,
    cooldown_until: r.cooldown_until ?? undefined,
    related_investigation_id: r.related_investigation_id ?? undefined,
    metadata: r.metadata_json ? safeParse(r.metadata_json) : undefined,
    created_at: r.created_at,
  };
}

function safeParse(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function generateId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${ts}${rnd}`;
}

// ---------------------------------------------------------------------------
// SINGLETON (for API routes)
// ---------------------------------------------------------------------------

/**
 * Process-wide AlertRepository + AlertManager singletons. The repository
 * uses the readonly singleton for reads (cheap, shareable) and the
 * writable singleton for writes (one writer at a time, serialized by
 * SQLite's WAL).
 *
 * API routes import these directly so they don't pay the construction
 * cost per request.
 */
export const alertRepository = new AlertRepository();
export const alertManager = new AlertManager(alertRepository);

/**
 * Convenience: emit an Alert for each anomaly in the given list.
 * Suppressed emissions are silently dropped (cooldown / dedup is the
 * manager's job). Returns the number of alerts that were actually
 * persisted by this call.
 *
 * Used by `/api/anomalies` and the dashboard's refresh cycle to keep
 * the alerts table populated as anomalies fire.
 */
export function emitAlertsForAnomalies(anomalies: Anomaly[]): {
  emitted: number;
  suppressed: number;
} {
  let emitted = 0;
  let suppressed = 0;
  for (const a of anomalies) {
    try {
      const result = alertManager.emit(a);
      if (result.suppressed) suppressed++;
      else emitted++;
    } catch {
      // Persistence failures are non-fatal — the anomaly list is still
      // returned to the caller. Logged via console.error for visibility.
      console.error('[alerts] emit failed for', a.topic, a.type);
    }
  }
  return { emitted, suppressed };
}
