/**
 * CHISMOSO V1.0 — ExecutionTrace repository (spec §30)
 *
 * Persistence layer for ExecutionTrace rows. Mirrors the other repositories
 * in `chismoso/src/repositories.ts` (same prepared-statement pattern, same
 * JSON-blob convention for arrays).
 *
 * The repository exposes a `start(task, inputs, opts?) → ExecutionTrace` /
 * `complete(id, status, outputs?, errors?) → void` lifecycle so that callers
 * (orchestrator, scheduler, MCP server) can:
 *   1. Open a trace BEFORE doing the work (status='running').
 *   2. Mutate the in-memory `trace.tools_used` array as tools are invoked.
 *   3. Persist the final state at the end (status='success'|'failure'|'timeout').
 *
 * Reads:
 *   - findById(id)                 → single trace
 *   - findByInvestigation(invId)    → all traces linked to an investigation
 *   - findByTask(task, limit)      → "show me my last 20 investigate runs"
 *   - listRecent(limit)            → dashboard feed
 *   - stats()                      → aggregate counters for self-improvement
 */

import type { ChismosoDB } from '../db.js';
import { generateId, nowISO } from '../models.js';
import {
  DEFAULT_AGENT_ID,
  type ExecutionTrace,
  type ExecutionTraceListFilter,
  type ExecutionTraceStats,
  type ExecutionTraceStatus,
} from './models.js';

export class ExecutionTraceRepository {
  constructor(private db: ChismosoDB) {}

