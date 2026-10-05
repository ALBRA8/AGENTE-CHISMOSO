/**
 * CHISMOSO V1.0 — Anomaly Detector (Task EXP-6)
 *
 * Statistical anomaly detection over `topic_observations` history. For each
 * topic that has enough history, we compare the most recent observation
 * against a baseline (older half of the loaded window) and flag deviations
 * that exceed configurable z-score thresholds.
 *
 * Five anomaly types are detected (see `AnomalyType`):
 *   - volume_spike            : signals_count > mean + z*stddev
 *   - volume_drop             : signals_count < mean - z*stddev
 *   - velocity_change         : EWMA slope changed direction or magnitude > 3x
 *   - source_diversification  : a sourceType appeared that wasn't in baseline
 *   - confidence_drift        : confidence moving > 0.1 over last 5 obs
 *
 * The detector is read-only — it never writes to the DB. It can be invoked
 * from the CLI (`chismoso anomalies`), from a REST endpoint
 * (`GET /api/anomalies`) or directly from the scheduler (V2).
 */

import type { Repositories } from '../repositories.js';
import { mean, stddev, zscore, ewma, linearRegressionSlope } from './stats.js';

// Re-export the stats helpers + types from this barrel so callers can do a
// single `import { AnomalyDetector, mean, zscore } from '../anomaly/index.js'`.
export * from './stats.js';

// ---------------------------------------------------------------------------
// PUBLIC TYPES
// ---------------------------------------------------------------------------

export type AnomalyType =
  | 'volume_spike'
  | 'volume_drop'
  | 'velocity_change'
  | 'source_diversification'
  | 'confidence_drift';

export type AnomalySeverity = 'low' | 'medium' | 'high';

export interface Anomaly {
  id: string;
  topic: string;
  type: AnomalyType;
  severity: AnomalySeverity;
  observedAt: string;
  baseline: {
    mean: number;
    stddev: number;
    windowDays: number;
    samples: number;
  };
  currentValue: number;
  zscore: number;
  description: string;
  recommendedAction: string;
}

export interface AnomalyDetectorConfig {
  windowDays: number;
  minSamples: number;
  zscoreThreshold: number;
  ewmaAlpha: number;
}

export const DEFAULT_ANOMALY_CONFIG: AnomalyDetectorConfig = {
  windowDays: 30,
  minSamples: 5,
  zscoreThreshold: 2.0,
  ewmaAlpha: 0.3,
};

// ---------------------------------------------------------------------------
// INTERNAL TYPES
// ---------------------------------------------------------------------------

interface TopicObservationRow {
  observed_at: string;
  sources_count: number;
  signals_count: number;
  confidence: number;
}

// ---------------------------------------------------------------------------
// DETECTOR
// ---------------------------------------------------------------------------

export class AnomalyDetector {
  private readonly config: AnomalyDetectorConfig;
  private readonly subscribers: Array<(a: Anomaly) => void> = [];

  constructor(private repos: Repositories, config?: Partial<AnomalyDetectorConfig>) {
    this.config = { ...DEFAULT_ANOMALY_CONFIG, ...(config ?? {}) };
  }

  /**
   * Detect anomalies across ALL topics that have observation history.
   *
   * Topics with fewer than `minSamples` observations are silently skipped.
   */
  detectAll(): Anomaly[] {
    const topics = this.listObservedTopics();
    const out: Anomaly[] = [];
    for (const t of topics) {
      out.push(...this.detectForTopic(t));
    }
    // Notify subscribers for any newly-emitted anomalies (V1 just polls; the
    // callback wiring is here for future event-driven use).
    for (const a of out) {
      for (const cb of this.subscribers) {
        try { cb(a); } catch { /* subscriber errors are non-fatal */ }
      }
    }
    return out;
  }

