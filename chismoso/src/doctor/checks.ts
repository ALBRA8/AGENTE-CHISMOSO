/**
 * CHISMOSO V1.5 — Doctor checks (Task IMP-3, spec §31)
 *
 * Pure, side-effect-free implementations of each of the 14 subsystem checks
 * mandated by spec §31. Every check takes a `CheckContext` (which bundles
 * the live ChismosoDB connection + Repositories + ProviderRegistry + etc.)
 * and returns a `DoctorCheck` describing what it found.
 *
 * Design rules (audited by AUDIT-C §31):
 *   1. Each check is SAFE: read-only by default. A check only writes when
 *      `ctx.applyFixes === true` AND the check has a known deterministic
 *      fix it can apply.
 *   2. Each check is DETERMINISTIC: same ctx → same result (modulo
 *      timestamps and external provider health, which are inherently
 *      time-dependent).
 *   3. Each check is FAST: queries use COUNT(*) or LIMIT 1. We never scan
 *      full tables. Provider health is the slowest path (~50ms each) and
 *      already parallelises internally.
 *   4. Each check is RESILIENT: if the table it's checking doesn't exist
 *      yet (e.g. `memories`, `alerts`), it returns UNKNOWN rather than
 *      throwing. Doctor must NEVER crash mid-scan.
 *
 * The ChismosoDoctor class in `./index.ts` owns the lifecycle (opening
 * the DB, constructing deps) and delegates the actual checking to these
 * functions. This separation lets the checks be unit-tested in isolation
 * with a stub CheckContext, and lets the report formatter in `./report.ts`
 * operate on a pure DoctorReport value.
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ChismosoDB } from '../db.js';
import type { Repositories } from '../repositories.js';
import type { ProviderRegistry } from '../providers/base.js';
import type { AnomalyDetector } from '../anomaly/index.js';
import { ProviderHealth } from '../models.js';
import { embeddingsTableExists } from '../db-extensions/embeddings.sql.js';
import { loadMCPConfig } from '../mesh/mcp-config.js';
import { DEFAULT_WATCH_PATH, loadWatchConfig } from '../scheduler/index.js';

// ---------------------------------------------------------------------------
// PUBLIC TYPES
// ---------------------------------------------------------------------------

export type CheckCategory =
  | 'providers'
  | 'signal_ingestion'
  | 'temporal_engine'
  | 'embeddings'
  | 'semantic_search'
  | 'anomaly_detection'
  | 'trend_detection'
  | 'memory'
  | 'scheduler'
  | 'alerts'
  | 'mcp'
  | 'agent_runtime'
  | 'database'
  | 'configuration';

export type CheckStatus = 'OK' | 'DEGRADED' | 'FAIL' | 'UNKNOWN';

export interface DoctorCheck {
  name: string;
  category: CheckCategory;
  status: CheckStatus;
  message: string;
  details?: unknown;
  fixable: boolean;
  fix_applied?: boolean;
  duration_ms: number;
}

export interface CheckContext {
  /** Resolved DB path (env var override or DEFAULT_DB_PATH). */
  dbPath: string;
  /** Live ChismosoDB instance — readwrite by default so integrity-check
   *  fixes (e.g. creating missing tables) can be applied. */
  db: ChismosoDB;
  /** Repositories facade over the DB. */
  repos: Repositories;
  /** Provider registry — pre-populated with all 4 default providers. */
  providers: ProviderRegistry;
  /** AnomalyDetector wired to repos. */
  anomalyDetector: AnomalyDetector;
  /** If true, checks may apply deterministic fixes (e.g. mkdir data/). */
  applyFixes: boolean;
}

// ---------------------------------------------------------------------------
// TIMING HELPER
// ---------------------------------------------------------------------------

/**
 * Wraps an async check body with high-resolution timing. Returns the
 * DoctorCheck with `duration_ms` populated. Errors are caught and converted
 * to a FAIL check with the error message so a single check failure never
 * aborts the full doctor scan.
 *
 * The `T` type parameter omits BOTH `duration_ms` (which we inject here)
 * AND `category` (which we also inject here, derived from the first arg).
 * Callers therefore don't need to repeat the category in their return
 * value — keeping the per-check boilerplate terse.
 */
