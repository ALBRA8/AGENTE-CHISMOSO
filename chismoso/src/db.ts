/**
 * CHISMOSO V1.0 — SQLite foundation (sección 31)
 *
 * Tablas conceptuales (especificación):
 *   topics, signals, evidence, trend_observations, trends, problems,
 *   opportunities, investigations, sources, provider_runs
 *
 * Para V1 simplificamos manteniendo la semántica:
 *   - topics            : agrupaciones canónicas de keywords
 *   - signals           : señales normalizadas
 *   - evidence          : evidencia observada (ADN de evidencia)
 *   - trends            : tendencias detectadas
 *   - problems          : problemas detectados
 *   - opportunities     : oportunidades generadas
 *   - investigations    : metadata de cada investigación
 *   - provider_runs     : cada ejecución de un provider (observability)
 *   - topic_observations: evolución temporal de un topic (memory)
 */

import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from './logger.js';

export interface DBConfig {
  path: string;
}

export const DEFAULT_DB_PATH = '/home/z/my-project/chismoso/data/chismoso.db';

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS topics (
  id               TEXT PRIMARY KEY,
  canonical        TEXT NOT NULL,
  keywords_json    TEXT NOT NULL,
  sources_count    INTEGER DEFAULT 0,
  first_seen       TEXT NOT NULL,
  last_seen        TEXT NOT NULL,
  observation_count INTEGER DEFAULT 1,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_topics_canonical ON topics(canonical);

CREATE TABLE IF NOT EXISTS signals (
  id                TEXT PRIMARY KEY,
  topic             TEXT NOT NULL,
  keyword           TEXT NOT NULL,
  source            TEXT NOT NULL,
  source_type       TEXT NOT NULL,
  timestamp         TEXT NOT NULL,
  geography         TEXT,
  metric            TEXT,
  value             TEXT,
  normalized_value  REAL,
  direction         TEXT,
  velocity          REAL,
  confidence        REAL,
  evidence_type     TEXT,
  signal_type       TEXT NOT NULL,
  metadata_json     TEXT,
  raw_snippet       TEXT,
  url               TEXT,
  investigation_id  TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signals_topic ON signals(topic);
CREATE INDEX IF NOT EXISTS idx_signals_keyword ON signals(keyword);
CREATE INDEX IF NOT EXISTS idx_signals_source_type ON signals(source_type);
CREATE INDEX IF NOT EXISTS idx_signals_investigation ON signals(investigation_id);

CREATE TABLE IF NOT EXISTS evidence (
  id                 TEXT PRIMARY KEY,
  source             TEXT NOT NULL,
  source_type         TEXT NOT NULL,
  url                TEXT,
  observed_at        TEXT NOT NULL,
  collected_at       TEXT NOT NULL,
  geographic_scope   TEXT,
  topic              TEXT,
  raw_value          TEXT,
  normalized_value   TEXT,
  confidence         REAL,
  evidence_type      TEXT,
  metadata_json      TEXT,
  investigation_id   TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_topic ON evidence(topic);
CREATE INDEX IF NOT EXISTS idx_evidence_investigation ON evidence(investigation_id);

CREATE TABLE IF NOT EXISTS trends (
  id                TEXT PRIMARY KEY,
  topic             TEXT NOT NULL,
  description       TEXT NOT NULL,
  state             TEXT NOT NULL,
  confidence        REAL,
  sources_count     INTEGER,
  signals_count     INTEGER,
  first_seen        TEXT,
  last_seen         TEXT,
  observation_count INTEGER DEFAULT 1,
  growth            REAL,
  velocity          REAL,
  persistence       REAL,
  cross_source_confirmation REAL,
  score             REAL,
  score_breakdown_json TEXT,
  evidence_json     TEXT,
  signals_json      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  investigation_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_trends_topic ON trends(topic);

CREATE TABLE IF NOT EXISTS problems (
  id                TEXT PRIMARY KEY,
  description       TEXT NOT NULL,
  topic             TEXT,
  severity          REAL,
  frequency         REAL,
  confidence        REAL,
  segments_json     TEXT,
  first_seen        TEXT,
  last_seen         TEXT,
  observation_count INTEGER DEFAULT 1,
  evidence_json     TEXT,
  signals_json      TEXT,
  created_at        TEXT NOT NULL,
  investigation_id  TEXT
);

CREATE TABLE IF NOT EXISTS opportunities (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL,
  problem           TEXT,
  problem_ref       TEXT,
  target_segment    TEXT,
  geography         TEXT,
  demand            REAL,
  growth            REAL,
  problem_severity  REAL,
  monetization      REAL,
  timing            REAL,
  market_fit        REAL,
  competition       REAL,
  uncertainty       REAL,
  score             REAL,
  score_breakdown_json TEXT,
  confidence        REAL,
  suggested_next_agent TEXT,
  trend_ref         TEXT,
  evidence_json     TEXT,
  created_at        TEXT NOT NULL,
  investigation_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_opportunities_score ON opportunities(score DESC);

CREATE TABLE IF NOT EXISTS investigations (
  id                TEXT PRIMARY KEY,
  query             TEXT NOT NULL,
  scope             TEXT,
  started_at        TEXT NOT NULL,
  completed_at      TEXT,
  status            TEXT NOT NULL,
  providers_json    TEXT,
  queries_json      TEXT,
  signals_found     INTEGER DEFAULT 0,
  evidence_found    INTEGER DEFAULT 0,
  trends_found      INTEGER DEFAULT 0,
  problems_found    INTEGER DEFAULT 0,
  opportunities_found INTEGER DEFAULT 0,
  errors_json       TEXT,
  duration_ms       INTEGER,
  iterations        INTEGER,
  budget_json       TEXT,
  provider_runs_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_investigations_status ON investigations(status);

CREATE TABLE IF NOT EXISTS provider_runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  investigation_id  TEXT,
  provider_name     TEXT NOT NULL,
  started_at        TEXT NOT NULL,
  completed_at      TEXT,
  query             TEXT,
  results_count     INTEGER DEFAULT 0,
  error             TEXT,
  error_code        TEXT,
  duration_ms       INTEGER
);

CREATE TABLE IF NOT EXISTS topic_observations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  topic             TEXT NOT NULL,
  observed_at       TEXT NOT NULL,
  sources_count     INTEGER,
  signals_count     INTEGER,
  evidence_count    INTEGER,
  confidence        REAL,
  note              TEXT
);
CREATE INDEX IF NOT EXISTS idx_topic_obs_topic ON topic_observations(topic);
CREATE INDEX IF NOT EXISTS idx_topic_obs_time ON topic_observations(observed_at);

-- -----------------------------------------------------------------------
-- memories — MemoryDV (spec §12-§14)
-- -----------------------------------------------------------------------
-- One row per MemoryRecord (see src/memory/models.ts). Holds the full §13
-- contract: agent_id, domain, type, content, source, evidence_id, provenance,
-- confidence, truth_level, relevance, utility, decay_half_life_days, scope,
-- status, created_at, updated_at, last_verified.
--
-- The table is created here in SCHEMA_V1 (idempotent IF NOT EXISTS) so that
-- existing DBs gain it on the next CLI run without needing a migration script.
-- Performance indexes are added in SCHEMA_V2 below — same pattern as the
-- signals/evidence/trends tables above.
CREATE TABLE IF NOT EXISTS memories (
  id                TEXT PRIMARY KEY,
  agent_id          TEXT NOT NULL,
  domain            TEXT NOT NULL,
  type              TEXT NOT NULL,
  content           TEXT NOT NULL,
  source            TEXT,
  source_type       TEXT,
  evidence_id       TEXT,
  provenance        TEXT,
  confidence        REAL,
  truth_level       TEXT,
  relevance         REAL,
  utility           REAL DEFAULT 0,
  decay_half_life_days INTEGER DEFAULT 30,
  scope             TEXT,
  status            TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  last_verified     TEXT NOT NULL,
  related_signal_ids_json TEXT,
  related_topic     TEXT
);

-- ---------------------------------------------------------------------------
-- skills (spec §26, §27, §28) — Skills + lifecycle + invocations
-- ---------------------------------------------------------------------------
-- A Skill is a reusable, versioned, measurable capability. Each skill lives
-- a lifecycle (PROPOSED -> VALIDATING -> ACTIVE -> DEPRECATED -> RETIRED) and
-- records every invocation so that success_rate is MEASURED from
-- observed runs, not guessed.
--
-- The schema mirrors the Skill / SkillInvocation interfaces in
-- src/skills/models.ts. JSON arrays are stored as TEXT (SQLite has no native
-- array type); the repository handles serialization.
CREATE TABLE IF NOT EXISTS skills (
  id                 TEXT PRIMARY KEY,
  identity           TEXT UNIQUE NOT NULL,
  purpose            TEXT NOT NULL,
  trigger            TEXT,
  prerequisites_json TEXT,
  procedure          TEXT,
  tools_required_json TEXT,
  expected_result    TEXT,
  verification       TEXT,
  pitfalls_json      TEXT,
  evidence           TEXT,
  version            TEXT DEFAULT '1.0.0',
  confidence         REAL DEFAULT 0.5,
  success_rate       REAL DEFAULT 0,
  origin             TEXT DEFAULT 'builtin',
  last_validated     TEXT,
  regression_tests   TEXT,
  status             TEXT NOT NULL DEFAULT 'PROPOSED',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  invocations        INTEGER DEFAULT 0,
  successes          INTEGER DEFAULT 0,
  failures           INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_skills_status ON skills(status);
CREATE INDEX IF NOT EXISTS idx_skills_identity ON skills(identity);
CREATE INDEX IF NOT EXISTS idx_skills_origin ON skills(origin);

CREATE TABLE IF NOT EXISTS skill_invocations (
  id                TEXT PRIMARY KEY,
  skill_id          TEXT NOT NULL,
  investigation_id  TEXT,
  invoked_at        TEXT NOT NULL,
  completed_at      TEXT,
  status            TEXT NOT NULL,
  inputs_json       TEXT,
  outputs_json      TEXT,
  error             TEXT,
  feedback          TEXT,
  FOREIGN KEY (skill_id) REFERENCES skills(id)
);
CREATE INDEX IF NOT EXISTS idx_skill_inv_skill ON skill_invocations(skill_id);
CREATE INDEX IF NOT EXISTS idx_skill_inv_status ON skill_invocations(status);
CREATE INDEX IF NOT EXISTS idx_skill_inv_investigation ON skill_invocations(investigation_id);
CREATE INDEX IF NOT EXISTS idx_skill_inv_invoked_at ON skill_invocations(invoked_at DESC);
`;

/**
 * SCHEMA_V2 — performance indexes added after the AUDIT-PERF review.
 *
 * Idempotent (`IF NOT EXISTS`) so existing DBs gain the new indexes on the
 * next CLI run without needing a migration script. These indexes back the
 * most common dashboard queries:
 *   - signals(topic, timestamp DESC)  — /api/anomalies source-diversity N+1
 *   - trends.created_at DESC          — /api/trends "latest" sort
 *   - problems.created_at DESC        — /api/problems "latest" sort
 *   - evidence(topic, collected_at)   — evidence timeline lookups
 *   - provider_runs.investigation_id  — /api/investigations/[id] join
 *
 * The same set of indexes is also applied by the Next.js singleton reader
 * in `src/lib/db-chismoso.ts` so that a fresh dashboard process benefits
 * even before the CLI runs again.
 */
const SCHEMA_V2 = `
CREATE INDEX IF NOT EXISTS idx_signals_timestamp ON signals(timestamp);
CREATE INDEX IF NOT EXISTS idx_signals_topic_timestamp ON signals(topic, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_trends_created_at ON trends(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_problems_created_at ON problems(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_topic_collected ON evidence(topic, collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_provider_runs_investigation ON provider_runs(investigation_id);

-- memories (MemoryDV) indexes — back the most common queries:
--   findByDomain, findByTopic, findActive, applyDecay.
CREATE INDEX IF NOT EXISTS idx_memories_domain ON memories(domain);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
CREATE INDEX IF NOT EXISTS idx_memories_relevance ON memories(relevance);
CREATE INDEX IF NOT EXISTS idx_memories_topic ON memories(related_topic);
`;

/**
 * SCHEMA_V3 — Provider Quality metrics table (spec §10, audit B).
 *
 * Per-provider rolling stats used by `ProviderQualityTracker` to detect
 * degraded providers (low success_rate, high duplicate_rate). Each row
 * is upserted on every provider call.
 *
 * `latencies_json` holds a ring buffer of recent latencies (last ~100
 * calls) so the tracker can compute a true p95 without scanning
 * `provider_runs`.
 */
const SCHEMA_V3 = `
CREATE TABLE IF NOT EXISTS provider_quality (
  provider_name          TEXT PRIMARY KEY,
  total_calls            INTEGER DEFAULT 0,
  successful_calls       INTEGER DEFAULT 0,
  failed_calls           INTEGER DEFAULT 0,
  total_signals_returned INTEGER DEFAULT 0,
  duplicate_signals      INTEGER DEFAULT 0,
  latencies_json         TEXT,
  last_call_at           TEXT,
  last_success_at        TEXT,
  last_failure_at        TEXT,
  last_error             TEXT,
  updated_at             TEXT NOT NULL
);
`;

/**
 * SCHEMA_V4 — Alerts (Task IMP-4, spec §20).
 *
 * Managed lifecycle layer over AnomalyDetector output. Each row is an alert
 * derived from one anomaly. The same logical anomaly may produce multiple
 * alert rows over time, separated by cooldown windows. The AlertManager
 * (src/alerts/manager.ts) is the only component that writes here; readers
 * are the /api/alerts routes, the CLI \`chismoso alerts list\` command, and
 * the MCP \`chismoso://alerts/active\` resource (future).
 *
 * Lifecycle: DETECTED → SENT → ACKNOWLEDGED → RESOLVED
 * (SUPPRESSED is a transient result of AlertManager.emit, never persisted.)
 *
 * Indexes back the common dashboard queries:
 *   - by status     (findActive / findByStatus)
 *   - by topic      (findByTopic — operational drill-down)
 *   - by priority   (P1 first — on-call queue)
 *   - by dedup_key  (cooldown check on every emit — hot path)
 *   - by detected_at DESC (recent-first feed)
 *   - by severity   (filter CRITICAL / HIGH first)
 */
const SCHEMA_V4 = `
CREATE TABLE IF NOT EXISTS alerts (
  id                TEXT PRIMARY KEY,
  anomaly_id        TEXT,
  topic             TEXT NOT NULL,
  type              TEXT NOT NULL,
  severity          TEXT NOT NULL,
  priority          TEXT NOT NULL,
  title             TEXT NOT NULL,
  description       TEXT,
  recommended_action TEXT,
  evidence_summary  TEXT,
  confidence        REAL,
  zscore            REAL,
  detected_at       TEXT NOT NULL,
  sent_at           TEXT,
  acknowledged_at   TEXT,
  acknowledged_by   TEXT,
  resolved_at       TEXT,
  resolution_note   TEXT,
  status            TEXT NOT NULL DEFAULT 'DETECTED',
  dedup_key         TEXT NOT NULL,
  cooldown_until    TEXT,
  related_investigation_id TEXT,
  metadata_json     TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
CREATE INDEX IF NOT EXISTS idx_alerts_topic ON alerts(topic);
CREATE INDEX IF NOT EXISTS idx_alerts_priority ON alerts(priority);
CREATE INDEX IF NOT EXISTS idx_alerts_dedup ON alerts(dedup_key);
CREATE INDEX IF NOT EXISTS idx_alerts_detected ON alerts(detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(severity);
`;

/**
 * SCHEMA_V5 — Execution Traces + Feedback (Task IMP-5, spec §28, §30).
 *
 * Two new tables back AUDIT-C's MISSING findings for §28 (Feedback) and §30
 * (Execution Trace — PARTIAL). The columns added on existing tables
 * (signals.observed_at, signals.entity, signals.unit, signals.evidence_ids_json,
 * evidence.extracted_fact, evidence.provenance, evidence.verification_status,
 * trends.direction, investigations.execution_id) cover AUDIT-A §5/§7/§8/§17 P0s.
 *
 * Those column additions are NOT done here — they need `ALTER TABLE ADD COLUMN`
 * which SQLite does not support idempotently. They are applied by
 * `applyV5ColumnExtensions` below (which uses `PRAGMA table_info` to be
 * idempotent).
 */
const SCHEMA_V5 = `
CREATE TABLE IF NOT EXISTS execution_traces (
  id                        TEXT PRIMARY KEY,
  agent_id                  TEXT NOT NULL,
  task                      TEXT NOT NULL,
  start_time                TEXT NOT NULL,
  end_time                  TEXT,
  duration_ms               INTEGER,
  status                    TEXT NOT NULL DEFAULT 'running',
  inputs_json               TEXT,
  outputs_json              TEXT,
  tools_used_json           TEXT,
  skills_used_json          TEXT,
  errors_json               TEXT,
  evidence_ids_json         TEXT,
  related_investigation_id  TEXT,
  related_alert_ids_json    TEXT,
  parent_execution_id       TEXT,
  metadata_json             TEXT
);
CREATE INDEX IF NOT EXISTS idx_exec_traces_task          ON execution_traces(task);
CREATE INDEX IF NOT EXISTS idx_exec_traces_status        ON execution_traces(status);
CREATE INDEX IF NOT EXISTS idx_exec_traces_investigation ON execution_traces(related_investigation_id);
CREATE INDEX IF NOT EXISTS idx_exec_traces_start         ON execution_traces(start_time DESC);

CREATE TABLE IF NOT EXISTS feedback (
  id             TEXT PRIMARY KEY,
  type           TEXT NOT NULL,
  target_type    TEXT NOT NULL,
  target_id      TEXT NOT NULL,
  user_id        TEXT,
  note           TEXT,
  created_at     TEXT NOT NULL,
  metadata_json  TEXT
);
CREATE INDEX IF NOT EXISTS idx_feedback_target  ON feedback(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_feedback_type    ON feedback(type);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at DESC);
`;

/**
 * Add a column to a table if it does not already exist. SQLite does not
 * support `ALTER TABLE … ADD COLUMN IF NOT EXISTS` so we have to introspect
 * `pragma_table_info` first. This is safe to call repeatedly on the same
 * DB instance — every call after the first is a no-op.
 */
function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}

/**
 * V5 column additions to existing tables (idempotent — uses
 * `addColumnIfMissing` so older DB files gain the new columns on the next
 * CLI run without needing a separate migration script).
 *
 * - §5: Signal — observed_at, entity, unit, evidence_ids_json
 * - §8: Evidence — extracted_fact, provenance, verification_status
 * - §17: Trend — direction
 * - §30: Investigation — execution_id (back-ref to execution_traces.id)
 */
function applyV5ColumnExtensions(db: DB): void {
  // §5 — Signal: observed_at, entity, unit, evidence_ids_json
  addColumnIfMissing(db, 'signals', 'observed_at', 'TEXT');
  addColumnIfMissing(db, 'signals', 'entity', 'TEXT');
  addColumnIfMissing(db, 'signals', 'unit', 'TEXT');
  addColumnIfMissing(db, 'signals', 'evidence_ids_json', 'TEXT');

  // §8 — Evidence: extracted_fact, provenance, verification_status
  addColumnIfMissing(db, 'evidence', 'extracted_fact', 'TEXT');
  addColumnIfMissing(db, 'evidence', 'provenance', 'TEXT');
  addColumnIfMissing(db, 'evidence', 'verification_status', "TEXT DEFAULT 'unverified'");

  // §17 — Trend: direction
  addColumnIfMissing(db, 'trends', 'direction', "TEXT DEFAULT 'flat'");

  // §30 — Investigation: execution_id (back-ref to execution_traces.id)
  addColumnIfMissing(db, 'investigations', 'execution_id', 'TEXT');
}

export class ChismosoDB {
  private db: DB;

  constructor(config: DBConfig) {
    if (config.path !== ':memory:') {
      mkdirSync(dirname(config.path), { recursive: true });
    }
    this.db = new Database(config.path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA_V1);
    this.db.exec(SCHEMA_V2);
    this.db.exec(SCHEMA_V3);
    this.db.exec(SCHEMA_V4);
    this.db.exec(SCHEMA_V5);
    applyV5ColumnExtensions(this.db);
    this.db.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)').run('version', '1.0');
    logger.info('ChismosoDB initialized', { path: config.path });
    openDbs.add(this);
  }

  prepare(sql: string): import('better-sqlite3').Statement {
    return this.db.prepare(sql);
  }

  /**
   * Wraps better-sqlite3's transaction() which returns a callable
   * that runs the function inside a transaction.
   */
  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T {
    return this.db.transaction(fn);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // ignore close errors during process teardown
    }
    openDbs.delete(this);
  }

  get raw(): DB {
    return this.db;
  }
}

// Workaround: better-sqlite3's native Statement destructor can segfault at
// process exit if Node's environment has already been torn down. We register
// an exit handler that closes any pending DB handles gracefully.
const openDbs = new Set<ChismosoDB>();
process.on('beforeExit', () => {
  for (const dbInstance of openDbs) {
    try { dbInstance.close(); } catch { /* ignore */ }
  }
  openDbs.clear();
});