  /**
   * Detect anomalies for a single topic.
   *
   * Detection algorithm (see task spec):
   *   1. Load up to 60 most recent observations.
   *   2. Skip if fewer than `minSamples`.
   *   3. Split into baseline (older half) and current (most recent obs).
   *   4. mean + stddev of signals_count over baseline.
   *   5. z-score(current) > threshold → volume_spike / volume_drop.
   *   6. EWMA slope over last 7 obs; if direction changes or |slope| > 3x → velocity_change.
   *   7. New sourceType in current vs baseline → source_diversification.
   *   8. confidence drift > 0.1 over last 5 obs → confidence_drift.
   *   9. Severity from |zscore|: >3 high, >2.5 medium, >2 low.
   */
  detectForTopic(topic: string): Anomaly[] {
    const history = this.repos.topics.getHistory(topic, 60) as TopicObservationRow[];
    if (history.length < this.config.minSamples) return [];

    // getHistory returns DESC (newest first). Reverse to chronological order
    // so the math reads naturally left→right.
    const chrono = [...history].reverse();
    const current = chrono[chrono.length - 1];
    const baselineRows = chrono.slice(0, Math.max(1, Math.floor(chrono.length / 2)));
    const baselineSignals = baselineRows.map((r) => r.signals_count);
    const baselineMean = mean(baselineSignals);
    const baselineStd = stddev(baselineSignals);

    const out: Anomaly[] = [];
    const observedAt = current.observed_at;
    const baselineMeta = {
      mean: round(baselineMean),
      stddev: round(baselineStd),
      windowDays: this.config.windowDays,
      samples: baselineRows.length,
    };

    // (5) Volume spike / drop
    const currentSignals = current.signals_count;
    const z = zscore(currentSignals, baselineMean, baselineStd);
    if (Math.abs(z) >= this.config.zscoreThreshold) {
      const isSpike = z > 0;
      out.push(this.buildAnomaly({
        topic,
        type: isSpike ? 'volume_spike' : 'volume_drop',
        observedAt,
        baseline: baselineMeta,
        currentValue: currentSignals,
        zscore: z,
        description: isSpike
          ? `Señales saltaron a ${currentSignals} vs baseline μ=${round(baselineMean)}, σ=${round(baselineStd)} (z=${round(z)}).`
          : `Señales cayeron a ${currentSignals} vs baseline μ=${round(baselineMean)}, σ=${round(baselineStd)} (z=${round(z)}).`,
      }));
    }

    // (6) Velocity change — EWMA slope over last 7 vs baseline slope.
    if (chrono.length >= 7) {
      const last7 = chrono.slice(-7);
      const ewmaSeries = rollingEwma(last7.map((r) => r.signals_count), this.config.ewmaAlpha);
      const currentSlope = linearRegressionSlope(
        last7.map((_, i) => i),
        ewmaSeries,
      );
      const baselineSlope = linearRegressionSlope(
        baselineRows.map((_, i) => i),
        baselineRows.map((r) => r.signals_count),
      );
      const directionChanged = sign(currentSlope) !== sign(baselineSlope) && Math.abs(currentSlope) > 1e-9;
      const magnitudeRatio = Math.abs(baselineSlope) < 1e-9
        ? (Math.abs(currentSlope) > 1e-9 ? Infinity : 0)
        : Math.abs(currentSlope) / Math.abs(baselineSlope);
      if (directionChanged || magnitudeRatio > 3) {
        // Pseudo-zscore from the magnitude ratio (clamped to 4.0 for sane severity).
        const pseudoZ = Math.min(4.0, Math.max(2.0, magnitudeRatio));
        out.push(this.buildAnomaly({
          topic,
          type: 'velocity_change',
          observedAt,
          baseline: baselineMeta,
          currentValue: round(currentSlope),
          zscore: pseudoZ,
          description: directionChanged
            ? `Velocidad cambió dirección: baseline slope ${round(baselineSlope)} → actual ${round(currentSlope)}.`
            : `Velocidad escaló ${magnitudeRatio.toFixed(1)}x: baseline slope ${round(baselineSlope)} → actual ${round(currentSlope)}.`,
        }));
      }
    }

    // (7) Source diversification — new sourceType in current vs baseline.
    const sourceTypes = this.getSourceTypes(topic, observedAt);
    if (sourceTypes.current.length > 0) {
      const newTypes = sourceTypes.current.filter((t) => !sourceTypes.baseline.includes(t));
      if (newTypes.length > 0) {
        // Pseudo-zscore: 1 new type → 2.0, 2 → 2.5, 3+ → 3.0+.
        const pseudoZ = Math.min(4.0, 1.5 + newTypes.length * 0.5);
        out.push(this.buildAnomaly({
          topic,
          type: 'source_diversification',
          observedAt,
          baseline: baselineMeta,
          currentValue: newTypes.length,
          zscore: pseudoZ,
          description: `Nuevos tipos de fuente aparecieron: ${newTypes.join(', ')} (baseline: ${sourceTypes.baseline.join(', ') || '—'}).`,
        }));
      }
    }

    // (8) Confidence drift over last 5 observations.
    if (chrono.length >= 5) {
      const last5 = chrono.slice(-5);
      const confFirst = last5[0].confidence ?? 0;
      const confLast = last5[last5.length - 1].confidence ?? 0;
      const delta = confLast - confFirst;
      if (Math.abs(delta) > 0.1) {
        // Pseudo-zscore from delta magnitude (0.05 step = 1 sigma).
        const pseudoZ = Math.min(4.0, Math.abs(delta) / 0.05);
        out.push(this.buildAnomaly({
          topic,
          type: 'confidence_drift',
          observedAt,
          baseline: baselineMeta,
          currentValue: round(delta),
          zscore: delta > 0 ? pseudoZ : -pseudoZ,
          description: delta > 0
            ? `Confianza subió ${round(delta)} en últimas 5 observaciones (de ${round(confFirst)} a ${round(confLast)}).`
            : `Confianza bajó ${round(Math.abs(delta))} en últimas 5 observaciones (de ${round(confFirst)} a ${round(confLast)}).`,
        }));
      }
    }

    return out;
  }