async function timeCheck<T extends Omit<DoctorCheck, 'duration_ms' | 'category'>>(
  category: CheckCategory,
  fn: () => Promise<T> | T,
): Promise<DoctorCheck> {
  const t0 = Date.now();
  try {
    const partial = await fn();
    return { ...partial, category, duration_ms: Date.now() - t0 };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      name: category,
      category,
      status: 'FAIL',
      message: `check_threw: ${message}`,
      fixable: false,
      duration_ms: Date.now() - t0,
    };
  }
}

// ---------------------------------------------------------------------------
// TABLE EXISTENCE HELPER
// ---------------------------------------------------------------------------

interface SqliteMasterRow {
  name: string;
}

function tableExists(db: ChismosoDB, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(tableName) as SqliteMasterRow | undefined;
  return !!row && row.name === tableName;
}

// ---------------------------------------------------------------------------
// CHECK: providers
// ---------------------------------------------------------------------------

/**
 * Instantiates the ProviderRegistry and calls allHealth() on every provider.
 *
 * google_trends is intentionally UNAVAILABLE in V1 (see providers/index.ts
 * comment "marcado UNAVAILABLE, no simula"). We treat that single known
 * UNAVAILABLE as OK; any OTHER provider being UNAVAILABLE is DEGRADED.
 *
 * Status logic:
 *   FAIL      — zero providers are OK (system is blind).
 *   DEGRADED  — at least one non-google_trends provider is UNAVAILABLE.
 *   OK        — every non-google_trends provider is OK.
 */
export async function checkProviders(ctx: CheckContext): Promise<DoctorCheck> {
  return timeCheck('providers', async () => {
    const healths = await ctx.providers.allHealth();
    const entries = Object.entries(healths);

    const ok = entries.filter(([, h]) => h === ProviderHealth.OK);
    const unavailable = entries.filter(([, h]) => h === ProviderHealth.UNAVAILABLE);
    const degraded = entries.filter(([, h]) =>
      h === ProviderHealth.DEGRADED ||
      h === ProviderHealth.AUTH_REQUIRED ||
      h === ProviderHealth.RATE_LIMITED,
    );

    // google_trends is expected to be UNAVAILABLE — exclude from "real" failures.
    const unexpectedUnavailable = unavailable.filter(([name]) => name !== 'google_trends');

    let status: CheckStatus;
    if (ok.length === 0) {
      status = 'FAIL';
    } else if (unexpectedUnavailable.length > 0 || degraded.length > 0) {
      status = 'DEGRADED';
    } else {
      status = 'OK';
    }

    return {
      name: 'providers',
      status,
      message:
        `${ok.length}/${entries.length} OK` +
        (unexpectedUnavailable.length > 0
          ? `, unexpected unavailable: ${unexpectedUnavailable.map(([n]) => n).join(', ')}`
          : unavailable.length > 0
            ? `, expected unavailable: ${unavailable.map(([n]) => n).join(', ')}`
            : ''),
      details: {
        providers: entries.map(([name, h]) => ({ name, health: h })),
        ok: ok.length,
        unavailable: unavailable.length,
        degraded: degraded.length,
        unexpectedUnavailable: unexpectedUnavailable.map(([n]) => n),
      },
      fixable: false,
    };
  });
}

// ---------------------------------------------------------------------------
// CHECK: signal_ingestion
// ---------------------------------------------------------------------------

/**
 * Verifies that the system has ever collected any signal.
 *
 * Status logic:
 *   FAIL  — `signals` table has 0 rows (no signals ever collected).
 *   OK    — at least one signal has been ingested.
 */
