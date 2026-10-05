import { NextResponse } from 'next/server';
import Database from 'better-sqlite3';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DB_PATH = '/home/z/my-project/chismoso/data/chismoso.db';

interface TopicRow {
  canonical: string;
  last_seen: string;
  observation_count: number;
  sources_count: number;
  latest_confidence: number | null;
}

interface TopicListItem {
  canonical: string;
  lastSeen: string;
  observationCount: number;
  sourcesCount: number;
  latestConfidence: number | null;
}

/**
 * GET /api/topics
 *
 * Returns the list of all topics CHISMOSO has observed, with the latest
 * confidence reading from topic_observations (temporal memory layer).
 *
 * Reads the SQLite database directly (readonly) for speed — no orchestrator
 * is spawned. This is the contract consumed by the topics-evolution dashboard.
 *
 * Response shape:
 *   {
 *     topics: [{
 *       canonical: string,
 *       lastSeen: string (ISO),
 *       observationCount: number,
 *       sourcesCount: number,
 *       latestConfidence: number | null
 *     }]
 *   }
 */
export async function GET() {
  let db: Database.Database | null = null;
  try {
    db = new Database(DB_PATH, { readonly: true });
    // We use a correlated subquery to grab the most recent observation per
    // topic — this avoids a JOIN that would multiply rows.
    const rows = db.prepare(`
      SELECT
        t.canonical,
        t.last_seen,
        t.observation_count,
        t.sources_count,
        (
          SELECT confidence
          FROM topic_observations o
          WHERE o.topic = t.canonical
          ORDER BY o.observed_at DESC, o.id DESC
          LIMIT 1
        ) AS latest_confidence
      FROM topics t
      ORDER BY t.last_seen DESC
    `).all() as TopicRow[];

    const topics: TopicListItem[] = rows.map((r) => ({
      canonical: r.canonical,
      lastSeen: r.last_seen,
      observationCount: r.observation_count,
      sourcesCount: r.sources_count,
      latestConfidence: r.latest_confidence,
    }));

    return NextResponse.json({ topics });
  } catch (e: any) {
    return NextResponse.json(
      {
        error: 'topics_query_failed',
        message: e?.message ?? String(e),
        topics: [],
      },
      { status: 500 },
    );
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}
