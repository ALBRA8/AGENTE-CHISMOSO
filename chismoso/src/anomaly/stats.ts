/**
 * CHISMOSO V1.0 — Anomaly detection stats helpers (Task EXP-6)
 *
 * Pure, side-effect-free numerical helpers used by the AnomalyDetector.
 * Kept in their own module so they're trivially unit-testable in isolation
 * and so the detector file stays focused on orchestration logic.
 *
 * Conventions:
 *   - All functions accept `number[]` and return `number`.
 *   - Empty-array / single-element inputs return `0` (safe defaults) instead
 *     of throwing — the detector guards `minSamples` upstream so this is
 *     purely defensive.
 *   - `stddev` uses the sample formula (n-1) per the task spec.
 *   - `percentile` uses linear interpolation between closest ranks.
 */

/**
 * Arithmetic mean. Returns 0 for empty input.
 */
export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

/**
 * Sample standard deviation (n-1 denominator).
 * Returns 0 for arrays with < 2 elements (variance is undefined).
 */
export function stddev(xs: number[]): number {
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

/**
 * Standard z-score: (x - mean) / stddev.
 * Returns 0 when stddev is 0 (degenerate distribution) to avoid Infinity.
 */
export function zscore(x: number, mean: number, stddev: number): number {
  if (stddev === 0 || !Number.isFinite(stddev)) return 0;
  return (x - mean) / stddev;
}

/**
 * Exponentially weighted moving average — single smoothed value.
 *
 * Convention: alpha is the weight on the most recent observation. The series
 * is walked oldest→newest, with S_0 = x_0 and S_t = alpha * x_t + (1-alpha) * S_{t-1}.
 * The function returns the final S_t (a smoothed estimate of the most recent value).
 *
 * Returns 0 for empty input. For a single-element array returns that element.
 *
 * Useful for trend direction: comparing ewma(alpha=0.3) vs ewma(alpha=0.7) gives
 * a sense of how much the latest observations are pulling the series.
 */
export function ewma(xs: number[], alpha: number): number {
  const n = xs.length;
  if (n === 0) return 0;
  if (n === 1) return xs[0];
  const a = clamp(alpha, 0, 1);
  let s = xs[0];
  for (let i = 1; i < n; i++) {
    s = a * xs[i] + (1 - a) * s;
  }
  return s;
}

/**
 * Percentile with linear interpolation between closest ranks.
 *
 * `p` is in [0, 100]. For p=50 this is the median; for p=95 the 95th percentile.
 * Empty array returns 0.
 *
 * Algorithm: rank = (p / 100) * (n - 1), then linearly interpolate between
 * the two nearest samples. This matches numpy's default ('linear') method.
 */
export function percentile(xs: number[], p: number): number {
  const n = xs.length;
  if (n === 0) return 0;
  if (n === 1) return xs[0];
  const sorted = [...xs].sort((a, b) => a - b);
  const pc = clamp(p, 0, 100);
  const rank = (pc / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/**
 * Slope of the ordinary least-squares regression line y = a + b*x.
 *
 * Returns the slope `b`. `xs` are typically time indices (0, 1, 2, ...) and
 * `ys` are the observed values. Lengths must match; returns 0 otherwise.
 *
 * Formula:
 *   b = Σ((xi - x̄)(yi - ȳ)) / Σ((xi - x̄)^2)
 *
 * Returns 0 when the denominator is 0 (all xs identical) — this happens for
 * constant series and shouldn't produce spurious trends.
 */
export function linearRegressionSlope(xs: number[], ys: number[]): number {
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

/**
 * Clamp helper — internal. Keeps alpha/percentile within valid ranges.
 */
function clamp(x: number, lo: number, hi: number): number {
  if (Number.isNaN(x)) return lo;
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}
