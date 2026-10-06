import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { apiBadRequest, apiOk, apiServerError } from '@/lib/api-response';
import { authedPOST } from '@/lib/middleware';
// Silence chismoso's structured logger in this process — otherwise every
// SkillRepository call logs an INFO line, polluting stdout (which would
// interleave with our JSON responses on the wire).
// Path is relative to this file: src/app/api/skills/route.ts
//   → ../../../../chismoso/dist/logger.js
import { logger as chismosoLogger, LogLevel } from '../../../../chismoso/dist/logger.js';
import { SkillsCatalog, SkillStatus } from '../../../../chismoso/dist/skills/index.js';
import type { ChismosoDB } from '../../../../chismoso/dist/db.js';

chismosoLogger.setLevel(LogLevel.WARN);

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DB_PATH =
  process.env.CHISMOSO_DB_PATH ?? '/home/z/my-project/chismoso/data/chismoso.db';

// ---------------------------------------------------------------------------
// Singleton DB connection (survives HMR, never closed)
// ---------------------------------------------------------------------------
//
// We open our OWN better-sqlite3 connection to the chismoso DB (separate from
// the readonly reader in src/lib/db-chismoso.ts). Writes go through here.
//
// `ChismosoDB` (the chismoso class) also opens its own connection when used by
// the CLI — both connections coexist fine because better-sqlite3 uses WAL.
//
// The connection's `close()` is overridden to a no-op so route handlers that
// follow the standard `try { db = open(); ... } finally { db.close(); }`
// pattern don't kill the singleton.

mkdirSync(dirname(DB_PATH), { recursive: true });

const globalForSkillsDb = globalThis as unknown as { __skillsDb?: DB };

function createSkillsDb(): DB {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Idempotent — same CREATE TABLE IF NOT EXISTS block as in
  // chismoso/src/db.ts (SCHEMA_V1). Necessary because the chismoso CLI may
  // not have run yet when the Next.js process cold-starts. The tables are
  // re-created here (in our own connection) so the API works even on a
  // fresh install with no chismoso data.
  db.exec(`
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
  `);

  // Override `close` on the instance so route handlers that call
  // `db.close()` in a finally block don't kill the singleton.
  (db as unknown as { close: () => void }).close = () => {
    /* no-op — singleton lives for the process lifetime */
  };
  return db;
}

const skillsDbSingleton: DB =
  globalForSkillsDb.__skillsDb ?? createSkillsDb();

if (process.env.NODE_ENV !== 'production') {
  globalForSkillsDb.__skillsDb = skillsDbSingleton;
}

/**
 * Return the shared skills DB connection (singleton). The returned object's
 * `close()` method is a no-op, so callers that follow the standard
 * `try { db = openSkillsDb(); ... } finally { db.close(); }` pattern will
 * NOT close the shared connection.
 */
export function openSkillsDb(): DB {
  return skillsDbSingleton;
}

/**
 * Build a SkillsCatalog bound to the singleton DB. The catalog is cheap to
 * construct (no I/O on init) — we instantiate one per request so the
 * SkillsCatalog instance never leaks across requests (defensive: future
 * instance state should not bleed between callers).
 */
function getCatalog(): SkillsCatalog {
  // The SkillsCatalog constructor signature is `(db: ChismosoDB)`. Our
  // singleton is a `better-sqlite3` Database, not a ChismosoDB — but the
  // repository only uses `db.prepare(...)` and `db.transaction(...)`, which
  // better-sqlite3 supports natively. The cast is safe because ChismosoDB
  // delegates both methods to its underlying better-sqlite3 handle.
  const dbAsChismoso = skillsDbSingleton as unknown as ChismosoDB;
  return new SkillsCatalog(dbAsChismoso);
}

// ---------------------------------------------------------------------------
// ROUTE HANDLERS
// ---------------------------------------------------------------------------

