/**
 * CHISMOSO V1.5 — Doctor class (Task IMP-3, spec §31)
 *
 * The Doctor audits 14 subsystems mandated by spec §31 and produces a
 * structured report. It is invoked from:
 *
 *   - CLI:  `chismoso doctor [--json] [--fix] [--check=<category>]`
 *   - API:  `GET  /api/doctor`      → run all 14 checks (read-only)
 *           `POST /api/doctor?fix=true` → run + apply safe fixes
 *
 * Lifecycle:
 *
 *   const doctor = new ChismosoDoctor({ dbPath });
 *   const report = await doctor.runAll({ applyFixes: true });
 *   console.log(toConsole(report));
 *
 * The class owns the DB lifecycle: it opens a ChismosoDB instance for the
 * duration of the checks and closes it in a finally block. It also constructs
 * the Repositories facade + ProviderRegistry + AnomalyDetector that the
 * checks share via CheckContext.
 *
 * Parallelism:
 *
 * `runAll` invokes all 14 checks via `Promise.all`. better-sqlite3 is
 * synchronous, so DB queries actually run sequentially — but
 * `checkProviders` calls `provider.health()` for every provider, which is
 * async (it may do I/O for some providers). Parallelising lets that I/O
 * overlap with the sync DB checks.
 *
 * Safety:
 *
 * The doctor NEVER spawns subprocesses, NEVER connects to MCP servers,
 * NEVER calls the LLM, NEVER makes outbound HTTP requests. It only reads
 * from the local DB and the local config files. The only writes it does
 * are the deterministic fixes gated behind `applyFixes: true`:
 *   - mkdir data/ if missing
 *   - CREATE TABLE IF NOT EXISTS signal_embeddings
 *   - (configuration fix is a no-op because the DB is already open by
 *      the time the check runs — but the branch is documented for the
 *      case where the doctor is invoked without first opening the DB)
 */

import { ChismosoDB, DEFAULT_DB_PATH } from '../db.js';
import { Repositories } from '../repositories.js';
import { createDefaultProviderRegistry } from '../providers/index.js';
import { AnomalyDetector } from '../anomaly/index.js';
import { logger } from '../logger.js';
import {
  ALL_CHECKS,
  findCheck,
  type CheckContext,
  type CheckCategory,
  type DoctorCheck,
} from './checks.js';

// ---------------------------------------------------------------------------
// PUBLIC TYPES
// ---------------------------------------------------------------------------

export interface DoctorDeps {
  /** SQLite path. Defaults to CHISMOSO_DB_PATH env or DEFAULT_DB_PATH. */
  dbPath?: string;
}

export interface DoctorReport {
  generated_at: string;
  version: string;
  overall_status: 'OK' | 'DEGRADED' | 'FAIL';
  checks: DoctorCheck[];
  summary: { ok: number; degraded: number; fail: number; unknown: number };
  auto_fixes_applied: number;
}

export interface RunOptions {
  /** If true, checks may apply deterministic fixes (mkdir, CREATE TABLE). */
  applyFixes?: boolean;
}

// Re-export the check types so callers can `import { DoctorCheck } from './index.js'`.
export type { DoctorCheck, CheckCategory, CheckContext } from './checks.js';

// ---------------------------------------------------------------------------
// VERSION
// ---------------------------------------------------------------------------

/**
 * Single source of truth for the CHISMOSO version reported by the doctor
 * and by /api/version. Bumped by release managers; do NOT change ad-hoc.
 *
 * History:
 *   1.0.0  — initial V1 release (investigate / providers / history / show)
 *   1.1.0  — embeddings subsystem (EXP-4)
 *   1.3.0  — MCP server + client (MCP-1, MCP-2)
 *   1.5.0  — Doctor + /api/health + /api/version (IMP-3)
 */
export const CHISMOSO_VERSION = '1.5.0';

// ---------------------------------------------------------------------------
// DOCTOR CLASS
// ---------------------------------------------------------------------------

export class ChismosoDoctor {
  private readonly dbPath: string;

  constructor(deps: DoctorDeps = {}) {
    this.dbPath = deps.dbPath ?? process.env.CHISMOSO_DB_PATH ?? DEFAULT_DB_PATH;
  }