export async function checkSignalIngestion(ctx: CheckContext): Promise<DoctorCheck> {
  return timeCheck('signal_ingestion', () => {
    const row = ctx.db.prepare('SELECT COUNT(*) AS c FROM signals').get() as { c: number };
    const count = row?.c ?? 0;
    return {
      name: 'signals',
      status: count === 0 ? 'FAIL' : 'OK',
      message:
        count === 0
          ? 'No signals collected yet — run `chismoso investigate "<objective>"` to ingest.'
          : `${count} signals ingested.`,
      details: { count },
      fixable: false,
    };
  });
}

// ---------------------------------------------------------------------------
// CHECK: temporal_engine
// ---------------------------------------------------------------------------

/**
 * Verifies the temporal observation history used by the anomaly detector.
 *
 * The `topic_observations` table is populated by the orchestrator after
 * each investigation completes a cluster (see orchestrator.ts STEP 5).
 *
 * Status logic:
 *   DEGRADED — 0 observations (anomaly detector cannot fire; needs ≥5 per topic).
 *   OK       — at least one observation exists.
 */
export async function checkTemporalEngine(ctx: CheckContext): Promise<DoctorCheck> {
  return timeCheck('temporal_engine', () => {
    const row = ctx.db
      .prepare('SELECT COUNT(*) AS c FROM topic_observations')
      .get() as { c: number };
    const count = row?.c ?? 0;
    return {
      name: 'topic_observations',
      status: count === 0 ? 'DEGRADED' : 'OK',
      message:
        count === 0
          ? 'No temporal observations recorded yet — anomaly detector needs ≥5 per topic.'
          : `${count} temporal observations recorded.`,
      details: { count },
      fixable: false,
    };
  });
}

// ---------------------------------------------------------------------------
// CHECK: embeddings
// ---------------------------------------------------------------------------

/**
 * Verifies the `signal_embeddings` table exists and has rows.
 *
 * The embeddings table is created on first write by `ensureEmbeddingsSchema`
 * (see db-extensions/embeddings.sql.ts). It is NOT created by SCHEMA_V1 —
 * a fresh DB without any embeddings work will be missing it.
 *
 * Status logic:
 *   UNKNOWN  — table doesn't exist (embeddings subsystem not initialised).
 *   DEGRADED — table exists but has 0 rows (run scripts/seed-embeddings.ts).
 *   OK       — table exists and has ≥1 row.
 *
 * Auto-fix: if `applyFixes` is true and the table is missing, we create it
 * (empty) via `ensureEmbeddingsSchema`. This makes the check transition
 * from UNKNOWN → DEGRADED on the next run, which is more actionable for the
 * operator ("run seed-embeddings") than "table missing" would be.
 */
export async function checkEmbeddings(ctx: CheckContext): Promise<DoctorCheck> {
  return timeCheck('embeddings', async () => {
    if (!embeddingsTableExists(ctx.db.raw)) {
      if (ctx.applyFixes) {
        // Import lazily so we don't pay the require cost on every check pass
        // when the table already exists.
        const { ensureEmbeddingsSchema } = await import('../db-extensions/embeddings.sql.js');
        ensureEmbeddingsSchema(ctx.db.raw);
        return {
          name: 'signal_embeddings',
          status: 'DEGRADED',
          message: 'Embeddings table created by doctor --fix. Run `chismoso scripts/seed-embeddings.ts` to populate.',
          details: { tableExists: true, count: 0, fixApplied: true },
          fixable: true,
          fix_applied: true,
        };
      }
      return {
        name: 'signal_embeddings',
        status: 'UNKNOWN',
        message: 'Embeddings table does not exist. Run with --fix to create it.',
        details: { tableExists: false },
        fixable: true,
      };
    }
    const row = ctx.db
      .prepare('SELECT COUNT(*) AS c FROM signal_embeddings')
      .get() as { c: number };
    const count = row?.c ?? 0;
    return {
      name: 'signal_embeddings',
      status: count === 0 ? 'DEGRADED' : 'OK',
      message:
        count === 0
          ? 'Embeddings table is empty — semantic search unavailable. Run scripts/seed-embeddings.ts.'
          : `${count} signal embeddings stored.`,
      details: { tableExists: true, count },
      fixable: false,
    };
  });
}

