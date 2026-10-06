'use client';

import { useMemo, type ReactNode } from 'react';

/**
 * MarkdownRenderer — a small, dependency-free markdown renderer.
 *
 * Renders the most common markdown constructs used in CHISMOSO reports
 * (headings, bold, inline code, code blocks, lists, links, tables,
 * horizontal rules, blockquotes, paragraphs). It deliberately does NOT
 * pull in `react-markdown`, `remark` or `@tailwindcss/typography` — the
 * goal is to keep deps minimal and styling inline.
 *
 * Supported syntax:
 *   # H1, ## H2, ### H3, #### H4, ##### H5, ###### H6
 *   **bold**  and  *italic*
 *   `inline code`
 *   ```lang\n fenced code block \n```
 *   - / * / +  unordered list items
 *   1. / 2.  ordered list items
 *   [label](url)  links (open in new tab)
 *   > blockquote
 *   --- / *** / ___  horizontal rule
 *   | a | b |\n| --- | --- |\n| 1 | 2 |  tables
 *
 * Anything else falls through as a paragraph.
 */

export function MarkdownRenderer({ markdown }: { markdown: string }) {
  const blocks = useMemo(() => parseMarkdown(markdown ?? ''), [markdown]);
  return (
    <div
      className="space-y-3 text-sm leading-relaxed text-foreground"
      // We render trusted, sanitized markdown produced by our own report
      // generator. We still avoid dangerouslySetInnerHTML — every node
      // is a real React element.
    >
      {blocks}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline parsing (bold, italic, inline code, links)
// ---------------------------------------------------------------------------

/**
 * Parse a single line into a sequence of React nodes, handling the inline
 * markdown syntax: `code`, **bold**, *italic*, [label](url).
 *
 * The implementation is intentionally simple — it scans the string left to
 * right and emits React nodes. It does NOT handle nesting (e.g. **bold
 * `code`**). For CHISMOSO reports this is sufficient.
 */
function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let i = 0;
  let buf = '';
  let key = 0;

  const flushBuf = () => {
    if (buf.length > 0) {
      nodes.push(<span key={`${keyBase}-t${key++}`}>{buf}</span>);
      buf = '';
    }
  };

  // Pre-compiled patterns. Order matters: inline code first (so `**`
  // inside `code` isn't parsed), then links, then bold, then italic.
  // const codeRe = /`([^`]+)`/;
  const linkRe = /\[([^\]]+)\]\(([^)\s]+)\)/;
  const boldRe = /\*\*([^*]+)\*\*/;
  const italRe = /\*([^*]+)\*/;
  const codeRe = /`([^`]+)`/;

  while (i < text.length) {
    const rest = text.slice(i);

    const codeMatch = rest.match(codeRe);
    const linkMatch = rest.match(linkRe);
    const boldMatch = rest.match(boldRe);
    const italMatch = rest.match(italRe);

    // Find the earliest match (by index). If none match at all, just
    // consume one char into the buffer and continue — this guarantees
    // forward progress.
    const candidates: Array<{ idx: number; len: number; kind: string; m: RegExpMatchArray }> = [];
    if (codeMatch && codeMatch.index !== undefined) {
      candidates.push({ idx: codeMatch.index, len: codeMatch[0].length, kind: 'code', m: codeMatch });
    }
    if (linkMatch && linkMatch.index !== undefined) {
      candidates.push({ idx: linkMatch.index, len: linkMatch[0].length, kind: 'link', m: linkMatch });
    }
    if (boldMatch && boldMatch.index !== undefined) {
      candidates.push({ idx: boldMatch.index, len: boldMatch[0].length, kind: 'bold', m: boldMatch });
    }
    if (italMatch && italMatch.index !== undefined) {
      candidates.push({ idx: italMatch.index, len: italMatch[0].length, kind: 'italic', m: italMatch });
    }

    if (candidates.length === 0) {
      buf += text[i];
      i += 1;
      continue;
    }

    // Pick the candidate that starts earliest (ties broken by kind priority:
    // code > link > bold > italic — so `**` inside `code` is preserved).
    const priority: Record<string, number> = { code: 0, link: 1, bold: 2, italic: 3 };
    candidates.sort((a, b) => {
      if (a.idx !== b.idx) return a.idx - b.idx;
      return priority[a.kind] - priority[b.kind];
    });

    const c = candidates[0];
    // Flush the plain-text buffer up to the match.
    buf += rest.slice(0, c.idx);
    flushBuf();

    if (c.kind === 'code') {
      nodes.push(
        <code
          key={`${keyBase}-c${key++}`}
          className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground"
        >
          {c.m[1]}
        </code>,
      );
    } else if (c.kind === 'link') {
      const href = c.m[2];
      const safeHref = /^(https?:|mailto:|\/)/i.test(href) ? href : undefined;
      nodes.push(
        <a
          key={`${keyBase}-l${key++}`}
          href={safeHref}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sky-600 hover:underline dark:text-sky-400"
        >
          {c.m[1]}
        </a>,
      );
    } else if (c.kind === 'bold') {
      nodes.push(
        <strong key={`${keyBase}-b${key++}`} className="font-semibold">
          {c.m[1]}
        </strong>,
      );
    } else if (c.kind === 'italic') {
      nodes.push(
        <em key={`${keyBase}-i${key++}`} className="italic">
          {c.m[1]}
        </em>,
      );
    }

    i += c.len;
  }

  flushBuf();
  return nodes;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string; key: string }
  | { kind: 'code'; lang: string; content: string; key: string }
  | { kind: 'hr'; key: string }
  | { kind: 'blockquote'; lines: string[]; key: string }
  | { kind: 'ul'; items: string[]; key: string }
  | { kind: 'ol'; items: string[]; key: string }
  | { kind: 'table'; header: string[]; rows: string[][]; key: string }
  | { kind: 'para'; text: string; key: string };

function parseMarkdown(md: string): ReactNode[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  let k = 0;
  const nextKey = () => `b${k++}`;

  while (i < lines.length) {
    const line = lines[i];

    // --- Fenced code block (```lang\n ... \n```) -----------------------
    const fence = line.match(/^```\s*([\w+-]*)\s*$/);
    if (fence) {
      const lang = fence[1] ?? '';
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      // Consume the closing fence (or EOF).
      if (i < lines.length) i += 1;
      blocks.push({ kind: 'code', lang, content: buf.join('\n'), key: nextKey() });
      continue;
    }

    // --- Horizontal rule (---, ***, ___, with ≥3 chars) ----------------
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push({ kind: 'hr', key: nextKey() });
      i += 1;
      continue;
    }

    // --- Heading (atx style: # .. ######) ------------------------------
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ kind: 'heading', level, text: h[2].trim(), key: nextKey() });
      i += 1;
      continue;
    }

    // --- Blockquote (> ...). Group consecutive > lines. ----------------
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      blocks.push({ kind: 'blockquote', lines: buf, key: nextKey() });
      continue;
    }

    // --- Table (GFM pipe syntax). A table starts with `| ... |` and the
    //     next line is `| --- | --- |` (the delimiter row). -------------
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?[\s:|-|]*$/.test(lines[i + 1])) {
      const header = splitTableRow(line);
      i += 2; // skip header + delimiter
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      blocks.push({ kind: 'table', header, rows, key: nextKey() });
      continue;
    }

    // --- Unordered list (-, *, +) --------------------------------------
    const ulMatch = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ulMatch) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*[-*+]\s+(.*)$/);
        if (!m) break;
        items.push(m[1]);
        i += 1;
      }
      blocks.push({ kind: 'ul', items, key: nextKey() });
      continue;
    }

    // --- Ordered list (1. 2. 3.) ---------------------------------------
    const olMatch = line.match(/^\s*\d+\.\s+(.*)$/);
    if (olMatch) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*\d+\.\s+(.*)$/);
        if (!m) break;
        items.push(m[1]);
        i += 1;
      }
      blocks.push({ kind: 'ol', items, key: nextKey() });
      continue;
    }

    // --- Blank line (skip, separates paragraphs) -----------------------
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // --- Paragraph: gather consecutive non-blank, non-block-starter lines
    const buf: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*\|.*\|\s*$/.test(lines[i]) &&
      !/^\s*([-*_])\1{2,}\s*$/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i += 1;
    }
    blocks.push({ kind: 'para', text: buf.join(' ').trim(), key: nextKey() });
  }

  // --- Render blocks to React nodes ------------------------------------
  return blocks.map((b) => {
    switch (b.kind) {
      case 'heading': {
        const sizes: Record<number, string> = {
          1: 'text-2xl font-bold tracking-tight mt-6 mb-2',
          2: 'text-xl font-semibold tracking-tight mt-5 mb-2',
          3: 'text-lg font-semibold mt-4 mb-1.5',
          4: 'text-base font-semibold mt-3 mb-1',
          5: 'text-sm font-semibold uppercase tracking-wide mt-3 mb-1',
          6: 'text-xs font-semibold uppercase tracking-wide mt-2 mb-1 text-muted-foreground',
        };
        // For h1/h2 we also render a subtle bottom border.
        const border = b.level <= 2 ? 'border-b pb-1' : '';
        const Tag = (`h${b.level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6');
        return (
          <Tag key={b.key} className={`${sizes[b.level]} ${border}`}>
            {renderInline(b.text, b.key)}
          </Tag>
        );
      }
      case 'code':
        return (
          <pre
            key={b.key}
            className="overflow-x-auto rounded-lg border bg-zinc-950 p-3 text-xs font-mono text-zinc-100 leading-relaxed"
          >
            {b.lang ? (
              <div className="mb-2 text-[10px] uppercase tracking-wide text-zinc-500">{b.lang}</div>
            ) : null}
            <code>{b.content}</code>
          </pre>
        );
      case 'hr':
        return <hr key={b.key} className="border-t my-4" />;
      case 'blockquote':
        return (
          <blockquote
            key={b.key}
            className="border-l-4 border-muted-foreground/40 pl-3 py-1 text-muted-foreground italic space-y-1"
          >
            {b.lines.map((l, idx) => (
              <p key={idx} className="leading-relaxed">
                {renderInline(l, `${b.key}-q${idx}`)}
              </p>
            ))}
          </blockquote>
        );
      case 'ul':
        return (
          <ul key={b.key} className="list-disc space-y-1 pl-6 marker:text-muted-foreground/60">
            {b.items.map((it, idx) => (
              <li key={idx} className="leading-relaxed">
                {renderInline(it, `${b.key}-i${idx}`)}
              </li>
            ))}
          </ul>
        );
      case 'ol':
        return (
          <ol key={b.key} className="list-decimal space-y-1 pl-6 marker:text-muted-foreground/60 marker:font-mono">
            {b.items.map((it, idx) => (
              <li key={idx} className="leading-relaxed">
                {renderInline(it, `${b.key}-i${idx}`)}
              </li>
            ))}
          </ol>
        );
      case 'table':
        return (
          <div key={b.key} className="overflow-x-auto rounded-lg border">
            <table className="w-full text-xs">
              <thead className="bg-muted/60">
                <tr>
                  {b.header.map((h, idx) => (
                    <th key={idx} className="border-b px-3 py-1.5 text-left font-semibold whitespace-nowrap">
                      {renderInline(h, `${b.key}-h${idx}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((row, ri) => (
                  <tr key={ri} className="odd:bg-transparent even:bg-muted/20 hover:bg-accent/40">
                    {row.map((cell, ci) => (
                      <td key={ci} className="border-b px-3 py-1.5 align-top">
                        {renderInline(cell, `${b.key}-r${ri}-c${ci}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case 'para':
        return (
          <p key={b.key} className="leading-relaxed">
            {renderInline(b.text, b.key)}
          </p>
        );
      default:
        return null;
    }
  });
}

/**
 * Split a markdown table row like `| a | b | c |` into ['a', 'b', 'c'].
 * Handles escaped pipes (`\|`) and cells without leading/trailing pipes.
 */
function splitTableRow(line: string): string[] {
  let s = line.trim();
  // Strip a leading pipe.
  if (s.startsWith('|')) s = s.slice(1);
  // Strip a trailing pipe.
  if (s.endsWith('|')) s = s.slice(0, -1);
  // Split on unescaped pipes. We use a small state machine so that
  // `\|` inside a cell stays intact.
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|';
      i += 1;
    } else if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}
