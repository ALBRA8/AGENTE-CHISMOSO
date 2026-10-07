/**
 * CHISMOSO V1.0 — Execution Trace models (spec §30, AUDIT-C §30)
 *
 * An ExecutionTrace is a structured audit row representing ONE run of the
 * agent (or one of its tools/skills/MCP calls). It captures:
 *   - who ran it (agent_id)
 *   - what was attempted (task + inputs)
 *   - what was produced (outputs + tools_used + skills_used + evidence_ids)
 *   - what went wrong (errors[])
 *   - when + how long (start_time, end_time, duration_ms)
 *   - the outcome (status: running|success|failure|timeout)
 *
 * The previous implementation relied on `Investigation.errors[]` (which is
 * overloaded as both error log AND iteration log) plus scattered
 * `provider_runs` rows. The ExecutionTrace gives a single, queryable view
 * across all execution shapes — investigation, ReAct loop, MCP call, skill
 * invocation — without overloading `errors[]`.
 *
 * Traces can be nested via `parent_execution_id` (e.g. a skill invoked from
 * inside an investigation creates a child trace with the investigation's
 * execution_id as parent).
 */

/**
 * The agent or sub-system that owns this execution.
 *
 * The default is the CHISMOSO orchestrator itself (`AGENTE-CHISMOSO`),
 * but the same table can hold executions from peer agents in the mesh
 * (e.g. `AGENTE-LEADS`) if they emit traces through the same DB.
 */
export const DEFAULT_AGENT_ID = 'AGENTE-CHISMOSO';

/**
 * Task labels. Free-form string, but we document the canonical values so
 * that `chismoso trace list --task=investigate` is meaningful.
 */
export type ExecutionTraceTask =
  | 'investigate'
  | 'investigate-react'
  | 'mcp_call'
  | 'skill_invoke'
  | 'scheduler_tick'
  | 'anomaly_detect'
  | 'mesh_publish'
  | 'mesh_deliver'
  | 'webhook_deliver'
  | string; // allow custom tasks without code change

export type ExecutionTraceStatus = 'running' | 'success' | 'failure' | 'timeout';

export interface ExecutionTrace {
  /** Unique ID — `exec_<base36 ts><random>` (see generateId in models.ts). */
  id: string;
  /** Who ran this execution. Default: 'AGENTE-CHISMOSO'. */
  agent_id: string;
  /** What was attempted: 'investigate' | 'investigate-react' | 'mcp_call' | ... */
  task: string;
  /** ISO timestamp — when execution started. */
  start_time: string;
  /** ISO timestamp — when execution ended (set by complete()). */
  end_time?: string;
  /** Wall-clock duration in milliseconds (set by complete()). */
  duration_ms?: number;
  /** Lifecycle status: 'running' (live) → 'success' | 'failure' | 'timeout'. */
  status: ExecutionTraceStatus;
  /** Whatever the task was invoked with (objective, query, args, ...). */
  inputs: Record<string, unknown>;
  /** Whatever the task produced (counts, references, ...). */
  outputs?: Record<string, unknown>;
  /** Tool names invoked during this execution (deduplicated, order preserved). */
  tools_used: string[];
  /** Skill identities invoked (optional — most executions don't use skills). */
  skills_used?: string[];
  /** Error messages collected during the run (mirrors Investigation.errors). */
  errors: string[];
  /** IDs of Evidence rows produced/consumed by this execution. */
  evidence_ids?: string[];
  /** Investigation this execution is tied to (if any). */
  related_investigation_id?: string;
  /** Alert IDs emitted or acknowledged during this execution (if any). */
  related_alert_ids?: string[];
  /** Parent execution ID (for nested executions, e.g. skill_invoke inside investigate). */
  parent_execution_id?: string;
  /** Free-form metadata (provider names, geography, budget snapshot, ...). */
  metadata?: Record<string, unknown>;
}

export interface ExecutionTraceListFilter {
  task?: string;
  status?: ExecutionTraceStatus;
  related_investigation_id?: string;
  limit?: number;
}

/**
 * Aggregate stats — used by the CLI's `chismoso trace stats` command (future)
 * and by the /api/trace API for a dashboard card.
 */
export interface ExecutionTraceStats {
  total: number;
  by_status: Record<string, number>;
  by_task: Record<string, number>;
  success_rate: number; // 0..1 — successes / (successes + failures + timeouts)
  avg_duration_ms: number; // mean of completed traces
  p95_duration_ms: number; // 95th percentile of completed traces
}
