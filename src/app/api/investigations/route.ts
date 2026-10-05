import { NextResponse } from 'next/server';
import { spawn } from 'node:child_process';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CHISMOSO_ROOT = '/home/z/my-project/chismoso';

interface InvestigationSummary {
  id: string;
  query: string;
  scope: string;
  startedAt: string;
  completedAt?: string;
  status: string;
  signalsFound: number;
  evidenceFound: number;
  trendsFound: number;
  problemsFound: number;
  opportunitiesFound: number;
  durationMs?: number;
}

/**
 * GET /api/investigations
 *
 * Returns a list of past investigations from the SQLite database.
 * Spawns `chismoso history` CLI and parses output. Also scans the
 * download directory for saved reports.
 */
export async function GET() {
  // Strategy: read all reports saved on disk in /home/z/my-project/download/chismoso/
  // Each pair (report-*.md + report-*.json) corresponds to one investigation.
  // The JSON contains the full machine report which we summarize.
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  const OUTPUT_DIR = '/home/z/my-project/download/chismoso';
  let files: string[] = [];
  try {
    files = await fs.readdir(OUTPUT_DIR);
  } catch {
    return NextResponse.json({ investigations: [] });
  }

  const jsonFiles = files.filter((f) => f.startsWith('report-') && f.endsWith('.json'));
  const investigations: InvestigationSummary[] = [];

  for (const f of jsonFiles) {
    try {
      const raw = await fs.readFile(path.join(OUTPUT_DIR, f), 'utf8');
      const m = JSON.parse(raw);
      investigations.push({
        id: m.investigationId ?? f.replace('report-', '').replace('.json', ''),
        query: m.query ?? '',
        scope: m.scope ?? 'global',
        startedAt: m.generatedAt ?? '',
        status: 'COMPLETED',
        signalsFound: m.signals?.length ?? 0,
        evidenceFound: m.evidence?.length ?? 0,
        trendsFound: m.trends?.length ?? 0,
        problemsFound: m.problems?.length ?? 0,
        opportunitiesFound: m.opportunities?.length ?? 0,
      });
    } catch {
      /* skip malformed file */
    }
  }

  // Sort by generatedAt desc (most recent first).
  investigations.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));

  return NextResponse.json({ investigations });
}
