/**
 * PORTED from chismoso/src/anomaly/index.ts for the Next.js runtime.
 * Verified by FIX-3 (AUDIT-CODE HIGH #5).
 *
 * Reason for the port (not a re-export): the canonical `AnomalyDetector`
 * in `chismoso/src/anomaly/index.ts` is a CLASS that takes a `Repositories`
 * instance in its constructor. `Repositories` in turn requires the full
 * chismoso `ChismosoDB` graph (schema migrations, FK setup, scheduler-owned
 * connection lifecycle, etc.). Pulling that graph into the Next.js runtime
 * would force the dashboard to:
 *   1. run chismoso DB migrations on cold start (slow + side-effectful),
 *   2. keep a long-lived `ChismosoDB` around across hot reloads,
 *   3. tightly couple Next.js process lifecycle to chismoso's `Repositories`.
 *
 * The Next.js API routes (`GET /api/anomalies`, `GET /api/alerts`) only need
 * READ-ONLY access to `topic_observations` + `signals`. This port reads via
 * the process-wide readonly singleton in `./db-chismoso.ts` and runs the SAME
 * detection algorithm. ~380 LOC of mostly-pure stats + SQL — no writes.
 *
 * SOURCE OF TRUTH: chismoso/src/anomaly/index.ts. Keep this file in sync
 * when the algorithm changes there.
 *
 * TODO (FIX-3): extract the detection algorithm into a pure function
 * `detectAnomaliesFromRows(rows, config)` in a shared package that both
 * chismoso and Next.js import. The chismoso class would call it with rows
 * fetched via `Repositories`; this port would call it with rows fetched via
 * the readonly singleton. That eliminates the port entirely.
 *
 * The detector reads the chismoso SQLite DB via the singleton connection in
 * `db-chismoso.ts` (readonly, shared across requests — no per-call open).
 */

import Database from 'better-sqlite3';
import { chismosoDb } from './db-chismoso';

// ---------------------------------------------------------------------------
// PUBLIC TYPES (mirrors chismoso/src/anomaly/index.ts)
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

// Reuse the singleton readonly connection — opening a fresh Database per
// request was the main contributor to /api/anomalies latency (10–50ms per
// `new Database(path, { readonly: true })`). The singleton is created once
// per process and shared across all detector calls.
const CHISMOSO_DB: Database.Database = chismosoDb;

// ---------------------------------------------------------------------------
// STATS HELPERS (mirrors chismoso/src/anomaly/stats.ts)
// ---------------------------------------------------------------------------

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

function stddev(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  let acc = 0;
  for (const x of xs) {
    const d = x - m;
    acc += d * d;
  }
  return Math.sqrt(acc / (n - 1));
}

function zscore(x: number, mu: number, sigma: number): number {
  if (sigma === 0 || !Number.isFinite(sigma)) return 0;
  return (x - mu) / sigma;
}

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

function linearRegressionSlope(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    num += dx * (ys[i] - my);
    den += dx * dx;
  }
  if (den === 0) return 0;
  return num / den;
}

function sign(x: number): -1 | 0 | 1 {
  if (x > 0) return 1;
  if (x < 0) return -1;
  return 0;
}