  /**
   * Runs all 14 checks in parallel and returns the aggregated report.
   *
   * The DB is opened once at the start and closed in a finally block —
   * checks share the same connection via CheckContext. Each check is
   * independently try/caught (inside `timeCheck`) so a single failure
   * never aborts the whole scan.
   */
  async runAll(opts: RunOptions = {}): Promise<DoctorReport> {
    const applyFixes = opts.applyFixes === true;
    const db = new ChismosoDB({ path: this.dbPath });
    try {
      const ctx: CheckContext = await this.buildContext(db, applyFixes);
      const checks = await Promise.all(
        ALL_CHECKS.map((c) => c.run(ctx)),
      );
      return this.buildReport(checks);
    } finally {
      try { db.close(); } catch { /* ignore close errors during teardown */ }
    }
  }

  /**
   * Runs a single check by category. Used by `chismoso doctor --check=<category>`.
   *
   * The category is matched case-insensitively and tolerant of hyphens
   * (so `signal-ingestion` matches `signal_ingestion`). Returns the
   * single DoctorCheck; throws if the category is unknown.
   */
  async runOne(category: string, opts: RunOptions = {}): Promise<DoctorCheck> {
    const found = findCheck(category);
    if (!found) {
      const valid = ALL_CHECKS.map((c) => c.category).join(', ');
      throw new Error(
        `Unknown check category "${category}". Valid: ${valid}`,
      );
    }
    const applyFixes = opts.applyFixes === true;
    const db = new ChismosoDB({ path: this.dbPath });
    try {
      const ctx = await this.buildContext(db, applyFixes);
      return await found.run(ctx);
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  }

  // -----------------------------------------------------------------------
  // PRIVATE
  // -----------------------------------------------------------------------

  /**
   * Builds the CheckContext from the live DB. Constructed fresh on every
   * call — Repositories and ProviderRegistry are cheap to instantiate
   * (they just store references; the heavy lifting is lazy).
   */
  private async buildContext(db: ChismosoDB, applyFixes: boolean): Promise<CheckContext> {
    const repos = new Repositories(db);
    const providers = createDefaultProviderRegistry();
    const anomalyDetector = new AnomalyDetector(repos);
    logger.debug('ChismosoDoctor context ready', {
      dbPath: this.dbPath,
      applyFixes,
      checkCount: ALL_CHECKS.length,
    });
    return {
      dbPath: this.dbPath,
      db,
      repos,
      providers,
      anomalyDetector,
      applyFixes,
    };
  }

  /**
   * Aggregates the per-check results into the final DoctorReport. The
   * overall_status is the worst-of: FAIL > DEGRADED > OK. UNKNOWN is
   * NOT propagated to overall_status (it just lowers confidence — the
   * system is still operable if some subsystems haven't been set up yet).
   */
  private buildReport(checks: DoctorCheck[]): DoctorReport {
    const summary = { ok: 0, degraded: 0, fail: 0, unknown: 0 };
    for (const c of checks) {
      switch (c.status) {
        case 'OK': summary.ok++; break;
        case 'DEGRADED': summary.degraded++; break;
        case 'FAIL': summary.fail++; break;
        case 'UNKNOWN': summary.unknown++; break;
      }
    }
    const overall: DoctorReport['overall_status'] =
      summary.fail > 0 ? 'FAIL'
      : summary.degraded > 0 ? 'DEGRADED'
      : 'OK';
    const autoFixesApplied = checks.filter((c) => c.fix_applied === true).length;
    return {
      generated_at: new Date().toISOString(),
      version: CHISMOSO_VERSION,
      overall_status: overall,
      checks,
      summary,
      auto_fixes_applied: autoFixesApplied,
    };
  }
}

// ---------------------------------------------------------------------------
// CONVENIENCE — for callers that want a one-shot run without managing a
// ChismosoDoctor instance (used by /api/doctor in dev / smoke tests).
// ---------------------------------------------------------------------------

/**
 * One-shot helper: builds a doctor, runs all checks, returns the report.
 * Equivalent to `new ChismosoDoctor(deps).runAll(opts)`.
 */
export async function runDoctor(
  deps: DoctorDeps = {},
  opts: RunOptions = {},
): Promise<DoctorReport> {
  return new ChismosoDoctor(deps).runAll(opts);
}
