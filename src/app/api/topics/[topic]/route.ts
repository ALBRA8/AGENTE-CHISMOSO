import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DB_PATH = '/home/z/my-project/chismoso/data/chismoso.db';

interface ObservationRow {
  observed_at: string;
  sources_count: number | null;
  signals_count: number | null;
  evidence_count: number | null;
  confidence: number | null;
  note: string | null;
}

interface TopicHistoryItem {
  observed_at: string;
  sources_count: number;
  signals_count: number;
  evidence_count: number;
  confidence: number | null;
  note: string | null;
}

interface TopicHistoryResponse {
  topic: string;
  history: TopicHistoryItem[];
}

/**
 * GET /api/topics/[topic]
 *
 * Returns the temporal evolution of a single topic — the full history of
 * `topic_observations` rows recorded by the orchestrator after each
 * clustering pass. Used by the `<TopicsEvolution>` chart component.
 *
 * The `topic` URL segment is URL-encoded by the client (e.g.
 * `/api/topics/restaurantes%20Colombia`). We decode it here.
 *
 * Query params:
 *   ?limit=N    Max observations to return (default 30, capped at 200)
 *
 * Response shape:
 *   {
 *     topic: string,
 *     history: [{
 *       observed_at: string (ISO),
 *       sources_count: number,
 *       signals_count: number,
 *       evidence_count: number,
 *       confidence: number | null,
 *       note: string | null
 *     }]
 *   }
 *
 * History is returned in chronological order (oldest first) so the chart
 * component can render the polyline left-to-right without re-sorting.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ topic: string }> },
) {
  const { topic: rawTopic } = await params;
  const topic = decodeURIComponent(rawTopic);
  if (!topic) {
    return NextResponse.json(
      { error: 'missing_topic', message: 'Topic segment is required' },
      { status: 400 },
    );
  }

  const url = new URL(req.url);
  const limitArg = parseInt(url.searchParams.get('limit') ?? '30', 10);
  const limit = Number.isFinite(limitArg) && limitArg > 0
    ? Math.min(limitArg, 200)
    : 30;

  let db: Database.Database | null = null;
  try {
    db = new Database(DB_PATH, { readonly: true });
    // Use parameter binding for the topic — topics come from user-controlled
    // canonical strings, so we must defend against SQL injection even though
    // they are not user-input in the traditional sense.
    const rows = db.prepare(`
      SELECT observed_at, sources_count, signals_count, evidence_count, confidence, note
      FROM topic_observations
      WHERE topic = ?
      ORDER BY observed_at DESC, id DESC
      LIMIT ?
    `).all(topic, limit) as ObservationRow[];

    // Reverse so oldest is first — chronological order for the chart.
    const history: TopicHistoryItem[] = rows.reverse().map((r) => ({
      observed_at: r.observed_at,
      sources_count: r.sources_count ?? 0,
      signals_count: r.signals_count ?? 0,
      evidence_count: r.evidence_count ?? 0,
      confidence: r.confidence,
      note: r.note,
    }));

    const body: TopicHistoryResponse = { topic, history };
    return NextResponse.json(body);
  } catch (e: any) {
    return NextResponse.json(
      {
        error: 'topic_history_query_failed',
        message: e?.message ?? String(e),
        topic,
        history: [],
      },
      { status: 500 },
    );
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}
