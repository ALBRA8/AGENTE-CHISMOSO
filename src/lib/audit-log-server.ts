/**
 * CHISMOSO V1.5 — Next.js-side audit log (Task IMP-PROD-OBS, P0-5).
 *
 * Wraps the chismoso `AuditLog` class with the singleton
 * `chismosoWritableDb` so Next.js route handlers can call
 * `appendAudit(entry)` and `queryAudit(filter)` without each one
 * having to manage the chismoso DB connection lifecycle.
 *
 * The audit_log table is created by `db-chismoso-writable.ts`
 * (SCHEMA_V6) so this works even before the chismoso CLI has been run.
 *
 * Failures from `appendAudit` are swallowed + logged (audit writes
 * must never block the user request) — see chismoso/src/audit-log.ts
 * for the append-failure logging policy.
 *
 * Trace IDs
 * ---------
 * `getCurrentTraceId()` is called inside `appendAudit` so the audit
 * row inherits the trace ID set by middleware (via AsyncLocalStorage).
 * This joins audit rows with structured logs + Sentry events.
 */

import { AuditLog } from '../../chismoso/dist/audit-log.js';
import type { AuditEntry, AuditQueryFilter } from '../../chismoso/dist/audit-log.js';
import type { ChismosoDB } from '../../chismoso/dist/db.js';
import { chismosoWritableDb } from './db-chismoso-writable';
import { getCurrentTraceId } from './trace-id';

// Lazy-init: instantiate the AuditLog once on first use.
let auditLogInstance: AuditLog | null = null;

function getAuditLog(): AuditLog {
  if (!auditLogInstance) {
    auditLogInstance = new AuditLog(
      chismosoWritableDb as unknown as ChismosoDB,
    );
  }
  return auditLogInstance;
}

/**
 * Appends an audit entry. Returns the persisted entry (with id +
 * timestamp filled in), or null on failure.
 *
 * The caller should ALWAYS pass `actor`, `action`, and at least one
 * of `target_type` / `target_id`. The IP, user_agent, and trace_id
 * fields are auto-filled when present in the request context.
 */
export function appendAudit(
  entry: Omit<AuditEntry, 'id' | 'timestamp' | 'trace_id'> & {
    trace_id?: string;
  },
): AuditEntry | null {
  // Auto-fill the trace ID from AsyncLocalStorage if the caller
  // didn't pass one explicitly.
  const traceId = entry.trace_id ?? getCurrentTraceId();
  const enriched: Omit<AuditEntry, 'id' | 'timestamp'> = {
    ...entry,
    trace_id: traceId,
  };
  return getAuditLog().append(enriched);
}

/**
 * Queries the audit log. See chismoso/src/audit-log.ts AuditLog.query
 * for filter semantics.
 */
export function queryAudit(filter: AuditQueryFilter = {}): AuditEntry[] {
  return getAuditLog().query(filter);
}

/**
 * Counts entries matching the filter. Used by /api/audit-log to report
 * total count alongside the paginated list.
 */
export function countAudit(filter: AuditQueryFilter = {}): number {
  return getAuditLog().count(filter);
}

export type { AuditEntry, AuditQueryFilter };