function round(x: number, digits = 3): number {
  if (!Number.isFinite(x)) return x;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

// ---------------------------------------------------------------------------
// DETECTOR
// ---------------------------------------------------------------------------

interface ObservationRow {
  observed_at: string;
  sources_count: number;
  signals_count: number;
  confidence: number;
}

interface SourceTypeRow {
  source_type: string;
}

/**
 * Detect anomalies across the chismoso DB. Reads `topic_observations` and
 * `signals` directly via better-sqlite3 in readonly mode.
 *
 * Pass `topic` to restrict detection to one topic; omit it to scan all topics
 * that have observation history.
 */
export function detectAnomalies(
  topic: string | null,
  config?: Partial<AnomalyDetectorConfig>,
): Anomaly[] {
  const cfg = { ...DEFAULT_ANOMALY_CONFIG, ...(config ?? {}) };
  // Use the process-wide singleton connection — no more per-request
  // `new Database()` open/close overhead.
  const db = CHISMOSO_DB;
  try {
    const topics = topic
      ? [topic]
      : (db.prepare('SELECT DISTINCT topic FROM topic_observations ORDER BY topic ASC').all() as Array<{ topic: string }>).map((r) => r.topic);

    const out: Anomaly[] = [];
    for (const t of topics) {
      out.push(...detectForTopic(db, t, cfg));
    }
    return out;
  } catch {
    // The DB file may not exist yet on a fresh install, or a query may fail
    // mid-scan — return no anomalies rather than 500'ing the dashboard.
    // Callers (the API routes) wrap this in try/catch too.
    return [];
  }
}

function detectForTopic(
  db: Database.Database,
  topic: string,
  cfg: AnomalyDetectorConfig,
): Anomaly[] {
  const history = db
    .prepare('SELECT observed_at, sources_count, signals_count, confidence FROM topic_observations WHERE topic = ? ORDER BY observed_at DESC, id DESC LIMIT 60')
    .all(topic) as ObservationRow[];
  if (history.length < cfg.minSamples) return [];

  // Chronological order (oldest first).
  const chrono = [...history].reverse();
  const current = chrono[chrono.length - 1];
  const baselineRows = chrono.slice(0, Math.max(1, Math.floor(chrono.length / 2)));
  const baselineSignals = baselineRows.map((r) => r.signals_count);
  const baselineMean = mean(baselineSignals);
  const baselineStd = stddev(baselineSignals);

  const observedAt = current.observed_at;
  const baselineMeta = {
    mean: round(baselineMean),
    stddev: round(baselineStd),
    windowDays: cfg.windowDays,
    samples: baselineRows.length,
  };

  const out: Anomaly[] = [];

  // (5) Volume spike / drop
  const currentSignals = current.signals_count;
  const z = zscore(currentSignals, baselineMean, baselineStd);
  if (Math.abs(z) >= cfg.zscoreThreshold) {
    const isSpike = z > 0;
    out.push(buildAnomaly({
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
    const ewmaSeries = rollingEwma(last7.map((r) => r.signals_count), cfg.ewmaAlpha);
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
      const pseudoZ = Math.min(4.0, Math.max(2.0, magnitudeRatio));
      out.push(buildAnomaly({
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
  const currentRows = db
    .prepare('SELECT DISTINCT source_type FROM signals WHERE topic = ? AND timestamp >= ?')
    .all(topic, observedAt) as SourceTypeRow[];
  const baselineRowsSig = db
    .prepare('SELECT DISTINCT source_type FROM signals WHERE topic = ? AND timestamp < ?')
    .all(topic, observedAt) as SourceTypeRow[];
  const currentTypes = currentRows.map((r) => r.source_type).filter(Boolean);
  const baselineTypes = baselineRowsSig.map((r) => r.source_type).filter(Boolean);
  if (currentTypes.length > 0) {
    const newTypes = currentTypes.filter((t) => !baselineTypes.includes(t));
    if (newTypes.length > 0) {
      const pseudoZ = Math.min(4.0, 1.5 + newTypes.length * 0.5);
      out.push(buildAnomaly({
        topic,
        type: 'source_diversification',
        observedAt,
        baseline: baselineMeta,
        currentValue: newTypes.length,
        zscore: pseudoZ,
        description: `Nuevos tipos de fuente aparecieron: ${newTypes.join(', ')} (baseline: ${baselineTypes.join(', ') || '—'}).`,
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
      const pseudoZ = Math.min(4.0, Math.abs(delta) / 0.05);
      out.push(buildAnomaly({
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

function buildAnomaly(input: {
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

function classifySeverity(z: number): AnomalySeverity {
  const a = Math.abs(z);
  if (a > 3) return 'high';
  if (a > 2.5) return 'medium';
  return 'low';
}

function recommendAction(
  type: AnomalyType,
  severity: AnomalySeverity,
  z: number,
): string {
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

function makeAnomalyId(topic: string, type: AnomalyType, observedAt: string): string {
  const safeTopic = topic.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
  const safeObs = observedAt.replace(/[^0-9TZ:.-]/g, '');
  return `anm_${type}__${safeTopic}__${safeObs}`;
}
