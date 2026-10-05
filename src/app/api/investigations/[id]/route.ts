import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const OUTPUT_DIR = '/home/z/my-project/download/chismoso';

/**
 * GET /api/investigations/[id]
 *
 * Returns the full report (markdown + machine JSON) for a specific investigation.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id || !/^[\w-]+$/.test(id)) {
    return NextResponse.json({ error: 'Invalid investigation ID' }, { status: 400 });
  }

  const mdPath = path.join(OUTPUT_DIR, `report-${id}.md`);
  const jsonPath = path.join(OUTPUT_DIR, `report-${id}.json`);

  let markdown = '';
  let machine: any = null;

  try {
    markdown = await readFile(mdPath, 'utf8');
  } catch {
    return NextResponse.json({ error: 'Investigation not found' }, { status: 404 });
  }

  try {
    machine = JSON.parse(await readFile(jsonPath, 'utf8'));
  } catch {
    /* keep markdown only */
  }

  return NextResponse.json({ id, markdown, machine });
}
