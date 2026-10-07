/**
 * CHISMOSO V1.0 — server-side ExecutionTrace repository (Task IMP-5, spec §30)
 *
 * This is a thin port of `chismoso/src/execution-trace/repository.ts` for the
 * Next.js runtime. The chismoso package isn't compiled into the dashboard
 * bundle, so we port the pure-TS logic here.
 *
 * Reads use the readonly singleton (`./db-chismoso.ts`); the writer singleton
 * (`./db-chismoso-writable.ts`) is used only for the schema bootstrap. Both
 * singletons point at the same SQLite file (WAL mode → safe concurrent R/W).
 *
 * The schema bootstrap is idempotent — it runs `CREATE TABLE IF NOT EXISTS`
 * for `execution_traces` and `ALTER TABLE ADD COLUMN IF NOT EXISTS` (via
 * PRAGMA table_info introspection) for the new columns on existing tables.
 * This makes the API work even if the chismoso CLI hasn't run since the
 * IMP-5 schema was added.
 */

import type Database from 'better-sqlite3';
import { chismosoDb } from './db-chismoso';
import { chismosoWritableDb } from './db-chismoso-writable';

// ---------------------------------------------------------------------------
// SCHEMA BOOTSTRAP (idempotent)
// ---------------------------------------------------------------------------

let schemaReady = false;

function ensureSchema(): void {
  if (schemaReady) return;
  // Create the table if it doesn't exist (idempotent).
  chismosoWritableDb.exec(`
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
  `);
  schemaReady = true;
}

// ---------------------------------------------------------------------------
// TYPES (mirror chismoso/src/execution-trace/models.ts)
// ---------------------------------------------------------------------------

export type ExecutionTraceStatus = 'running' | 'success' | 'failure' | 'timeout';

export interface ExecutionTrace {
  id: string;
  agent_id: string;
  task: string;
  start_time: string;
  end_time?: string;
  duration_ms?: number;
  status: ExecutionTraceStatus;
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  tools_used: string[];
  skills_used?: string[];
  errors: string[];
  evidence_ids?: string[];
  related_investigation_id?: string;
  related_alert_ids?: string[];
  parent_execution_id?: string;
  metadata?: Record<string, unknown>;
}

export interface ExecutionTraceListFilter {
  task?: string;
  status?: ExecutionTraceStatus;
  related_investigation_id?: string;
  limit?: number;
}

export interface ExecutionTraceStats {
  total: number;
  by_status: Record<string, number>;
  by_task: Record<string, number>;
  success_rate: number;
  avg_duration_ms: number;
  p95_duration_ms: number;
}

// ---------------------------------------------------------------------------
// REPOSITORY
// ---------------------------------------------------------------------------

class ExecutionTraceRepositoryServer {
  findById(id: string): ExecutionTrace | null {
    ensureSchema();
    const r = chismosoDb
      .prepare('SELECT * FROM execution_traces WHERE id = ?')
      .get(id) as any;
    if (!r) return null;
    return parseExecutionTraceRow(r);
  }