  /**
   * Subscribe a callback to be invoked whenever `detectAll` (or
   * `detectForTopic`) emits a new anomaly. Returns an unsubscribe function.
   *
   * V1 is poll-based — the CLI `--watch` mode re-runs `detectAll` on an
   * interval. This hook exists so V2 can wire the detector into a scheduler
   * tick and push anomalies to a notification channel.
   */
  onAnomaly(cb: (a: Anomaly) => void): () => void {
    this.subscribers.push(cb);
    return () => {
      const idx = this.subscribers.indexOf(cb);
      if (idx >= 0) this.subscribers.splice(idx, 1);
    };
  }

  // -------------------------------------------------------------------------
  // PRIVATE HELPERS
  // -------------------------------------------------------------------------

  /**
   * Enumerate every topic that has at least one observation row. We avoid
   * going through the `topics` table because that only tracks topics the
   * orchestrator has clustered; topic_observations may contain rows for
   * topics that no longer have a matching topics entry (defensive).
   */
  private listObservedTopics(): string[] {
    const rows = this.repos.db
      .prepare('SELECT DISTINCT topic FROM topic_observations ORDER BY topic ASC')
      .all() as Array<{ topic: string }>;
    return rows.map((r) => r.topic);
  }

  /**
   * Split the source_types that have ever appeared for `topic` into:
   *   - current  : source_types whose signals have timestamp >= observedAt
   *   - baseline : source_types whose signals have timestamp <  observedAt
   *
   * If no signals exist for this topic (e.g. only observations were
   * back-filled), both sets will be empty — the caller treats that as
   * "no diversification detectable" rather than an anomaly.
   */
  private getSourceTypes(topic: string, observedAt: string): { current: string[]; baseline: string[] } {
    const currentRows = this.repos.db
      .prepare('SELECT DISTINCT source_type FROM signals WHERE topic = ? AND timestamp >= ?')
      .all(topic, observedAt) as Array<{ source_type: string }>;
    const baselineRows = this.repos.db
      .prepare('SELECT DISTINCT source_type FROM signals WHERE topic = ? AND timestamp < ?')
      .all(topic, observedAt) as Array<{ source_type: string }>;
    return {
      current: currentRows.map((r) => r.source_type).filter(Boolean),
      baseline: baselineRows.map((r) => r.source_type).filter(Boolean),
    };
  }