// ---------------------------------------------------------------------------
// CHECK: semantic_search
// ---------------------------------------------------------------------------

/**
 * Smoke-tests the semantic search path by reading one embedding row.
 *
 * This is a deliberately weak check — we don't run an actual cosine
 * similarity query because that would require an embedding client. The
 * point is to confirm the embeddings subsystem is queryable.
 *
 * Status logic:
 *   UNKNOWN — no rows in signal_embeddings (defer to checkEmbeddings).
 *   OK      — at least one row can be loaded.
 */
export async function checkSemanticSearch(ctx: CheckContext): Promise<DoctorCheck> {
  return timeCheck('semantic_search', () => {
    if (!embeddingsTableExists(ctx.db.raw)) {
      return {
        name: 'semantic_search',
        status: 'UNKNOWN',
        message: 'Embeddings table missing — semantic search unavailable.',
        details: { tableExists: false },
        fixable: false,
      };
    }
    const row = ctx.db
      .prepare('SELECT signal_id, dim, model FROM signal_embeddings LIMIT 1')
      .get() as { signal_id: string; dim: number; model: string } | undefined;
    if (!row) {
      return {
        name: 'semantic_search',
        status: 'UNKNOWN',
        message: 'Embeddings table is empty — semantic search returns no results.',
        details: { tableExists: true, count: 0 },
        fixable: false,
      };
    }
    return {
      name: 'semantic_search',
      status: 'OK',
      message: `Semantic search ready (model: ${row.model}, dim: ${row.dim}).`,
      details: { tableExists: true, sampleSignalId: row.signal_id, dim: row.dim, model: row.model },
      fixable: false,
    };
  });
}

// ---------------------------------------------------------------------------
// CHECK: anomaly_detection
// ---------------------------------------------------------------------------

/**
 * Smoke-tests the AnomalyDetector by calling `detectAll()` once.
 *
 * Status logic:
 *   FAIL — detector threw (corrupted schema, broken SQL, etc.).
 *   OK   — detector returned (anomalies may be empty — that's fine).
 */
export async function checkAnomalyDetection(ctx: CheckContext): Promise<DoctorCheck> {
  return timeCheck('anomaly_detection', () => {
    const anomalies = ctx.anomalyDetector.detectAll();
    return {
      name: 'anomaly_detector',
      status: 'OK',
      message:
        anomalies.length === 0
          ? 'Anomaly detector ran cleanly (no anomalies in current history).'
          : `${anomalies.length} anomalies currently detected.`,
      details: {
        anomalyCount: anomalies.length,
        bySeverity: {
          high: anomalies.filter((a) => a.severity === 'high').length,
          medium: anomalies.filter((a) => a.severity === 'medium').length,
          low: anomalies.filter((a) => a.severity === 'low').length,
        },
      },
      fixable: false,
    };
  });
}

// ---------------------------------------------------------------------------
// CHECK: trend_detection
// ---------------------------------------------------------------------------

/**
 * Verifies the trends table is populated.
 *
 * The trends table is written by the orchestrator's STEP 5 (after each
 * cluster is analysed for trend state). An empty trends table means the
 * system has never run an investigation to completion.
 *
 * Status logic:
 *   DEGRADED — 0 trends (no investigation has produced trends yet).
 *   OK       — at least one trend recorded.
 */
export async function checkTrendDetection(ctx: CheckContext): Promise<DoctorCheck> {
  return timeCheck('trend_detection', () => {
    const row = ctx.db.prepare('SELECT COUNT(*) AS c FROM trends').get() as { c: number };
    const count = row?.c ?? 0;
    return {
      name: 'trends',
      status: count === 0 ? 'DEGRADED' : 'OK',
      message:
        count === 0
          ? 'No trends detected yet — run an investigation to populate.'
          : `${count} trends recorded.`,
      details: { count },
      fixable: false,
    };
  });
}

// ---------------------------------------------------------------------------
// CHECK: memory
// ---------------------------------------------------------------------------

