/**
 * CHISMOSO V1.5 — Append-only audit log (Task IMP-PROD-OBS, P0-5).
 *
 * Records "who did what, when, from where" for compliance + security
 * forensics. Persisted in the `audit_log` table (SCHEMA_V6 in db.ts).
 *
 * Schema
 * ------
 *   id            — `audit_<base36 timestamp><random>`, globally unique
 *   timestamp     — ISO 8601 UTC
 *   actor         — user ID or 'agent:chismoso' for autonomous runs
 *   action        — dotted verb, e.g. 'login.success', 'alert.ack',
 *                   'investigate.start', 'skill.invoke'
 *   target_type   — 'alert' | 'investigation' | 'skill' | 'memory' | …
 *   target_id     — opaque id of the target
 *   ip            — caller IP (from x-forwarded-for / x-real-ip)
 *   user_agent    — caller's User-Agent header
 *   trace_id      — joins with the structured logger's trace_id field
 *   metadata_json — free-form per-action context (limited to ~4KB so
 *                   SQLite TEXT cells don't balloon)
 *
 * Why append-only?
 * ----------------
 * The `append()` method ALWAYS issues an INSERT — there is no update /
 * delete API. A process with write access to the SQLite file can still
 * UPDATE/DELETE (we don't enforce triggers), but the API surface
 * guides users toward append-only semantics. For V2, mirror to S3 +
 * Object Lock for true non-repudiation.
 *
 * Why chismoso-side?
 * ------------------
 * The audit log table lives in the same SQLite file as investigations,
 * signals, alerts, etc. This means:
 *   - Single backup of chismoso.db captures the audit log too.
 *   - The audit log is queryable from the chismoso CLI (`chismoso
 *     audit-log list`) AND from the Next.js /api/audit-log route.
 *   - The AuditLog class is a thin wrapper over ChismosoDB; no extra
 *     connection pool, no extra ORM.
 *
 * The Next.js /api/audit-log route uses `chismosoWritableDb` (the
 * singleton writer) to query rows — see src/app/api/audit-log/route.ts.
 */

import type { ChismosoDB } from './db.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface AuditEntry {
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
}