  /**
   * Build a single Anomaly object with severity + recommended action derived
   * from its type and zscore. IDs are deterministic so callers can dedupe
   * across polling runs.
   */
  private buildAnomaly(input: {
    topic: string;
    type: AnomalyType;
    observedAt: string;
    baseline: Anomaly['baseline'];
    currentValue: number;
    zscore: number;
    description: string;
  }): Anomaly {
    const severity = classifySeverity(input.zscore);
    const recommendedAction = recommendAction(input.type, severity, input.zscore);
    return {
      id: makeAnomalyId(input.topic, input.type, input.observedAt),
      topic: input.topic,
      type: input.type,
      severity,
      observedAt: input.observedAt,
      baseline: input.baseline,
      currentValue: input.currentValue,
      zscore: round(input.zscore),
      description: input.description,
      recommendedAction,
    };
  }
}

// ---------------------------------------------------------------------------
// STANDALONE HELPERS
// ---------------------------------------------------------------------------

/**
 * Compute a rolling EWMA series: for each index i, the value is the EWMA of
 * xs[0..i] (inclusive). The first element equals xs[0] (no history yet).
 *
 * This is what we slope-fit against in velocity_change detection.
 */
function rollingEwma(xs: number[], alpha: number): number[] {
  const out: number[] = [];
  if (xs.length === 0) return out;
  let s = xs[0];
  out.push(s);
  for (let i = 1; i < xs.length; i++) {
    s = alpha * xs[i] + (1 - alpha) * s;
    out.push(s);
  }
  return out;
}

function sign(x: number): -1 | 0 | 1 {
  if (x > 0) return 1;
  if (x < 0) return -1;
  return 0;
}

function classifySeverity(z: number): AnomalySeverity {
  const a = Math.abs(z);
  if (a > 3) return 'high';
  if (a > 2.5) return 'medium';
  return 'low';
}

function recommendAction(type: AnomalyType, severity: AnomalySeverity, z: number): string {
  switch (type) {
    case 'volume_spike':
      if (severity === 'high') return 'Ejecutar una investigación completa sobre este tema ahora.';
      if (severity === 'medium') return 'Monitorear de cerca; considerar una investigación ligera.';
      return 'Vigilar; el pico es leve.';
    case 'volume_drop':
      if (severity === 'high') return 'Investigar si el tema perdió relevancia o si cambió la fuente.';
      if (severity === 'medium') return 'Re-evaluar si el tema sigue activo.';
      return 'Caída leve; observar.';
    case 'velocity_change':
      if (severity === 'high') return 'La velocidad cambió bruscamente — revisar factores contextuales.';
      return 'Velocidad cambió — vigilar evolución.';
    case 'source_diversification':
      return 'Nueva fuente confirma el tema — aprovechar para cross-source.';
    case 'confidence_drift':
      return z > 0
        ? 'Re-evaluar oportunidades sobre este tema (confianza subiendo).'
        : 'Re-evaluar oportunidades sobre este tema (confianza bajando).';
    default:
      return 'Revisar el tema.';
  }
}

/**
 * Deterministic ID: `{type}:{topic}:{observedAt}`. Stable across polling runs
 * so the CLI --watch mode can dedupe by `id` reliably — calling
 * `detectForTopic(topic)` twice against the same DB state must yield
 * identical IDs.
 *
 * If two distinct anomalies of the same type fire against the same
 * observedAt (extremely rare — only possible if the DB has duplicate
 * observation rows for the same timestamp), they would collide. We accept
 * this tradeoff because determinism matters more than collision-safety here.
 */
function makeAnomalyId(topic: string, type: AnomalyType, observedAt: string): string {
  // Sanitize topic (may contain spaces / accented chars) to keep IDs URL-safe.
  const safeTopic = topic.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
  const safeObs = observedAt.replace(/[^0-9TZ:.-]/g, '');
  return `anm_${type}__${safeTopic}__${safeObs}`;
}

function round(x: number, digits = 3): number {
  if (!Number.isFinite(x)) return x;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}