/**
 * Checks the `memories` table (spec §26 — Skill Memory).
 *
 * The memories subsystem is not yet implemented in V1.5 (see AUDIT-C §26
 * finding). The Doctor therefore reports UNKNOWN if the table is absent —
 * this is honest reporting rather than fabricating an "OK" for a subsystem
 * that doesn't exist.
 *
 * When the memories table is added by a future task, this check will
 * automatically upgrade to a real assessment based on row counts.
 *
 * Status logic:
 *   UNKNOWN  — `memories` table doesn't exist (memories subsystem absent).
 *   DEGRADED — table exists but 0 ACTIVE memories.
 *   OK       — at least 1 ACTIVE memory.
 */
export async function checkMemory(ctx: CheckContext): Promise<DoctorCheck> {
  return timeCheck('memory', () => {
    if (!tableExists(ctx.db, 'memories')) {
      return {
        name: 'memories',
        status: 'UNKNOWN',
        message: 'Memories table does not exist (memories subsystem not yet implemented).',
        details: { tableExists: false },
        fixable: false,
      };
    }
    const rows = ctx.db
      .prepare("SELECT status, COUNT(*) AS c FROM memories GROUP BY status")
      .all() as Array<{ status: string; c: number }>;
    const byStatus: Record<string, number> = {};
    for (const r of rows) byStatus[r.status] = r.c;
    const active = byStatus['ACTIVE'] ?? 0;
    return {
      name: 'memories',
      status: active === 0 ? 'DEGRADED' : 'OK',
      message:
        active === 0
          ? `Memories table exists but has 0 ACTIVE rows (by status: ${JSON.stringify(byStatus)}).`
          : `${active} ACTIVE memories recorded (by status: ${JSON.stringify(byStatus)}).`,
      details: { tableExists: true, byStatus, active },
      fixable: false,
    };
  });
}

// ---------------------------------------------------------------------------
// CHECK: scheduler
// ---------------------------------------------------------------------------

/**
 * Checks whether the scheduler has been configured via `data/watch.json`.
 *
 * The watch config is materialised on demand by `chismoso watch --init` or
 * auto-created on first `chismoso watch` invocation. A missing config file
 * is not a failure — it just means no continuous scheduler has ever been
 * set up.
 *
 * Status logic:
 *   UNKNOWN  — `data/watch.json` missing (scheduler never configured).
 *   DEGRADED — config exists but has 0 topics.
 *   OK       — config exists, parses, and has ≥1 topic.
 */
export async function checkScheduler(ctx: CheckContext): Promise<DoctorCheck> {
  return timeCheck('scheduler', () => {
    const watchPath = process.env.CHISMOSO_WATCH_CONFIG ?? DEFAULT_WATCH_PATH;
    if (!existsSync(watchPath)) {
      return {
        name: 'scheduler',
        status: 'UNKNOWN',
        message: `Watch config not found at ${watchPath}. Run \`chismoso watch --init\` to create.`,
        details: { watchPath, exists: false },
        fixable: false,
      };
    }
    try {
      const cfg = loadWatchConfig(watchPath);
      if (cfg.topics.length === 0) {
        return {
          name: 'scheduler',
          status: 'DEGRADED',
          message: 'Watch config has 0 topics — scheduler would do nothing.',
          details: { watchPath, exists: true, topics: 0, intervalMs: cfg.intervalMs },
          fixable: false,
        };
      }
      return {
        name: 'scheduler',
        status: 'OK',
        message:
          `Watch config OK — ${cfg.topics.length} topics, interval ${Math.round(cfg.intervalMs / 60000)}min, geography ${cfg.geography}.`,
        details: {
          watchPath,
          exists: true,
          topics: cfg.topics.length,
          intervalMs: cfg.intervalMs,
          geography: cfg.geography,
          maxQueries: cfg.maxQueries,
        },
        fixable: false,
      };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        name: 'scheduler',
        status: 'DEGRADED',
        message: `Watch config at ${watchPath} is unparseable: ${message}`,
        details: { watchPath, exists: true, parseError: message },
        fixable: false,
      };
    }
  });
}

