import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { apiOk, apiServerError } from '@/lib/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Directory where the orchestrator (and the `chismoso` CLI) persists
 * rendered FICHA markdown files. Kept in sync with the constant in
 * `chismoso/src/ficha/renderer.ts` — when this path changes, update both.
 */
const FICHAS_DIR = '/home/z/my-project/download/chismoso/fichas';

interface FichaListItem {
  /** Opportunity ID this FICHA was derived from (extracted from the filename). */
  id: string;
  /** Title pulled from the first `# Ficha:` heading. */
  title: string;
  /** One-liner pulled from the `## 1. En una frase` section. */
  oneLiner: string;
  /** File mtime (ISO). */
  generatedAt: string;
  /** Markdown file size in bytes. */
  sizeBytes: number;
}

/**
 * GET /api/fichas
 *
 * Lists every persisted FICHA file under
 * /home/z/my-project/download/chismoso/fichas/ficha-<opportunity_id>.md
 *
 * For each file we extract just enough metadata for a listing UI:
 *   - the opportunity ID (from the filename)
 *   - the title (from the first "# Ficha:" heading)
 *   - the one-liner (from the "## 1. En una frase" section)
 *   - the file mtime + size
 *
 * Full markdown + parsed FichaSpec is returned by GET /api/fichas/[id].
 *
 * Sorted newest-first by mtime.
 */
export async function GET() {
  let files: string[] = [];
  try {
    files = await readdir(FICHAS_DIR);
  } catch {
    // Directory doesn't exist yet — no fichas have ever been generated.
    return apiOk({ count: 0, fichas: [] });
  }

  const fichaFiles = files.filter((f) => f.startsWith('ficha-') && f.endsWith('.md'));
  const items: FichaListItem[] = [];

  for (const f of fichaFiles) {
    try {
      const fullPath = path.join(FICHAS_DIR, f);
      // Defense-in-depth against path traversal — readdir already lists
      // bare filenames, but we still verify the resolved path stays
      // inside FICHAS_DIR before reading.
      const resolved = path.resolve(fullPath);
      if (!resolved.startsWith(path.resolve(FICHAS_DIR) + path.sep)) {
        continue;
      }
      const st = await stat(fullPath);
      const md = await readFile(fullPath, 'utf8');
      const id = f.replace(/^ficha-/, '').replace(/\.md$/, '');
      items.push({
        id,
        title: extractTitle(md) ?? id,
        oneLiner: extractSection(md, '## 1. En una frase') ?? '',
        generatedAt: st.mtime.toISOString(),
        sizeBytes: st.size,
      });
    } catch {
      /* skip unreadable file */
    }
  }

  items.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));

  try {
    return apiOk({ count: items.length, fichas: items });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('fichas_list_failed', { message });
  }
}

// ---------------------------------------------------------------------------
// MARKDOWN PARSERS — intentionally tolerant. The renderer in
// chismoso/src/ficha/renderer.ts is the source of truth for the format,
// but a human-edited file may have minor whitespace variations.
// ---------------------------------------------------------------------------

function extractTitle(md: string): string | null {
  const m = md.match(/^#\s+Ficha:\s*(.+?)\s*$/m);
  return m ? m[1] : null;
}

function extractSection(md: string, heading: string): string | null {
  const idx = md.indexOf(heading);
  if (idx < 0) return null;
  const afterHeading = md.slice(idx + heading.length);
  // The first non-empty line that isn't itself a heading is the body.
  const lines = afterHeading.split('\n');
  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) return null;
    return trimmed;
  }
  return null;
}
