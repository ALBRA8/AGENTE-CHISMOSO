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

import { chismosoWritableDb } from './db-chismoso-writable';
import { getCurrentTraceId } from './trace-id';

// Dynamic imports — chismoso/dist is compiled separately and may not
// exist at type-check time. These are loaded lazily on first use.
type AuditEntry = {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  target_type?: string;
  target_id?: string;
  ip?: string;
  user_agent?: string;
  trace_id?: string;
  metadata?: Record<string, unknown>;
};
type AuditQueryFilter = {
  actor?: string;
  action?: string;
  since?: string;
  limit?: number;
};

// Lazy-init: instantiate the AuditLog once on first use.
let auditLogInstance: any = null;

async function getAuditLog(): Promise<any> {
  if (!auditLogInstance) {
    try {
      const { AuditLog } = await import('../../chismoso/dist/audit-log.js' as any);
      auditLogInstance = new AuditLog(chismosoWritableDb);
    } catch {
      return null;
    }
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
export async function appendAudit(
  entry: Omit<AuditEntry, 'id' | 'timestamp' | 'trace_id'> & {
    trace_id?: string;
  },
): Promise<AuditEntry | null> {
  // Auto-fill the trace ID from AsyncLocalStorage if the caller
  // didn't pass one explicitly.
  const traceId = entry.trace_id ?? getCurrentTraceId();
  const enriched: Omit<AuditEntry, 'id' | 'timestamp'> = {
    ...entry,
    trace_id: traceId,
  };
  const al = await getAuditLog(); return al?.append(enriched) ?? null;
}

/**
 * Queries the audit log. See chismoso/src/audit-log.ts AuditLog.query
 * for filter semantics.
 */
export async function queryAudit(filter: AuditQueryFilter = {}): Promise<AuditEntry[]> {
  const al = await getAuditLog(); return al?.query(filter) ?? [];
}

/**
 * Counts entries matching the filter. Used by /api/audit-log to report
 * total count alongside the paginated list.
 */
export async function countAudit(filter: AuditQueryFilter = {}): Promise<number> {
  const al = await getAuditLog(); return al?.count(filter) ?? 0;
}

export type { AuditEntry, AuditQueryFilter };