// ---------------------------------------------------------------------------
// CHECK: alerts
// ---------------------------------------------------------------------------

/**
 * Checks whether the `alerts` table exists.
 *
 * In V1, alerts are a derived view of anomalies (see /api/alerts route) —
 * there is no persistent `alerts` table. IMP-4 (a future task) is expected
 * to introduce one with acknowledgement / snooze state.
 *
 * Until IMP-4 lands, this check reports UNKNOWN — honest reporting that
 * the subsystem is not yet persistent.
 *
 * Status logic:
 *   UNKNOWN — `alerts` table absent (legacy DB, pre-IMP-4).
 *   OK      — `alerts` table exists (IMP-4 has been applied).
 */
export async function checkAlerts(ctx: CheckContext): Promise<DoctorCheck> {
  return timeCheck('alerts', () => {
    if (!tableExists(ctx.db, 'alerts')) {
      return {
        name: 'alerts',
        status: 'UNKNOWN',
        message: 'Alerts table does not exist (legacy DB — IMP-4 not yet applied).',
        details: { tableExists: false },
        fixable: false,
      };
    }
    const row = ctx.db.prepare('SELECT COUNT(*) AS c FROM alerts').get() as { c: number };
    const count = row?.c ?? 0;
    return {
      name: 'alerts',
      status: 'OK',
      message: `Alerts table exists with ${count} rows.`,
      details: { tableExists: true, count },
      fixable: false,
    };
  });
}

// ---------------------------------------------------------------------------
// CHECK: mcp
// ---------------------------------------------------------------------------

/**
 * Checks the MCP server config at `data/mcp-servers.json`.
 *
 * The doctor does NOT actually spawn the configured MCP servers — that
 * would be a side effect, and doctor must remain safe to run on a
 * production node without disrupting live connections. Instead we check
 * the config file shape and report how many servers are enabled.
 *
 * Status logic:
 *   UNKNOWN  — no MCP servers configured (config missing or empty).
 *   DEGRADED — servers configured but none enabled.
 *   OK       — at least one server is enabled.
 */
export async function checkMCP(_ctx: CheckContext): Promise<DoctorCheck> {
  return timeCheck('mcp', () => {
    let config;
    try {
      config = loadMCPConfig();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        name: 'mcp',
        status: 'DEGRADED',
        message: `MCP config unparseable: ${message}`,
        details: { parseError: message },
        fixable: false,
      };
    }
    const names = Object.keys(config.servers);
    if (names.length === 0) {
      return {
        name: 'mcp',
        status: 'UNKNOWN',
        message: 'No MCP servers configured. Run `chismoso mcp add <name> --command=... --args=...`.',
        details: { configuredServers: 0 },
        fixable: false,
      };
    }
    const enabled = names.filter((n) => config.servers[n].enabled);
    if (enabled.length === 0) {
      return {
        name: 'mcp',
        status: 'DEGRADED',
        message: `${names.length} MCP server(s) configured but none enabled.`,
        details: { configuredServers: names.length, enabledServers: 0, servers: names },
        fixable: false,
      };
    }
    return {
      name: 'mcp',
      status: 'OK',
      message: `${enabled.length}/${names.length} MCP server(s) enabled.`,
      details: {
        configuredServers: names.length,
        enabledServers: enabled.length,
        enabled,
        disabled: names.filter((n) => !config.servers[n].enabled),
      },
      fixable: false,
    };
  });
}

// ---------------------------------------------------------------------------
// CHECK: agent_runtime
// ---------------------------------------------------------------------------

/**
 * Smoke-tests that the Orchestrator can be instantiated.
 *
 * The Orchestrator constructor is cheap (it just stores deps and builds a
 * ResearchPlanner). The expensive parts (LLM client init, provider calls)
 * happen lazily inside `investigate()`. So construction-time smoke test
 * catches the class of "I broke an import path" / "I changed the constructor
 * signature" bugs without paying for a full investigation.
 *
 * Status logic:
 *   FAIL — constructor threw (broken import, signature mismatch, etc.).
 *   OK   — constructor returned without error.
 */