export interface AuditQueryFilter {
  actor?: string;
  action?: string;
  /** ISO timestamp — returns entries with timestamp >= since. */
  since?: string;
  /** Defaults to 100. Capped at 1000 to prevent unbounded scans. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

const METADATA_MAX_BYTES = 4096;
const QUERY_DEFAULT_LIMIT = 100;
const QUERY_MAX_LIMIT = 1000;

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function generateAuditId(): string {
  // time-based prefix + random suffix — sortable by id alone if needed.
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `audit_${ts}${rand}`;
}

function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (json.length > METADATA_MAX_BYTES) {
      // Truncate rather than reject — better to record SOMETHING than
      // to lose the audit row entirely.
      return JSON.stringify({
        truncated: true,
        note: `metadata exceeded ${METADATA_MAX_BYTES} bytes`,
        preview: json.slice(0, METADATA_MAX_BYTES - 200),
      });
    }
    return json;
  } catch {
    return JSON.stringify({ serialization_error: true });
  }
}

function parseRow(row: Record<string, unknown>): AuditEntry {
  const out: AuditEntry = {
    id: row.id as string,
    timestamp: row.timestamp as string,
    actor: row.actor as string,
    action: row.action as string,
  };
  if (row.target_type != null) out.target_type = row.target_type as string;
  if (row.target_id != null) out.target_id = row.target_id as string;
  if (row.ip != null) out.ip = row.ip as string;
  if (row.user_agent != null) out.user_agent = row.user_agent as string;
  if (row.trace_id != null) out.trace_id = row.trace_id as string;
  if (typeof row.metadata_json === 'string' && row.metadata_json.length > 0) {
    try {
      out.metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    } catch {
      // Leave metadata undefined if the JSON is malformed (it shouldn't
      // be — we wrote it ourselves — but defensive parsing anyway).
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// AuditLog CLASS
// ---------------------------------------------------------------------------

export class AuditLog {
  constructor(private readonly db: ChismosoDB) {}

  /**
   * Append a new audit entry. ALWAYS issues an INSERT — never updates.
   * Returns the persisted entry (with id + timestamp filled in).
   *
   * Failures are LOGGED but NOT thrown — audit log writes should never
   * block the user's request (a 500 from the audit table shouldn't
   * break a successful /api/alerts/[id]/ack). The caller can check
   * the return value: if it's null, the write failed.
   */
  append(entry: Omit<AuditEntry, 'id' | 'timestamp'>): AuditEntry | null {
    const id = generateAuditId();
    const timestamp = new Date().toISOString();
    const metadataJson = entry.metadata
      ? safeStringify(entry.metadata)
      : null;

    try {
      this.db
        .prepare(
          `INSERT INTO audit_log
             (id, timestamp, actor, action, target_type, target_id,
              ip, user_agent, trace_id, metadata_json)
           VALUES (@id, @timestamp, @actor, @action, @target_type,
                   @target_id, @ip, @user_agent, @trace_id, @metadata_json)`,
        )
        .run({
          id,
          timestamp,
          actor: entry.actor,
          action: entry.action,
          target_type: entry.target_type ?? null,
          target_id: entry.target_id ?? null,
          ip: entry.ip ?? null,
          user_agent: entry.user_agent ?? null,
          trace_id: entry.trace_id ?? null,
          metadata_json: metadataJson,
        });
      return {
        id,
        timestamp,
        actor: entry.actor,
        action: entry.action,
        target_type: entry.target_type,
        target_id: entry.target_id,
        ip: entry.ip,
        user_agent: entry.user_agent,
        trace_id: entry.trace_id,
        metadata: entry.metadata,
      };
    } catch (e: unknown) {
      // Log to stderr — audit failure is a security signal.
      logger.error('audit_log_append_failed', {
        action: entry.action,
        actor: entry.actor,
        target_type: entry.target_type,
        target_id: entry.target_id,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  /**
   * Query the audit log. Filters are AND-combined. Results are sorted
   * by timestamp DESC (most recent first).
   *
   * The query uses parameterized SQL — actor + action + since are
   * interpolated into a prepared statement, never string-concatenated
   * (so SQL injection is impossible even if a caller passes a
   * malicious actor name).
   */
  query(filter: AuditQueryFilter = {}): AuditEntry[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filter.actor) {
      conditions.push('actor = @actor');
      params.actor = filter.actor;
    }
    if (filter.action) {
      // Action prefix match — 'alert' matches 'alert.ack',
      // 'alert.resolve', etc. Lets the operator filter by category.
      conditions.push("action LIKE @action || '.%'");
      params.action = filter.action.replace(/[%_]/g, '\\$&');
    }
    if (filter.since) {
      conditions.push('timestamp >= @since');
      params.since = filter.since;
    }

    const limit = Math.min(
      Math.max(1, filter.limit ?? QUERY_DEFAULT_LIMIT),
      QUERY_MAX_LIMIT,
    );

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM audit_log ${where}
                 ORDER BY timestamp DESC LIMIT ${limit}`;

    try {
      const rows = this.db.prepare(sql).all(params) as Record<
        string,
        unknown
      >[];
      return rows.map(parseRow);
    } catch (e: unknown) {
      // Table might not exist yet on a fresh DB (chismoso CLI hadn't
      // been run). Log + return empty rather than throwing.
      logger.warn('audit_log_query_failed', {
        filter,
        error: e instanceof Error ? e.message : String(e),
      });
      return [];
    }
  }

  /**
   * Counts entries matching the given filter. Used by /api/audit-log
   * to report total count alongside the paginated list.
   */
  count(filter: AuditQueryFilter = {}): number {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filter.actor) {
      conditions.push('actor = @actor');
      params.actor = filter.actor;
    }
    if (filter.action) {
      conditions.push("action LIKE @action || '.%'");
      params.action = filter.action.replace(/[%_]/g, '\\$&');
    }
    if (filter.since) {
      conditions.push('timestamp >= @since');
      params.since = filter.since;
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT COUNT(*) AS c FROM audit_log ${where}`;

    try {
      const row = this.db.prepare(sql).get(params) as
        | { c: number }
        | undefined;
      return row?.c ?? 0;
    } catch {
      return 0;
    }
  }
}