  /**
   * Open a new execution trace with status='running'. Returns the in-memory
   * trace so the caller can append to `tools_used` / `errors` / `evidence_ids`
   * as the work progresses. Persist the final state with `complete(id, ...)`.
   *
   * Optional fields accepted via `opts`:
   *   - related_investigation_id
   *   - related_alert_ids
   *   - parent_execution_id
   *   - metadata
   *   - skills_used (rare — usually populated by the skills layer)
   *   - agent_id (default 'AGENTE-CHISMOSO')
   */
  start(
    task: string,
    inputs: Record<string, unknown>,
    opts: Partial<ExecutionTrace> = {},
  ): ExecutionTrace {
    const trace: ExecutionTrace = {
      id: generateId('exec'),
      agent_id: opts.agent_id ?? DEFAULT_AGENT_ID,
      task,
      start_time: nowISO(),
      status: 'running',
      inputs,
      tools_used: [],
      skills_used: opts.skills_used ?? [],
      errors: [],
      evidence_ids: opts.evidence_ids ?? [],
      related_investigation_id: opts.related_investigation_id,
      related_alert_ids: opts.related_alert_ids,
      parent_execution_id: opts.parent_execution_id,
      metadata: opts.metadata,
    };

    this.db.prepare(`
      INSERT INTO execution_traces (
        id, agent_id, task, start_time, status, inputs_json,
        tools_used_json, skills_used_json, errors_json, evidence_ids_json,
        related_investigation_id, related_alert_ids_json,
        parent_execution_id, metadata_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      trace.id,
      trace.agent_id,
      trace.task,
      trace.start_time,
      trace.status,
      JSON.stringify(trace.inputs),
      JSON.stringify(trace.tools_used),
      JSON.stringify(trace.skills_used ?? []),
      JSON.stringify(trace.errors),
      JSON.stringify(trace.evidence_ids ?? []),
      trace.related_investigation_id ?? null,
      trace.related_alert_ids ? JSON.stringify(trace.related_alert_ids) : null,
      trace.parent_execution_id ?? null,
      trace.metadata ? JSON.stringify(trace.metadata) : null,
    );

    return trace;
  }

  /**
   * Persist the final state of a trace.
   *
   * `status` must be 'success' | 'failure' | 'timeout' — never 'running'
   * (use `start()` for the initial running row).
   *
   * `outputs` is optional — e.g. for `failure` it's usually omitted.
   * `errors` is optional — pass [] to clear, omit to leave existing errors
   * untouched. (In practice callers always pass the latest errors array.)
   *
   * The in-memory `trace` object passed to `start()` is NOT mutated by
   * `complete()` — callers should treat it as immutable after `start()`.
   * If they want a fresh copy, they should call `findById(id)`.
   */
  complete(
    id: string,
    status: 'success' | 'failure' | 'timeout',
    outputs?: Record<string, unknown>,
    errors?: string[],
    extra?: {
      tools_used?: string[];
      skills_used?: string[];
      evidence_ids?: string[];
      related_investigation_id?: string;
      related_alert_ids?: string[];
      metadata?: Record<string, unknown>;
    },
  ): void {
    const end_time = nowISO();
    // Compute duration from the persisted start_time (more accurate than
    // trusting the caller's clock).
    const existing = this.db
      .prepare('SELECT start_time FROM execution_traces WHERE id = ?')
      .get(id) as { start_time: string } | undefined;
    const duration_ms = existing
      ? Math.max(0, new Date(end_time).getTime() - new Date(existing.start_time).getTime())
      : undefined;

    this.db.prepare(`
      UPDATE execution_traces SET
        end_time = ?,
        duration_ms = ?,
        status = ?,
        outputs_json = COALESCE(?, outputs_json),
        errors_json = COALESCE(?, errors_json),
        tools_used_json = COALESCE(?, tools_used_json),
        skills_used_json = COALESCE(?, skills_used_json),
        evidence_ids_json = COALESCE(?, evidence_ids_json),
        related_investigation_id = COALESCE(?, related_investigation_id),
        related_alert_ids_json = COALESCE(?, related_alert_ids_json),
        metadata_json = COALESCE(?, metadata_json)
      WHERE id = ?
    `).run(
      end_time,
      duration_ms ?? null,
      status satisfies ExecutionTraceStatus,
      outputs ? JSON.stringify(outputs) : null,
      errors ? JSON.stringify(errors) : null,
      extra?.tools_used ? JSON.stringify(extra.tools_used) : null,
      extra?.skills_used ? JSON.stringify(extra.skills_used) : null,
      extra?.evidence_ids ? JSON.stringify(extra.evidence_ids) : null,
      extra?.related_investigation_id ?? null,
      extra?.related_alert_ids ? JSON.stringify(extra.related_alert_ids) : null,
      extra?.metadata ? JSON.stringify(extra.metadata) : null,
      id,
    );
  }

  /**
   * Append a tool name to this trace's `tools_used` list (in DB + in the
   * in-memory trace returned by `start()` if the caller still holds a
   * reference).
   *
   * Idempotent: if `toolName` is already recorded for this trace, this is a
   * no-op (so callers don't have to dedup themselves — e.g. the orchestrator
   * calls `addTool` once per plan iteration per unique tool, and a 3-iteration
   * run that always uses `search_web` only records it once).
   *
   * Persists immediately so that a crash mid-run still leaves an accurate
   * record of which tools were invoked before the crash.
   */
  addTool(id: string, toolName: string): void {
    const existing = this.db
      .prepare('SELECT tools_used_json FROM execution_traces WHERE id = ?')
      .get(id) as { tools_used_json: string | null } | undefined;
    if (!existing) return;
    const tools: string[] = existing.tools_used_json
      ? JSON.parse(existing.tools_used_json)
      : [];
    if (tools.includes(toolName)) return;
    tools.push(toolName);
    this.db
      .prepare('UPDATE execution_traces SET tools_used_json = ? WHERE id = ?')
      .run(JSON.stringify(tools), id);
  }

  /**
   * Append an error message to this trace's `errors[]` list (in DB). Mirrors
   * `addTool` — used by the orchestrator when a tool call fails mid-run, so
   * that a crash still leaves a complete error record.
   */
  addError(id: string, error: string): void {
    const existing = this.db
      .prepare('SELECT errors_json FROM execution_traces WHERE id = ?')
      .get(id) as { errors_json: string | null } | undefined;
    if (!existing) return;
    const errors: string[] = existing.errors_json ? JSON.parse(existing.errors_json) : [];
    errors.push(error);
    this.db
      .prepare('UPDATE execution_traces SET errors_json = ? WHERE id = ?')
      .run(JSON.stringify(errors), id);
  }

  findById(id: string): ExecutionTrace | null {
    const r = this.db
      .prepare('SELECT * FROM execution_traces WHERE id = ?')
      .get(id) as any;
    if (!r) return null;
    return parseExecutionTraceRow(r);
  }

  findByInvestigation(investigationId: string): ExecutionTrace[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM execution_traces WHERE related_investigation_id = ? ORDER BY start_time DESC',
      )
      .all(investigationId) as any[];
    return rows.map(parseExecutionTraceRow);
  }

  findByTask(task: string, limit = 20): ExecutionTrace[] {
    const rows = this.db
      .prepare('SELECT * FROM execution_traces WHERE task = ? ORDER BY start_time DESC LIMIT ?')
      .all(task, limit) as any[];
    return rows.map(parseExecutionTraceRow);
  }

  list(filter: ExecutionTraceListFilter = {}): ExecutionTrace[] {
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
    const rows = this.db.prepare(sql).all(...params, filter.limit ?? 20) as any[];
    return rows.map(parseExecutionTraceRow);
  }

  listRecent(limit = 20): ExecutionTrace[] {
    return this.list({ limit });
  }

  /**
   * Aggregate counters across all traces. Used by `chismoso trace stats`
   * and the /api/trace stats endpoint.
   *
   * `success_rate` = successes / (successes + failures + timeouts). 'running'
   * traces are excluded from the denominator (they haven't finished yet).
   */
  stats(): ExecutionTraceStats {
    const total = (this.db
      .prepare('SELECT COUNT(*) AS c FROM execution_traces')
      .get() as { c: number }).c;

    const statusRows = this.db
      .prepare('SELECT status, COUNT(*) AS c FROM execution_traces GROUP BY status')
      .all() as Array<{ status: string; c: number }>;
    const by_status: Record<string, number> = {};
    for (const r of statusRows) by_status[r.status] = r.c;

    const taskRows = this.db
      .prepare('SELECT task, COUNT(*) AS c FROM execution_traces GROUP BY task')
      .all() as Array<{ task: string; c: number }>;
    const by_task: Record<string, number> = {};
    for (const r of taskRows) by_task[r.task] = r.c;

    const completed = (by_status['success'] ?? 0)
      + (by_status['failure'] ?? 0)
      + (by_status['timeout'] ?? 0);
    const success_rate = completed > 0 ? (by_status['success'] ?? 0) / completed : 0;

    const durRow = this.db
      .prepare(
        `SELECT
           AVG(duration_ms) AS avg_ms,
           MAX(duration_ms) AS max_ms
         FROM execution_traces
         WHERE duration_ms IS NOT NULL`,
      )
      .get() as { avg_ms: number | null; max_ms: number | null } | undefined;
    const avg_duration_ms = durRow?.avg_ms ?? 0;

    // p95: pull all completed durations, sort, pick the 95th percentile.
    // For small datasets this is trivially fast; for very large ones we'd
    // want a window function but SQLite doesn't support PERCENTILE_CONT.
    const durations = this.db
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
