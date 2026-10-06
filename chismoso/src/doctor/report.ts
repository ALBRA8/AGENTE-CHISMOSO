/**
 * CHISMOSO V1.5 — Doctor report formatters (Task IMP-3, spec §31)
 *
 * Three output formats are supported so the same `DoctorReport` value can
 * be consumed by humans (markdown for the CLI), programs (JSON for the
 * API), and operators scanning a terminal (colored console output with
 * ✅ / ⚠️ / ❌ / ❓ symbols).
 *
 * All formatters are PURE: same report → same output. They take a
 * `DoctorReport` (defined in `./index.ts`) and return a string. No I/O.
 */

import type { DoctorCheck, DoctorReport } from './index.js';

// ---------------------------------------------------------------------------
// PUBLIC TYPES (re-exported from index.ts so callers can import everything
// from "./report.js" without pulling in the Doctor class)
// ---------------------------------------------------------------------------

export type { DoctorCheck, DoctorReport } from './index.js';

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

export const CHISMOSO_VERSION = '1.5.0';

const STATUS_SYMBOL: Record<DoctorCheck['status'], string> = {
  OK: '\u2705',       // ✅
  DEGRADED: '\u26A0\uFE0F',  // ⚠️
  FAIL: '\u274C',     // ❌
  UNKNOWN: '\u2753', // ❓
};

const STATUS_TEXT: Record<DoctorCheck['status'], string> = {
  OK: 'OK',
  DEGRADED: 'DEGRADED',
  FAIL: 'FAIL',
  UNKNOWN: 'UNKNOWN',
};