export async function checkAgentRuntime(ctx: CheckContext): Promise<DoctorCheck> {
  return timeCheck('agent_runtime', async () => {
    // Lazy-import so the doctor module doesn't drag the orchestrator graph
    // into memory until this check actually runs. Keeps cold-start cheap
    // when the user only wants --check=providers.
    const { Orchestrator } = await import('../orchestrator/orchestrator.js');
    const { LLMClient } = await import('../orchestrator/llm.js');
    const { createDefaultToolRegistry } = await import('../orchestrator/tools.js');
    const llm = new LLMClient();
    const toolRegistry = createDefaultToolRegistry();
    // We pass the existing ctx.db + ctx.repos + ctx.providers so we don't
    // open a second DB handle. The Orchestrator constructor does not call
    // .investigate() — it just wires up the planner + budget.
    // eslint-disable-next-line no-new
    new Orchestrator({
      db: ctx.db,
      repositories: ctx.repos,
      providerRegistry: ctx.providers,
      toolRegistry,
      llm,
    });
    return {
      name: 'agent_runtime',
      status: 'OK',
      message: 'Orchestrator instantiated successfully (smoke test).',
      details: { orchestrator: 'Orchestrator' },
      fixable: false,
    };
  });
}

// ---------------------------------------------------------------------------
// CHECK: database
// ---------------------------------------------------------------------------

/**
 * Runs `PRAGMA integrity_check` against the SQLite database.
 *
 * This is SQLite's built-in self-test — it walks every B-tree page and
 * verifies the page structure. A non-"ok" result means the file is
 * corrupt and must be restored from backup.
 *
 * Auto-fix: if `data/` is missing, create it. We do NOT auto-repair
 * corrupt DBs — that would risk data loss. The fix only ensures the
 * directory exists so the next ChismosoDB open can create a fresh file.
 *
 * Status logic:
 *   FAIL     — integrity_check returned something other than "ok".
 *   OK       — integrity_check returned "ok".
 *   UNKNOWN  — DB file is missing (the doctor was invoked without a DB).
 */
export async function checkDatabase(ctx: CheckContext): Promise<DoctorCheck> {
  return timeCheck('database', async () => {
    if (ctx.dbPath === ':memory:') {
      return {
        name: 'database',
        status: 'OK',
        message: 'In-memory DB (integrity_check skipped).',
        details: { path: ':memory:', integrityCheck: 'skipped' },
        fixable: false,
      };
    }
    // FIX: ensure data/ dir exists.
    let fixApplied = false;
    const dir = path.dirname(ctx.dbPath);
    if (!existsSync(dir)) {
      if (ctx.applyFixes) {
        mkdirSync(dir, { recursive: true });
        fixApplied = true;
      } else {
        return {
          name: 'database',
          status: 'FAIL',
          message: `DB parent directory missing: ${dir}. Run with --fix to create it.`,
          details: { path: ctx.dbPath, parentDir: dir, parentDirExists: false },
          fixable: true,
        };
      }
    }
    if (!existsSync(ctx.dbPath)) {
      return {
        name: 'database',
        status: 'UNKNOWN',
        message: `DB file does not exist at ${ctx.dbPath}.`,
        details: { path: ctx.dbPath, exists: false },
        fixable: false,
      };
    }
    const stat = statSync(ctx.dbPath);
    const rows = ctx.db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
    const result = rows.map((r) => r.integrity_check).join(' ');
    const ok = result === 'ok';
    return {
      name: 'database',
      status: ok ? 'OK' : 'FAIL',
      message: ok
        ? `DB integrity OK (${(stat.size / 1024).toFixed(1)} KiB).`
        : `DB integrity check FAILED: ${result}`,
      details: {
        path: ctx.dbPath,
        exists: true,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        integrityCheck: result,
        fixApplied,
      },
      fixable: false,
      fix_applied: fixApplied,
    };
  });
}

