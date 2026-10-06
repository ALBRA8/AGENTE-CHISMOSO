/**
 * Unit tests — Alerts (Task IMP-4, spec §20)
 *
 * Verifies the full lifecycle: DETECTED → SENT → ACKNOWLEDGED → RESOLVED,
 * the dedup/cooldown suppression, severity/priority mapping, and
 * auto-resolution.
 *
 * Uses an in-memory ChismosoDB so the AlertRepository can run its raw SQL
 * queries against the `alerts` table directly. The same DB instance is
 * also used to construct an AnomalyDetector + Repositories for the
 * autoResolve test (so detectAll() reflects real observation history).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChismosoDB } from '../src/db.js';
import { Repositories } from '../src/repositories.js';
import {
  AlertRepository,
  AlertManager,
  AlertStatus,
  AlertSeverity,
  AlertPriority,
  makeDedupKey,
  type AnomalyLike,
  type AnomalyDetectorLike,
} from '../src/alerts/index.js';
import { AnomalyDetector } from '../src/anomaly/index.js';

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function insertObservation(
  db: ChismosoDB,
  topic: string,
  observedAt: string,
  signalsCount: number,
  confidence: number,
  sourcesCount = 1,
  evidenceCount = 0,
): void {
  db.prepare(
    `INSERT INTO topic_observations (topic, observed_at, sources_count, signals_count, evidence_count, confidence, note)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  ).run(topic, observedAt, sourcesCount, signalsCount, evidenceCount, confidence);
}

function iso(daysAgo: number): string {
  const d = new Date(Date.UTC(2024, 0, 1 + daysAgo, 0, 0, 0));
  return d.toISOString();
}

/**
 * Construct a minimal AnomalyLike for direct manager.emit() tests (no
 * detector needed). Each field that the manager reads is populated.
 *
 * `severity` defaults to 'low' so the manager's severity-mapping override
 * (`severity === 'high' → CRITICAL`) doesn't accidentally fire on the
 * pure-zscore tests. Tests that explicitly want to verify the severity
 * override pass `severity: 'high'` (or 'medium').
 */
function makeAnomaly(opts: {
  topic: string;
  type?: string;
  severity?: 'low' | 'medium' | 'high';
  observedAt?: string;
  zscore?: number;
  signalsCount?: number;
  baselineMean?: number;
  currentValue?: number;
  confidence?: number;
}): AnomalyLike {
  const z = opts.zscore ?? 2.5;
  const sev = opts.severity ?? 'low';
  return {
    id: `anm_${opts.type ?? 'volume_spike'}__${opts.topic}__${opts.observedAt ?? iso(0)}`,
    topic: opts.topic,
    type: opts.type ?? 'volume_spike',
    severity: sev,
    observedAt: opts.observedAt ?? iso(0),
    baseline: {
      mean: opts.baselineMean ?? 5,
      stddev: 1,
      windowDays: 30,
      samples: 10,
    },
    currentValue: opts.currentValue ?? opts.signalsCount ?? 10,
    zscore: z,
    description: `Test anomaly on ${opts.topic} (z=${z}).`,
    recommendedAction: 'Investigate this anomaly.',
    confidence: opts.confidence ?? 0.5,
  };
}

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

