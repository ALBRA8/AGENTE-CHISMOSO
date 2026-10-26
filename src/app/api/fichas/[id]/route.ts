import { NextRequest } from 'next/server';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { apiBadRequest, apiNotFound, apiOk, apiServerError } from '@/lib/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Directory where the orchestrator persists FICHA markdown files.
 * Mirrors the constant in `chismoso/src/ficha/renderer.ts`.
 */
const FICHAS_DIR = '/home/z/my-project/download/chismoso/fichas';

interface FichaDetailResponse {
  id: string;
  found: boolean;
  markdown: string;
  parsed: {
    title: string | null;
    oneLiner: string | null;
    targetAudience: string | null;
    opportunityId: string | null;
    investigationId: string | null;
    trendTopic: string | null;
    signalCount: number | null;
    topEvidenceUrls: string[];
    truthLevel: string | null;
    generatedAt: string | null;
  } | null;
  sizeBytes: number;
  generatedAt: string | null;
}

/**
 * GET /api/fichas/[id]
 *
 * Returns the full FICHA markdown for the given opportunity ID, plus a
 * lightweight parsed view that the UI can render without re-parsing the
 * markdown itself.
 *
 * Path traversal protection:
 *   - `id` is validated against `/^[\w-]+$/` (no slashes, no dots)
 *   - we then call `path.basename(id)` as belt-and-braces
 *   - and finally verify the resolved path stays inside FICHAS_DIR
 *
 * The parsed view is intentionally lossy — for the full FichaSpec JSON,
 * a builder agent should consult the `chismoso_get_ficha` MCP tool,
 * which deserialises the markdown into a typed FichaSpec object.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id || !/^[\w-]+$/.test(id)) {
    return apiBadRequest('Invalid ficha ID');
  }

  const safeId = path.basename(id);
  const fichaPath = path.join(FICHAS_DIR, `ficha-${safeId}.md`);
  const resolved = path.resolve(fichaPath);
  const resolvedBase = path.resolve(FICHAS_DIR);
  if (!resolved.startsWith(resolvedBase + path.sep)) {
    return apiBadRequest('Path traversal detected');
  }

  let markdown: string;
  let st;
  try {
    markdown = await readFile(fichaPath, 'utf8');
    st = await stat(fichaPath);
  } catch {
    return apiNotFound('Ficha not found');
  }

  const parsed = parseFichaMarkdown(markdown);

  const body: FichaDetailResponse = {
    id: safeId,
    found: true,
    markdown,
    parsed,
    sizeBytes: st.size,
    generatedAt: st.mtime.toISOString(),
  };

  try {
    return apiOk(body);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return apiServerError('ficha_read_failed', { message });
  }
}

// ---------------------------------------------------------------------------
// MARKDOWN PARSER — tolerant, regex-driven. Matches the format produced
// by `renderFichaMarkdown` in chismoso/src/ficha/renderer.ts but tolerates
// minor whitespace variations from human edits.
// ---------------------------------------------------------------------------

function parseFichaMarkdown(md: string): FichaDetailResponse['parsed'] {
  try {
    const title = extractHeadingValue(md, /^#\s+Ficha:\s*(.+?)\s*$/m);
    const oneLiner = extractSectionBody(md, '## 1. En una frase');
    const targetAudience = extractSectionBody(md, '## 2. Para quién y para qué');

    // Evidence block — pull fields from the bullet list under section 7.
    // The renderer formats as `- **Opportunity ID:** \`value\`` so the
    // regex uses `.*?` between the label and the backtick to tolerate
    // the bold markers (and any human edits that add/remove them).
    const evidenceSection = extractRawSection(md, '## 7. Evidencia');
    const opportunityId = matchBullet(evidenceSection, /Opportunity ID:.*?`([^`]+)`/);
    const investigationId = matchBullet(evidenceSection, /Investigation ID:.*?`([^`]+)`/);
    const trendTopic = matchBullet(evidenceSection, /Trend topic:\s*(.+)$/m);
    // Tolerate the bold markers between the label and the number
    // (renderer formats as `- **Signals count:** 5`).
    const signalCountMatch = matchBullet(evidenceSection, /Signals count:.*?(\d+)/);
    const signalCount = signalCountMatch ? parseInt(signalCountMatch, 10) : null;
    const topEvidenceUrls = extractUrlBullets(evidenceSection);

    // Header block — `> Veracidad: DERIVED (síntesis...)`. Search the
    // whole markdown rather than slicing to the first blank line,
    // because the `>` quoted lines come AFTER a blank line that follows
    // the `# Ficha:` heading.
    const truthLevel = matchHeader(md, /Veracidad:\s*(\w+)/);
    const generatedAt = matchHeader(md, /Fecha:\s*(.+?)\s*$/m);

    return {
      title: title ?? null,
      oneLiner: oneLiner ?? null,
      targetAudience: targetAudience ?? null,
      opportunityId: opportunityId ?? null,
      investigationId: investigationId ?? null,
      trendTopic: trendTopic ?? null,
      signalCount: Number.isFinite(signalCount) ? signalCount : null,
      topEvidenceUrls,
      truthLevel: truthLevel ?? null,
      generatedAt: generatedAt ?? null,
    };
  } catch {
    return null;
  }
}

function extractHeadingValue(md: string, re: RegExp): string | null {
  const m = md.match(re);
  return m ? m[1] : null;
}

function matchHeader(md: string, re: RegExp): string | null {
  // The header block (`# Ficha:` + `>` quoted lines) sits at the top of
  // the document but is separated by blank lines. Searching the whole
  // markdown (rather than slicing to the first blank line) is robust
  // because these labels appear only once.
  const m = md.match(re);
  return m ? m[1] : null;
}

function extractRawSection(md: string, headingPrefix: string): string {
  // Find the heading (e.g. "## 7. Evidencia (trazabilidad CHISMOSO)")
  // by matching only its prefix so trailing label variations don't break
  // the lookup.
  const re = new RegExp(`^${escapeRegex(headingPrefix)}.*$`, 'm');
  const m = md.match(re);
  if (!m) return '';
  const start = (m.index ?? 0) + m[0].length;
  // Section body extends until the next `## ` heading or EOF.
  const tailMatch = md.slice(start).match(/\n## /);
  const end = tailMatch && tailMatch.index !== undefined ? start + tailMatch.index : md.length;
  return md.slice(start, end);
}

function extractSectionBody(md: string, heading: string): string | null {
  const raw = extractRawSection(md, heading);
  return firstNonEmptyLine(raw);
}

function firstNonEmptyLine(section: string): string | null {
  const lines = section.split('\n');
  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) return null;
    return trimmed;
  }
  return null;
}

function matchBullet(section: string, re: RegExp): string | null {
  const m = section.match(re);
  return m ? m[1] : null;
}

function extractUrlBullets(section: string): string[] {
  // Look for bullet lines that look like URLs (indented with "  - https?://")
  const urls: string[] = [];
  const re = /^\s+-\s+(https?:\/\/\S+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(section)) !== null) {
    urls.push(m[1]);
  }
  return urls;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
