/**
 * GET /api/health — lightweight liveness probe (Task IMP-3, spec §32).
 *
 * This is the simplest possible health check: it does NOT spawn the chismoso
 * CLI or run the 14-subsystem doctor scan. It just confirms:
 *   1. The Next.js process is up and accepting requests.
 *   2. The chismoso SQLite DB is readable (a single `SELECT 1` against the
 *      singleton readonly connection — if this fails, the dashboard cannot
 *      serve any of its data routes either).
 *
 * For a DEEP health check that audits every subsystem, use GET /api/doctor.
 *
 * Response shape:
 *   {
 *     status: 'ok' | 'degraded' | 'fail',
 *     version: '1.5.0',
 *     timestamp: '<ISO>',
 *     db: 'reachable' | 'error: <msg>'
 *   }
 *
 * Status semantics:
 *   ok       — process is up, DB is readable.
 *   degraded — process is up, DB read failed (dashboard data routes will 500).
 *   fail     — never returned (we always 200 with status='degraded' on DB
 *              errors; a true "fail" means the process is down and the
 *              load balancer / LB health check will get a connection refused).
 *
 * Caching: none. The probe is <1ms when the DB is healthy (it's a singleton
 * prepared-statement cache hit). A 5-min cache like /api/providers uses
 * would defeat the purpose of a liveness probe.
 */

import { chismosoDb } from '@/lib/db-chismoso';
import { apiOk } from '@/lib/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CHISMOSO_VERSION = '1.5.0';

export async function GET() {
  let dbStatus: 'reachable' | `error: ${string}` = 'reachable';
  try {
    // SELECT 1 is the canonical liveness probe — it forces SQLite to
    // touch the file header without running a real query. Cheap.
    const row = chismosoDb.prepare('SELECT 1 AS one').get() as { one: number } | undefined;
    if (!row || row.one !== 1) {
      dbStatus = 'error: SELECT 1 returned unexpected result';
    }
  } catch (e: unknown) {
    dbStatus = `error: ${e instanceof Error ? e.message : String(e)}`;
  }

  const status = dbStatus === 'reachable' ? 'ok' as const : 'degraded' as const;
  return apiOk({
    status,
    version: CHISMOSO_VERSION,
    timestamp: new Date().toISOString(),
    db: dbStatus,
  });
}