// ANSI color codes — kept as plain strings so they render in any terminal
// that supports them. Terminals that don't will show the escape codes
// literally, which is ugly but functional. We accept that tradeoff because
// the primary consumer (CLI stdout) almost always supports ANSI.
const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function coloredStatus(status: DoctorCheck['status']): string {
  switch (status) {
    case 'OK': return `${ANSI.green}${STATUS_TEXT.OK}${ANSI.reset}`;
    case 'DEGRADED': return `${ANSI.yellow}${STATUS_TEXT.DEGRADED}${ANSI.reset}`;
    case 'FAIL': return `${ANSI.red}${STATUS_TEXT.FAIL}${ANSI.reset}`;
    case 'UNKNOWN': return `${ANSI.gray}${STATUS_TEXT.UNKNOWN}${ANSI.reset}`;
  }
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/**
 * Returns the report as a pretty-printed JSON string. Used by the CLI's
 * `--json` flag and by the `/api/doctor` route. The shape matches
 * `DoctorReport` exactly — no envelope, no wrapper, no ok:true field.
 */
export function toJSON(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}

/**
 * Returns the report as a JSON-parseable object (not a string). Used by
 * the API route so NextResponse.json can serialize it directly.
 */
export function toJSONObject(report: DoctorReport): DoctorReport {
  // Already an object — this is a pass-through that exists for symmetry
  // with `toJSON` and so the API route has a clear "report as object"
  // helper to call.
  return report;
}

// ---------------------------------------------------------------------------
// MARKDOWN
// ---------------------------------------------------------------------------

/**
 * Pretty-printed markdown for CLI output and saved reports.
 *
 * Layout:
 *   # CHISMOSO Doctor Report
 *   (header with version, generated_at, overall_status)
 *
 *   ## Summary
 *   - OK: 10  DEGRADED: 2  FAIL: 0  UNKNOWN: 2
 *   - Auto-fixes applied: 0
 *
 *   ## Checks (14)
 *   ### ✅ providers
 *   - **status**: OK
 *   - **message**: 3/4 OK, expected unavailable: google_trends
 *   - **duration**: 12ms
 *
 *   ...
 */
export function toMarkdown(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push('# CHISMOSO Doctor Report');
  lines.push('');
  lines.push(`- **version**: ${report.version}`);
  lines.push(`- **generated_at**: ${report.generated_at}`);
  lines.push(`- **overall_status**: ${overallStatusMarkdown(report.overall_status)}`);
  lines.push(`- **auto_fixes_applied**: ${report.auto_fixes_applied}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(
    `| OK | DEGRADED | FAIL | UNKNOWN |`,
  );
  lines.push(
    `| --: | --: | --: | --: |`,
  );
  lines.push(
    `| ${report.summary.ok} | ${report.summary.degraded} | ${report.summary.fail} | ${report.summary.unknown} |`,
  );
  lines.push('');
  lines.push(`## Checks (${report.checks.length})`);
  lines.push('');
  for (const c of report.checks) {
    lines.push(`### ${STATUS_SYMBOL[c.status]} ${c.category}`);
    lines.push('');
    lines.push(`- **name**: ${c.name}`);
    lines.push(`- **status**: ${STATUS_TEXT[c.status]}`);
    lines.push(`- **message**: ${c.message}`);
    lines.push(`- **duration**: ${c.duration_ms}ms`);
    if (c.fixable || c.fix_applied) {
      lines.push(`- **fixable**: ${c.fixable}`);
      if (c.fix_applied) lines.push(`- **fix_applied**: true`);
    }
    if (c.details !== undefined) {
      lines.push('- **details**:');
      lines.push('');
      lines.push('```json');
      lines.push(JSON.stringify(c.details, null, 2));
      lines.push('```');
    }
    lines.push('');
  }
  return lines.join('\n');
}

function overallStatusMarkdown(status: DoctorReport['overall_status']): string {
  switch (status) {
    case 'OK': return `${STATUS_SYMBOL.OK} OK`;
    case 'DEGRADED': return `${STATUS_SYMBOL.DEGRADED} DEGRADED`;
    case 'FAIL': return `${STATUS_SYMBOL.FAIL} FAIL`;
  }
}

// ---------------------------------------------------------------------------
// CONSOLE (colored)
// ---------------------------------------------------------------------------

/**
 * Colored, single-screen console output suitable for terminal use.
 *
 * Layout (each line is a single string; no leading newline):
 *   CHISMOSO Doctor v1.5.0 — 2026-10-06T14:32:00Z
 *   Overall: ✅ OK    (OK: 12  DEGRADED: 2  FAIL: 0  UNKNOWN: 0)
 *   Auto-fixes applied: 0
 *
 *   ✅ providers                3/4 OK, expected unavailable: google_trends              (12ms)
 *   ⚠️  temporal_engine          No temporal observations recorded yet — anomaly ...      (3ms)
 *   ...
 */
export function toConsole(report: DoctorReport): string {
  const lines: string[] = [];
  // Header
  lines.push(
    `${ANSI.bold}CHISMOSO Doctor v${report.version}${ANSI.reset} ` +
    `${ANSI.dim}— ${report.generated_at}${ANSI.reset}`,
  );
  // Overall status
  const overallColored = coloredOverall(report.overall_status);
  lines.push(
    `Overall: ${overallColored}    ` +
    `(${ANSI.green}OK: ${report.summary.ok}${ANSI.reset}  ` +
    `${ANSI.yellow}DEGRADED: ${report.summary.degraded}${ANSI.reset}  ` +
    `${ANSI.red}FAIL: ${report.summary.fail}${ANSI.reset}  ` +
    `${ANSI.gray}UNKNOWN: ${report.summary.unknown}${ANSI.reset})`,
  );
  lines.push(`${ANSI.dim}Auto-fixes applied: ${report.auto_fixes_applied}${ANSI.reset}`);
  lines.push('');
  // Each check on one line. The message is truncated so the line fits in 100
  // columns in most terminals (the symbol + name + status + duration take
  // about 40 chars).
  const nameWidth = Math.max(
    ...report.checks.map((c) => c.category.length),
    18,
  );
  for (const c of report.checks) {
    const symbol = STATUS_SYMBOL[c.status];
    const name = c.category.padEnd(nameWidth);
    const fixTag = c.fix_applied ? `${ANSI.magenta}[FIXED]${ANSI.reset} ` : '';
    const msg = truncate(c.message, 80);
    const dur = `${ANSI.dim}(${c.duration_ms}ms)${ANSI.reset}`;
    lines.push(
      `${symbol} ${ANSI.bold}${name}${ANSI.reset}  ${fixTag}${msg}  ${dur}`,
    );
  }
  return lines.join('\n');
}

function coloredOverall(status: DoctorReport['overall_status']): string {
  switch (status) {
    case 'OK': return `${STATUS_SYMBOL.OK} ${ANSI.green}${STATUS_TEXT.OK}${ANSI.reset}`;
    case 'DEGRADED': return `${STATUS_SYMBOL.DEGRADED} ${ANSI.yellow}${STATUS_TEXT.DEGRADED}${ANSI.reset}`;
    case 'FAIL': return `${STATUS_SYMBOL.FAIL} ${ANSI.red}${STATUS_TEXT.FAIL}${ANSI.reset}`;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '\u2026'; // …
}