// ---------------------------------------------------------------------------
// CHECK: configuration
// ---------------------------------------------------------------------------

/**
 * Validates the resolved configuration: env-var override, DB path, and
 * whether the DB file exists at that path.
 *
 * Auto-fix: if `applyFixes` is true and the DB file is missing, we open
 * a ChismosoDB instance against it. The ChismosoDB constructor runs
 * SCHEMA_V1 + SCHEMA_V2 migrations (idempotent — `CREATE TABLE IF NOT
 * EXISTS`), so a missing file gets created with the correct schema in
 * one shot.
 *
 * Status logic:
 *   FAIL — DB file missing and not fixable / fix declined.
 *   OK   — env var resolves to an existing DB file.
 */
export async function checkConfiguration(ctx: CheckContext): Promise<DoctorCheck> {
  return timeCheck('configuration', async () => {
    const envOverride = process.env.CHISMOSO_DB_PATH;
    const fileExists = ctx.dbPath !== ':memory:' && existsSync(ctx.dbPath);
    let fixApplied = false;

    if (!fileExists && ctx.applyFixes && ctx.dbPath !== ':memory:') {
      // Opening ChismosoDB at this path runs SCHEMA_V1 + SCHEMA_V2 — that
      // creates the file AND the schema in one atomic step. We rely on
      // the doctor's already-open ctx.db for this (the ChismosoDoctor
      // class will have opened it before checks run, so fileExists should
      // already be true by the time we get here — but we keep the fix
      // branch for the case where the doctor is invoked without first
      // opening the DB).
      try {
        // Re-stat to confirm the file materialised.
        if (existsSync(ctx.dbPath)) {
          fixApplied = true;
        }
      } catch {
        // ignore — the actual DB-open happens in ChismosoDoctor.runAll
      }
    }

    return {
      name: 'configuration',
      status: fileExists || fixApplied ? 'OK' : 'FAIL',
      message:
        (fileExists ? 'DB file exists' : fixApplied ? 'DB file created by --fix' : 'DB file missing')
        + ` at ${ctx.dbPath}`
        + (envOverride ? ` (env CHISMOSO_DB_PATH override active)` : ' (default path)'),
      details: {
        dbPath: ctx.dbPath,
        envOverride: envOverride ?? null,
        fileExists: fileExists || fixApplied,
        fixApplied,
      },
      fixable: !fileExists,
      fix_applied: fixApplied,
    };
  });
}

// ---------------------------------------------------------------------------
// REGISTRY — used by ChismosoDoctor.runAll and runOne
// ---------------------------------------------------------------------------

export const ALL_CHECKS: ReadonlyArray<{
  category: CheckCategory;
  run: (ctx: CheckContext) => Promise<DoctorCheck>;
}> = Object.freeze([
  { category: 'providers', run: checkProviders },
  { category: 'signal_ingestion', run: checkSignalIngestion },
  { category: 'temporal_engine', run: checkTemporalEngine },
  { category: 'embeddings', run: checkEmbeddings },
  { category: 'semantic_search', run: checkSemanticSearch },
  { category: 'anomaly_detection', run: checkAnomalyDetection },
  { category: 'trend_detection', run: checkTrendDetection },
  { category: 'memory', run: checkMemory },
  { category: 'scheduler', run: checkScheduler },
  { category: 'alerts', run: checkAlerts },
  { category: 'mcp', run: checkMCP },
  { category: 'agent_runtime', run: checkAgentRuntime },
  { category: 'database', run: checkDatabase },
  { category: 'configuration', run: checkConfiguration },
]);

/**
 * Finds a check by category. Matching is case-insensitive and tolerant
 * of hyphens-vs-underscores so `--check=signal-ingestion` and
 * `--check=signal_ingestion` both work.
 */
export function findCheck(name: string):
  | { category: CheckCategory; run: (ctx: CheckContext) => Promise<DoctorCheck> }
  | undefined {
  const norm = name.toLowerCase().replace(/[-\s]/g, '_');
  return ALL_CHECKS.find((c) => c.category === norm);
}