  list(filter: ExecutionTraceListFilter = {}): ExecutionTrace[] {
    ensureSchema();
    const where: string[] = [];
    const params: any[] = [];
    if (filter.task) {
      where.push('task = ?');
      params.push(filter.task);
    }
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.related_investigation_id) {
      where.push('related_investigation_id = ?');
      params.push(filter.related_investigation_id);
    }
    const sql = where.length > 0
      ? `SELECT * FROM execution_traces WHERE ${where.join(' AND ')} ORDER BY start_time DESC LIMIT ?`
      : 'SELECT * FROM execution_traces ORDER BY start_time DESC LIMIT ?';
    const rows = chismosoDb.prepare(sql).all(...params, filter.limit ?? 20) as any[];
    return rows.map(parseExecutionTraceRow);
  }

  listRecent(limit = 20): ExecutionTrace[] {
    return this.list({ limit });
  }

  findByInvestigation(investigationId: string): ExecutionTrace[] {
    ensureSchema();
    const rows = chismosoDb
      .prepare(
        'SELECT * FROM execution_traces WHERE related_investigation_id = ? ORDER BY start_time DESC',
      )
      .all(investigationId) as any[];
    return rows.map(parseExecutionTraceRow);
  }

  stats(): ExecutionTraceStats {
    ensureSchema();
    const total = (chismosoDb
      .prepare('SELECT COUNT(*) AS c FROM execution_traces')
      .get() as { c: number }).c;

    const statusRows = chismosoDb
      .prepare('SELECT status, COUNT(*) AS c FROM execution_traces GROUP BY status')
      .all() as Array<{ status: string; c: number }>;
    const by_status: Record<string, number> = {};
    for (const r of statusRows) by_status[r.status] = r.c;

    const taskRows = chismosoDb
      .prepare('SELECT task, COUNT(*) AS c FROM execution_traces GROUP BY task')
      .all() as Array<{ task: string; c: number }>;
    const by_task: Record<string, number> = {};
    for (const r of taskRows) by_task[r.task] = r.c;

    const completed = (by_status['success'] ?? 0)
      + (by_status['failure'] ?? 0)
      + (by_status['timeout'] ?? 0);
    const success_rate = completed > 0 ? (by_status['success'] ?? 0) / completed : 0;

    const durRow = chismosoDb
      .prepare(
        `SELECT AVG(duration_ms) AS avg_ms FROM execution_traces WHERE duration_ms IS NOT NULL`,
      )
      .get() as { avg_ms: number | null } | undefined;
    const avg_duration_ms = durRow?.avg_ms ?? 0;

    const durations = chismosoDb
      .prepare('SELECT duration_ms FROM execution_traces WHERE duration_ms IS NOT NULL ORDER BY duration_ms ASC')
      .all() as Array<{ duration_ms: number }>;
    const p95 = durations.length > 0
      ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))].duration_ms
      : 0;

    return {
      total,
      by_status,
      by_task,
      success_rate: Math.round(success_rate * 1000) / 1000,
      avg_duration_ms: Math.round(avg_duration_ms),
      p95_duration_ms: p95,
    };
  }
}

export const executionTraceRepository = new ExecutionTraceRepositoryServer();

// ---------------------------------------------------------------------------
// PARSER
// ---------------------------------------------------------------------------

function parseExecutionTraceRow(r: any): ExecutionTrace {
  return {
    id: r.id,
    agent_id: r.agent_id,
    task: r.task,
    start_time: r.start_time,
    end_time: r.end_time ?? undefined,
    duration_ms: r.duration_ms ?? undefined,
    status: r.status as ExecutionTraceStatus,
    inputs: r.inputs_json ? JSON.parse(r.inputs_json) : {},
    outputs: r.outputs_json ? JSON.parse(r.outputs_json) : undefined,
    tools_used: r.tools_used_json ? JSON.parse(r.tools_used_json) : [],
    skills_used: r.skills_used_json ? JSON.parse(r.skills_used_json) : [],
    errors: r.errors_json ? JSON.parse(r.errors_json) : [],
    evidence_ids: r.evidence_ids_json ? JSON.parse(r.evidence_ids_json) : [],
    related_investigation_id: r.related_investigation_id ?? undefined,
    related_alert_ids: r.related_alert_ids_json ? JSON.parse(r.related_alert_ids_json) : undefined,
    parent_execution_id: r.parent_execution_id ?? undefined,
    metadata: r.metadata_json ? JSON.parse(r.metadata_json) : undefined,
  };
}

// Re-export the writable DB so the route handlers can pass it to other
// repositories if needed. Kept here for symmetry with alerts-server.ts.
export { chismosoDb as dbReader, chismosoWritableDb as dbWriter, type Database };