describe('AlertRepository', () => {
  let db: ChismosoDB;
  let repo: AlertRepository;

  beforeEach(() => {
    db = new ChismosoDB({ path: ':memory:' });
    repo = new AlertRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('inserts an alert and reads it back by id', () => {
    const alert = {
      id: 'alert_test1',
      topic: 't',
      type: 'volume_spike',
      severity: AlertSeverity.HIGH,
      priority: AlertPriority.P2,
      title: 'volume spike en "t"',
      description: 'A spike.',
      recommended_action: 'Investigate.',
      evidence_summary: 'z=3.10, mean=5.00, current=15',
      confidence: 0.5,
      zscore: 3.1,
      detected_at: new Date().toISOString(),
      status: AlertStatus.DETECTED,
      dedup_key: makeDedupKey('t', 'volume_spike'),
    };
    const inserted = repo.insert(alert);
    expect(inserted.id).toBe('alert_test1');
    expect(inserted.topic).toBe('t');
    expect(inserted.severity).toBe(AlertSeverity.HIGH);
    expect(inserted.priority).toBe(AlertPriority.P2);
    expect(inserted.created_at).toBeTruthy();

    const byId = repo.findById('alert_test1');
    expect(byId).not.toBeNull();
    expect(byId!.topic).toBe('t');
  });

  it('returns null when id does not exist', () => {
    expect(repo.findById('does_not_exist')).toBeNull();
  });

  it('findByDedupKey returns the most recent of multiple rows with the same key', () => {
    // Insert two alerts with the same dedup_key but different created_at.
    const base = {
      topic: 't',
      type: 'volume_spike',
      severity: AlertSeverity.MEDIUM,
      priority: AlertPriority.P3,
      title: 'spike',
      description: 'd',
      recommended_action: 'r',
      evidence_summary: 'e',
      confidence: 0.5,
      zscore: 2.5,
      detected_at: iso(0),
      status: AlertStatus.DETECTED,
      dedup_key: makeDedupKey('t', 'volume_spike'),
    };
    repo.insert({ ...base, id: 'alert_old', created_at: '2024-01-01T00:00:00.000Z' });
    repo.insert({ ...base, id: 'alert_new', created_at: '2024-02-01T00:00:00.000Z' });

    const latest = repo.findByDedupKey(makeDedupKey('t', 'volume_spike'));
    expect(latest).not.toBeNull();
    expect(latest!.id).toBe('alert_new');
  });

  it('acknowledge() sets acknowledged_at + acknowledged_by and moves status to ACKNOWLEDGED', () => {
    const alert = repo.insert({
      id: 'alert_ack',
      topic: 't', type: 'volume_spike',
      severity: AlertSeverity.HIGH, priority: AlertPriority.P2,
      title: 't', description: 'd', recommended_action: 'r', evidence_summary: 'e',
      confidence: 0.5, zscore: 3,
      detected_at: iso(0), status: AlertStatus.SENT,
      dedup_key: makeDedupKey('t', 'volume_spike'),
    });
    repo.acknowledge(alert.id, 'ops-alice');
    const updated = repo.findById(alert.id)!;
    expect(updated.status).toBe(AlertStatus.ACKNOWLEDGED);
    expect(updated.acknowledged_by).toBe('ops-alice');
    expect(updated.acknowledged_at).toBeTruthy();
  });

  it('resolve() sets resolved_at + resolution_note and moves status to RESOLVED', () => {
    const alert = repo.insert({
      id: 'alert_res',
      topic: 't', type: 'volume_spike',
      severity: AlertSeverity.HIGH, priority: AlertPriority.P2,
      title: 't', description: 'd', recommended_action: 'r', evidence_summary: 'e',
      confidence: 0.5, zscore: 3,
      detected_at: iso(0), status: AlertStatus.ACKNOWLEDGED,
      dedup_key: makeDedupKey('t', 'volume_spike'),
    });
    repo.resolve(alert.id, 'false positive');
    const updated = repo.findById(alert.id)!;
    expect(updated.status).toBe(AlertStatus.RESOLVED);
    expect(updated.resolution_note).toBe('false positive');
    expect(updated.resolved_at).toBeTruthy();
  });

  it('findActive() returns DETECTED + SENT + ACKNOWLEDGED but not RESOLVED', () => {
    const make = (id: string, status: AlertStatus) => repo.insert({
      id, topic: 't', type: 'volume_spike',
      severity: AlertSeverity.MEDIUM, priority: AlertPriority.P3,
      title: 't', description: 'd', recommended_action: 'r', evidence_summary: 'e',
      confidence: 0.5, zscore: 2.5,
      detected_at: iso(0), status,
      dedup_key: makeDedupKey('t', 'volume_spike') + '_' + id,
    });
    make('a1', AlertStatus.DETECTED);
    make('a2', AlertStatus.SENT);
    make('a3', AlertStatus.ACKNOWLEDGED);
    make('a4', AlertStatus.RESOLVED);
    const active = repo.findActive();
    const ids = active.map((a) => a.id).sort();
    expect(ids).toEqual(['a1', 'a2', 'a3']);
  });

  it('list() filters by status, priority, topic, severity', () => {
    const mk = (id: string, severity: AlertSeverity, priority: AlertPriority, topic: string, status: AlertStatus) =>
      repo.insert({
        id, topic, type: 'volume_spike',
        severity, priority,
        title: 't', description: 'd', recommended_action: 'r', evidence_summary: 'e',
        confidence: 0.5, zscore: 2.5,
        detected_at: iso(0), status,
        dedup_key: makeDedupKey(topic, 'volume_spike') + '_' + id,
      });
    mk('a1', AlertSeverity.CRITICAL, AlertPriority.P1, 't1', AlertStatus.SENT);
    mk('a2', AlertSeverity.HIGH, AlertPriority.P2, 't2', AlertStatus.DETECTED);
    mk('a3', AlertSeverity.MEDIUM, AlertPriority.P3, 't1', AlertStatus.ACKNOWLEDGED);

    expect(repo.list({ status: AlertStatus.SENT }).map((a) => a.id)).toEqual(['a1']);
    expect(repo.list({ priority: AlertPriority.P2 }).map((a) => a.id)).toEqual(['a2']);
    expect(repo.list({ topic: 't1' }).map((a) => a.id).sort()).toEqual(['a1', 'a3']);
    expect(repo.list({ severity: AlertSeverity.CRITICAL }).map((a) => a.id)).toEqual(['a1']);
  });

  it('stats() aggregates counts by status, severity, priority', () => {
    const mk = (id: string, severity: AlertSeverity, priority: AlertPriority, status: AlertStatus) =>
      repo.insert({
        id, topic: 't', type: 'volume_spike',
        severity, priority,
        title: 't', description: 'd', recommended_action: 'r', evidence_summary: 'e',
        confidence: 0.5, zscore: 2.5,
        detected_at: iso(0), status,
        dedup_key: makeDedupKey('t', 'volume_spike') + '_' + id,
      });
    mk('a1', AlertSeverity.CRITICAL, AlertPriority.P1, AlertStatus.SENT);
    mk('a2', AlertSeverity.HIGH, AlertPriority.P2, AlertStatus.DETECTED);
    mk('a3', AlertSeverity.CRITICAL, AlertPriority.P1, AlertStatus.RESOLVED);

    const s = repo.stats();
    expect(s.total).toBe(3);
    expect(s.bySeverity.CRITICAL).toBe(2);
    expect(s.bySeverity.HIGH).toBe(1);
    expect(s.byPriority.P1).toBe(2);
    expect(s.byPriority.P2).toBe(1);
    expect(s.byStatus.RESOLVED).toBe(1);
    expect(s.byStatus.SENT).toBe(1);
    expect(s.byStatus.DETECTED).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AlertManager.emit — lifecycle + dedup + cooldown
// ---------------------------------------------------------------------------

describe('AlertManager.emit', () => {
  let db: ChismosoDB;
  let repo: AlertRepository;
  let manager: AlertManager;

  beforeEach(() => {
    db = new ChismosoDB({ path: ':memory:' });
    repo = new AlertRepository(db);
    manager = new AlertManager(repo, { cooldownMinutes: 60 });
  });

  afterEach(() => {
    db.close();
  });

  it('creates a new alert with status DETECTED on first emit', () => {
    const anomaly = makeAnomaly({ topic: 't', zscore: 3.2 });
    const result = manager.emit(anomaly);
    expect(result.suppressed).toBe(false);
    expect(result.alert).not.toBeNull();
    expect(result.alert!.status).toBe(AlertStatus.DETECTED);
    expect(result.alert!.topic).toBe('t');
    expect(result.alert!.type).toBe('volume_spike');
    expect(result.alert!.dedup_key).toBe('t:volume_spike');
    expect(result.alert!.cooldown_until).toBeTruthy();
    expect(result.alert!.anomaly_id).toBe(anomaly.id);
  });

  it('suppresses a second emit within the cooldown window', () => {
    const anomaly = makeAnomaly({ topic: 't', zscore: 3.2 });
    const r1 = manager.emit(anomaly);
    expect(r1.suppressed).toBe(false);

    const r2 = manager.emit(anomaly);
    expect(r2.suppressed).toBe(true);
    expect(r2.alert).toBeNull();
    expect(r2.reason).toBe('cooldown active');

    // Only one row in DB.
    const active = repo.findActive();
    expect(active.length).toBe(1);
  });

  it('creates a new alert after the cooldown has expired', () => {
    // Use a manager with cooldownMinutes = 0 so cooldown expires immediately.
    const fastManager = new AlertManager(repo, { cooldownMinutes: 0 });
    const anomaly = makeAnomaly({ topic: 't', zscore: 3.2 });
    const r1 = fastManager.emit(anomaly);
    expect(r1.suppressed).toBe(false);

    // Force cooldown_until into the past so the next emit sees it expired.
    const existing = repo.findByDedupKey('t:volume_spike')!;
    repo.updateStatus(existing.id, AlertStatus.DETECTED, {
      cooldown_until: new Date(Date.now() - 1000).toISOString(),
    });

    const r2 = fastManager.emit(anomaly);
    expect(r2.suppressed).toBe(false);
    expect(r2.alert).not.toBeNull();
    expect(r2.alert!.id).not.toBe(r1.alert!.id);

    // Two rows now.
    const all = repo.list({ limit: 100 });
    expect(all.length).toBe(2);
  });

  it('emits a new alert if the previous one is RESOLVED (no cooldown after terminal)', () => {
    const anomaly = makeAnomaly({ topic: 't', zscore: 3.2 });
    const r1 = manager.emit(anomaly);
    repo.resolve(r1.alert!.id, 'manually closed');

    const r2 = manager.emit(anomaly);
    expect(r2.suppressed).toBe(false);
    expect(r2.alert).not.toBeNull();
    expect(r2.alert!.id).not.toBe(r1.alert!.id);
    expect(r2.alert!.status).toBe(AlertStatus.DETECTED);
  });

  it('maps severity from |zscore| and anomaly.severity correctly', () => {
    // z=4.5 → CRITICAL
    expect(manager.emit(makeAnomaly({ topic: 'z', zscore: 4.5 })).alert!.severity)
      .toBe(AlertSeverity.CRITICAL);
    // z=3.2 → HIGH (also severity='high' since detector classifies >3 as high)
    expect(manager.emit(makeAnomaly({ topic: 'z', type: 'velocity_change', zscore: 3.2 })).alert!.severity)
      .toBe(AlertSeverity.HIGH);
    // z=2.1 → MEDIUM
    expect(manager.emit(makeAnomaly({ topic: 'z', type: 'confidence_drift', zscore: 2.1 })).alert!.severity)
      .toBe(AlertSeverity.MEDIUM);
    // z=1.5 → LOW
    expect(manager.emit(makeAnomaly({ topic: 'z', type: 'source_diversification', zscore: 1.5, severity: 'low' })).alert!.severity)
      .toBe(AlertSeverity.LOW);

    // anomaly.severity='high' forces CRITICAL regardless of zscore
    expect(manager.emit(makeAnomaly({ topic: 'z', type: 'volume_drop', zscore: 2.1, severity: 'high' })).alert!.severity)
      .toBe(AlertSeverity.CRITICAL);
  });

  it('maps priority from severity (CRITICAL→P1, HIGH→P2, MEDIUM→P3, LOW→P4)', () => {
    // severity='low' on every anomaly so the manager's severity override
    // doesn't fire — we want to test the pure zscore → severity → priority
    // chain.
    const emit = (z: number, t: string) =>
      manager.emit(makeAnomaly({ topic: 'p', type: t, zscore: z, severity: 'low' })).alert?.priority ?? null;
    expect(emit(4.5, 'volume_spike')).toBe(AlertPriority.P1);
    expect(emit(3.2, 'volume_drop')).toBe(AlertPriority.P2);
    expect(emit(2.1, 'velocity_change')).toBe(AlertPriority.P3);
    expect(emit(1.5, 'confidence_drift')).toBe(AlertPriority.P4);
  });

  it('stores metadata with baseline + currentValue', () => {
    const anomaly = makeAnomaly({ topic: 't', zscore: 3, baselineMean: 5, currentValue: 15, severity: 'medium' });
    const result = manager.emit(anomaly);
    expect(result.alert!.metadata).toBeDefined();
    expect(result.alert!.metadata!.baseline).toEqual({ mean: 5, stddev: 1, windowDays: 30, samples: 10 });
    expect(result.alert!.metadata!.currentValue).toBe(15);
    expect(result.alert!.metadata!.anomalySeverity).toBe('medium');
  });

  it('builds title from type + topic', () => {
    const result = manager.emit(makeAnomaly({ topic: 'restaurantes', type: 'volume_spike', zscore: 3 }));
    expect(result.alert!.title).toContain('volume spike');
    expect(result.alert!.title).toContain('restaurantes');
  });

  it('builds evidence summary with z + baseline mean + current', () => {
    const result = manager.emit(makeAnomaly({ topic: 't', zscore: 3.21, baselineMean: 5.5, currentValue: 15 }));
    expect(result.alert!.evidence_summary).toContain('z=3.21');
    expect(result.alert!.evidence_summary).toContain('mean=5.50');
    expect(result.alert!.evidence_summary).toContain('current=15');
  });
});

// ---------------------------------------------------------------------------
// AlertManager lifecycle transitions
// ---------------------------------------------------------------------------

describe('AlertManager lifecycle', () => {
  let db: ChismosoDB;
  let repo: AlertRepository;
  let manager: AlertManager;

  beforeEach(() => {
    db = new ChismosoDB({ path: ':memory:' });
    repo = new AlertRepository(db);
    manager = new AlertManager(repo, { cooldownMinutes: 60 });
  });

  afterEach(() => {
    db.close();
  });

  it('markSent() promotes DETECTED → SENT', () => {
    const alert = manager.emit(makeAnomaly({ topic: 't', zscore: 3 })).alert!;
    expect(alert.status).toBe(AlertStatus.DETECTED);

    manager.markSent(alert.id);
    const updated = repo.findById(alert.id)!;
    expect(updated.status).toBe(AlertStatus.SENT);
    expect(updated.sent_at).toBeTruthy();
  });

  it('acknowledge() promotes SENT → ACKNOWLEDGED', () => {
    const alert = manager.emit(makeAnomaly({ topic: 't', zscore: 3 })).alert!;
    manager.markSent(alert.id);
    manager.acknowledge(alert.id, 'ops-alice');

    const updated = repo.findById(alert.id)!;
    expect(updated.status).toBe(AlertStatus.ACKNOWLEDGED);
    expect(updated.acknowledged_by).toBe('ops-alice');
    expect(updated.acknowledged_at).toBeTruthy();
  });

  it('resolve() moves any state → RESOLVED', () => {
    const alert = manager.emit(makeAnomaly({ topic: 't', zscore: 3 })).alert!;
    manager.resolve(alert.id, 'cleared');

    const updated = repo.findById(alert.id)!;
    expect(updated.status).toBe(AlertStatus.RESOLVED);
    expect(updated.resolution_note).toBe('cleared');
    expect(updated.resolved_at).toBeTruthy();
  });

  it('full lifecycle: DETECTED → SENT → ACKNOWLEDGED → RESOLVED', () => {
    const alert = manager.emit(makeAnomaly({ topic: 't', zscore: 3 })).alert!;
    expect(alert.status).toBe(AlertStatus.DETECTED);

    manager.markSent(alert.id);
    expect(repo.findById(alert.id)!.status).toBe(AlertStatus.SENT);

    manager.acknowledge(alert.id, 'user');
    expect(repo.findById(alert.id)!.status).toBe(AlertStatus.ACKNOWLEDGED);

    manager.resolve(alert.id, 'done');
    expect(repo.findById(alert.id)!.status).toBe(AlertStatus.RESOLVED);
  });
});

// ---------------------------------------------------------------------------
// AlertManager.autoResolve — anomaly cleared → alert auto-resolved
// ---------------------------------------------------------------------------

describe('AlertManager.autoResolve', () => {
  let db: ChismosoDB;
  let repo: AlertRepository;
  let manager: AlertManager;

  beforeEach(() => {
    db = new ChismosoDB({ path: ':memory:' });
    repo = new AlertRepository(db);
    manager = new AlertManager(repo, { cooldownMinutes: 60 });
  });

  afterEach(() => {
    db.close();
  });

  it('auto-resolves SENT alerts whose anomaly has cleared (not in current detection)', () => {
    // Pre-populate: create an alert with dedup_key 't1:volume_spike' that's SENT.
    repo.insert({
      id: 'alert_old', topic: 't1', type: 'volume_spike',
      severity: AlertSeverity.HIGH, priority: AlertPriority.P2,
      title: 'old', description: 'd', recommended_action: 'r', evidence_summary: 'e',
      confidence: 0.5, zscore: 3,
      detected_at: iso(-10), status: AlertStatus.SENT,
      dedup_key: 't1:volume_spike',
    });

    // Detector returns anomalies for a DIFFERENT topic — so 't1:volume_spike'
    // is NOT in the currently-detected set → auto-resolve.
    const detector: AnomalyDetectorLike = {
      detectAll: () => [makeAnomaly({ topic: 't2', zscore: 3.5 })],
    };

    const result = manager.autoResolve(detector);
    expect(result.resolved).toBe(1);

    const updated = repo.findById('alert_old')!;
    expect(updated.status).toBe(AlertStatus.RESOLVED);
    expect(updated.resolution_note).toBe('anomaly cleared');
  });

  it('does NOT auto-resolve alerts whose anomaly is still active', () => {
    repo.insert({
      id: 'alert_active', topic: 't1', type: 'volume_spike',
      severity: AlertSeverity.HIGH, priority: AlertPriority.P2,
      title: 'active', description: 'd', recommended_action: 'r', evidence_summary: 'e',
      confidence: 0.5, zscore: 3,
      detected_at: iso(-1), status: AlertStatus.SENT,
      dedup_key: 't1:volume_spike',
    });

    const detector: AnomalyDetectorLike = {
      detectAll: () => [makeAnomaly({ topic: 't1', type: 'volume_spike', zscore: 3 })],
    };

    const result = manager.autoResolve(detector);
    expect(result.resolved).toBe(0);
    expect(repo.findById('alert_active')!.status).toBe(AlertStatus.SENT);
  });

  it('does NOT auto-resolve DETECTED alerts (only SENT)', () => {
    repo.insert({
      id: 'alert_detected', topic: 't1', type: 'volume_spike',
      severity: AlertSeverity.HIGH, priority: AlertPriority.P2,
      title: 'detected', description: 'd', recommended_action: 'r', evidence_summary: 'e',
      confidence: 0.5, zscore: 3,
      detected_at: iso(-10), status: AlertStatus.DETECTED,
      dedup_key: 't1:volume_spike',
    });

    const detector: AnomalyDetectorLike = { detectAll: () => [] };
    const result = manager.autoResolve(detector);
    expect(result.resolved).toBe(0);
    // DETECTED alerts are left alone (they haven't been delivered yet).
    expect(repo.findById('alert_detected')!.status).toBe(AlertStatus.DETECTED);
  });

  it('does NOT auto-resolve ACKNOWLEDGED alerts (leave for human)', () => {
    repo.insert({
      id: 'alert_acked', topic: 't1', type: 'volume_spike',
      severity: AlertSeverity.HIGH, priority: AlertPriority.P2,
      title: 'acked', description: 'd', recommended_action: 'r', evidence_summary: 'e',
      confidence: 0.5, zscore: 3,
      detected_at: iso(-10), status: AlertStatus.ACKNOWLEDGED,
      dedup_key: 't1:volume_spike',
    });

    const detector: AnomalyDetectorLike = { detectAll: () => [] };
    const result = manager.autoResolve(detector);
    expect(result.resolved).toBe(0);
    expect(repo.findById('alert_acked')!.status).toBe(AlertStatus.ACKNOWLEDGED);
  });

  it('returns 0 resolved when there are no active alerts', () => {
    const detector: AnomalyDetectorLike = { detectAll: () => [] };
    expect(manager.autoResolve(detector).resolved).toBe(0);
  });

  it('returns 0 resolved when detector.detectAll() throws (defensive)', () => {
    repo.insert({
      id: 'alert_sent', topic: 't1', type: 'volume_spike',
      severity: AlertSeverity.HIGH, priority: AlertPriority.P2,
      title: 'sent', description: 'd', recommended_action: 'r', evidence_summary: 'e',
      confidence: 0.5, zscore: 3,
      detected_at: iso(-1), status: AlertStatus.SENT,
      dedup_key: 't1:volume_spike',
    });
    const detector: AnomalyDetectorLike = {
      detectAll: () => { throw new Error('DB unavailable'); },
    };
    expect(manager.autoResolve(detector).resolved).toBe(0);
    expect(repo.findById('alert_sent')!.status).toBe(AlertStatus.SENT);
  });

  it('works with the real AnomalyDetector — end-to-end auto-resolve', () => {
    // Insert observations that produce a volume_spike anomaly on topic 'spiky'.
    const counts = [5, 6, 5, 7, 5, 6, 5, 7, 6, 50];
    counts.forEach((c, i) => insertObservation(db, 'spiky', iso(i), c, 0.5));
    // Insert stable observations on 'stable' (no anomaly).
    for (let i = 0; i < 10; i++) insertObservation(db, 'stable', iso(i), 5, 0.5);

    const repos = new Repositories(db);
    const detector = new AnomalyDetector(repos);

    // First detection: emits alerts for 'spiky:volume_spike'.
    const detected1 = detector.detectAll();
    expect(detected1.length).toBeGreaterThan(0);

    // Manager-based emit (detector wasn't wired to the manager — call directly).
    const dedupKeys = new Set<string>();
    for (const a of detected1) {
      const r = manager.emit(a);
      if (r.alert) dedupKeys.add(r.alert.dedup_key);
    }
    expect(dedupKeys.has('spiky:volume_spike')).toBe(true);

    // Mark all emitted alerts as SENT so they're eligible for auto-resolve.
    for (const a of repo.findActive()) manager.markSent(a.id);

    // Now simulate the spike clearing — overwrite the latest observation
    // with a value close to the baseline so detection no longer fires.
    db.prepare('DELETE FROM topic_observations WHERE topic = ?').run('spiky');
    const stable = [5, 6, 5, 7, 5, 6, 5, 7, 6, 6];
    stable.forEach((c, i) => insertObservation(db, 'spiky', iso(i), c, 0.5));

    // Re-detect — should now find NO anomalies on 'spiky'.
    const detected2 = detector.detectAll();
    const stillActive = new Set(detected2.map((a) => `${a.topic}:${a.type}`));
    expect(stillActive.has('spiky:volume_spike')).toBe(false);

    // autoResolve should move the spiky SENT alert → RESOLVED.
    const result = manager.autoResolve(detector);
    expect(result.resolved).toBe(1);

    const resolved = repo.list({ status: AlertStatus.RESOLVED });
    expect(resolved.length).toBe(1);
    expect(resolved[0].dedup_key).toBe('spiky:volume_spike');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('AlertManager edge cases', () => {
  let db: ChismosoDB;
  let repo: AlertRepository;
  let manager: AlertManager;

  beforeEach(() => {
    db = new ChismosoDB({ path: ':memory:' });
    repo = new AlertRepository(db);
    manager = new AlertManager(repo, { cooldownMinutes: 60 });
  });

  afterEach(() => {
    db.close();
  });

  it('handles anomalies with missing confidence (defaults to 0.5)', () => {
    const anomaly = makeAnomaly({ topic: 't', zscore: 3 });
    delete anomaly.confidence;
    const result = manager.emit(anomaly);
    expect(result.alert!.confidence).toBe(0.5);
  });

  it('different topics with the same type produce different dedup_keys (no cross-suppression)', () => {
    const a = manager.emit(makeAnomaly({ topic: 't1', zscore: 3 }));
    const b = manager.emit(makeAnomaly({ topic: 't2', zscore: 3 }));
    expect(a.suppressed).toBe(false);
    expect(b.suppressed).toBe(false);
    expect(a.alert!.id).not.toBe(b.alert!.id);
  });

  it('different types on the same topic produce different dedup_keys', () => {
    const a = manager.emit(makeAnomaly({ topic: 't', type: 'volume_spike', zscore: 3 }));
    const b = manager.emit(makeAnomaly({ topic: 't', type: 'velocity_change', zscore: 3 }));
    expect(a.suppressed).toBe(false);
    expect(b.suppressed).toBe(false);
  });

  it('respects a custom cooldownMinutes option', () => {
    const fastManager = new AlertManager(repo, { cooldownMinutes: 1 });
    const anomaly = makeAnomaly({ topic: 't', zscore: 3 });
    const r1 = fastManager.emit(anomaly);
    const r2 = fastManager.emit(anomaly);
    expect(r1.suppressed).toBe(false);
    expect(r2.suppressed).toBe(true);

    // Verify cooldown_until is ~1 minute in the future.
    const cooldownMs = new Date(r1.alert!.cooldown_until!).getTime() - Date.now();
    expect(cooldownMs).toBeGreaterThan(50_000); // ~1 min, allow 10s slack
    expect(cooldownMs).toBeLessThan(80_000);
  });

  it('markSentOnEmit=true promotes new alerts to SENT immediately', () => {
    const m = new AlertManager(repo, { cooldownMinutes: 60, markSentOnEmit: true });
    const r = m.emit(makeAnomaly({ topic: 't', zscore: 3 }));
    expect(r.alert!.status).toBe(AlertStatus.SENT);
    expect(r.alert!.sent_at).toBeTruthy();
  });
});
