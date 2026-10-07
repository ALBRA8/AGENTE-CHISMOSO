/**
 * CHISMOSO V1.0 — Execution Trace barrel (spec §30)
 *
 * Public API for the ExecutionTrace subsystem.
 *
 * Importers:
 *   import {
 *     ExecutionTraceRepository,
 *     DEFAULT_AGENT_ID,
 *     type ExecutionTrace,
 *     type ExecutionTraceStatus,
 *     type ExecutionTraceTask,
 *   } from '../execution-trace/index.js';
 */

export * from './models.js';
export * from './repository.js';
