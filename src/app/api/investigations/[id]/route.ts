import { NextRequest } from 'next/server';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { apiBadRequest, apiNotFound, apiOk } from '@/lib/api-response';

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
    return apiBadRequest('Invalid investigation ID');
  }

  // Defense-in-depth against path traversal: even though the regex above
  // already excludes '/', '..', etc., belt-and-braces — strip any directory
  // component with basename and then verify the resolved path is still
  // inside OUTPUT_DIR before touching the filesystem.
  const safeId = path.basename(id);
  const mdPath = path.join(OUTPUT_DIR, `report-${safeId}.md`);
  const jsonPath = path.join(OUTPUT_DIR, `report-${safeId}.json`);
  const resolvedMd = path.resolve(mdPath);
  const resolvedJson = path.resolve(jsonPath);
  const resolvedBase = path.resolve(OUTPUT_DIR);
  if (
    !resolvedMd.startsWith(resolvedBase + path.sep) ||
    !resolvedJson.startsWith(resolvedBase + path.sep)
  ) {
    return apiBadRequest('Path traversal detected');
  }

  let markdown = '';
  let machine: any = null;

  try {
    markdown = await readFile(mdPath, 'utf8');
  } catch {
    return apiNotFound('Investigation not found');
  }

  try {
    machine = JSON.parse(await readFile(jsonPath, 'utf8'));
  } catch {
    /* keep markdown only */
  }

  return apiOk({ id, markdown, machine });
}