/**
 * GET /api/skills
 *
 * Returns the list of skills. Optional filters:
 *   ?status=ACTIVE   Filter by lifecycle status (PROPOSED / VALIDATING /
 *                   ACTIVE / DEPRECATED / RETIRED).
 *   ?origin=builtin Filter by origin (builtin / learned / imported).
 *
 * Response shape:
 *   {
 *     count: number,
 *     filter: { status?, origin? },
 *     skills: Skill[]  // full skill objects (NOT summaries — the API is
 *                     // consumed by dashboards that need the procedure
 *                     // and pitfalls fields)
 *   }
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status');
  const origin = searchParams.get('origin');

  const filter: { status?: SkillStatus; origin?: string } = {};
  if (status) {
    const upper = status.toUpperCase();
    const valid = Object.values(SkillStatus).includes(upper as SkillStatus);
    if (!valid) {
      return apiBadRequest(`Invalid status: ${status}`, {
        valid: Object.values(SkillStatus),
      });
    }
    filter.status = upper as SkillStatus;
  }
  if (origin) filter.origin = origin;

  let db: DB | null = null;
  try {
    db = openSkillsDb();
    const catalog = getCatalog();
    const skills = catalog.list(filter);
    return apiOk({ count: skills.length, filter, skills });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('skills_list_failed', { message });
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}

/**
 * POST /api/skills
 *
 * Propose a new skill (lifecycle entry point). The skill is inserted in
 * PROPOSED status — it CANNOT be invoked until the operator advances it
 * via PROPOSED -> VALIDATING -> ACTIVE (POST /api/skills/[id]/invoke is
 * refused on non-ACTIVE skills).
 *
 * Required body fields:
 *   identity        string  unique slug, e.g. "restaurant_trend_detection"
 *   purpose         string  what it does (1 sentence)
 *
 * Optional body fields (defaults shown):
 *   trigger           string   ''
 *   prerequisites     string[] []
 *   procedure         string   ''
 *   tools_required    string[] []
 *   expected_result   string   ''
 *   verification      string   ''
 *   pitfalls          string[] []
 *   evidence          string   ''
 *   version           string   '1.0.0'
 *   confidence        number   0.5  (0..1)
 *   origin            string   'learned'  (builtins are 'builtin', imported
 *                                            are 'imported')
 *   regression_tests  string   null
 *
 * Response shape (201 Created):
 *   { skill: Skill }
 *
 * Errors:
 *   400  Missing identity or purpose / Invalid field types
 *   409  identity already exists (DuplicateIdentityError)
 *   500  Unexpected DB error
 *
 * §34 / audit C2 — Protected by `authedPOST`: when `CHISMOSO_AUTH_ENABLED=true`,
 * requests must carry a valid `X-Chismoso-Agent` header. Skill creation is a
 * write operation that mutates the catalog — anonymous callers must not be
 * able to pollute the skills table.
 */
export const POST = authedPOST(async (req: NextRequest) => {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return apiBadRequest('Invalid JSON body', { code: 'invalid_json' });
  }

  const identity = typeof body.identity === 'string' ? body.identity.trim() : '';
  const purpose = typeof body.purpose === 'string' ? body.purpose.trim() : '';
  if (!identity || !purpose) {
    return apiBadRequest('Fields "identity" and "purpose" are required', {
      identity: identity || null,
      purpose: purpose || null,
    });
  }

  const origin =
    typeof body.origin === 'string' &&
    ['builtin', 'learned', 'imported'].includes(body.origin)
      ? body.origin
      : 'learned';

  const confidence =
    typeof body.confidence === 'number' && Number.isFinite(body.confidence)
      ? Math.max(0, Math.min(1, body.confidence))
      : 0.5;

  const prereqs = Array.isArray(body.prerequisites)
    ? body.prerequisites.filter((x): x is string => typeof x === 'string')
    : [];
  const tools = Array.isArray(body.tools_required)
    ? body.tools_required.filter((x): x is string => typeof x === 'string')
    : [];
  const pitfalls = Array.isArray(body.pitfalls)
    ? body.pitfalls.filter((x): x is string => typeof x === 'string')
    : [];

  let db: DB | null = null;
  try {
    db = openSkillsDb();
    const catalog = getCatalog();
    const skill = catalog.propose({
      identity,
      purpose,
      trigger: typeof body.trigger === 'string' ? body.trigger : '',
      prerequisites: prereqs,
      procedure: typeof body.procedure === 'string' ? body.procedure : '',
      tools_required: tools,
      expected_result:
        typeof body.expected_result === 'string' ? body.expected_result : '',
      verification:
        typeof body.verification === 'string' ? body.verification : '',
      pitfalls,
      evidence: typeof body.evidence === 'string' ? body.evidence : '',
      version: typeof body.version === 'string' ? body.version : '1.0.0',
      confidence,
      origin: origin as 'builtin' | 'learned' | 'imported',
      last_validated: null,
      regression_tests:
        typeof body.regression_tests === 'string' ? body.regression_tests : null,
      status: SkillStatus.PROPOSED,
    });
    return apiOk({ skill }, 201);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes('identity already exists')) {
      return apiBadRequest(`Skill identity already exists: ${identity}`, {
        code: 'duplicate_identity',
        identity,
      });
    }
    return apiServerError('skills_create_failed', { message });
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
});
