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
`;

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
  for (const db of openDbs) {
    try { db.db.close(); } catch { /* ignore */ }
  }
  openDbs.clear();
});
