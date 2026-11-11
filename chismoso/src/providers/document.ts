/**
 * CHISMOSO V1.6 — DocumentProvider (Task IMP-DOC-INGEST)
 *
 * Ingests local documents (PDF, Word .docx, Excel .xlsx, PowerPoint .pptx,
 * images with OCR, plain text, markdown, HTML) and extracts text that the
 * normalizer converts into Signals + Evidence.
 *
 * Motivation: a signal intelligence agent that cannot read documents is
 * blind to the most valuable intelligence sources — market reports, white
 * papers, investor decks, spreadsheets, press releases, social-media
 * screenshots. This provider closes that gap.
 *
 * Architecture notes:
 *
 *  - This provider does NOT participate in the standard `search()` flow
 *    (the orchestrator's PLAN step generates text queries for providers
 *    like web_search / reddit). Documents are ingested by an explicit
 *    `ingestDocument()` call — driven by the `ingest_document` tool, the
 *    `chismoso ingest <file>` CLI command, or the `POST /api/ingest`
 *    upload route.
 *
 *  - Heavy parser deps (pdf-parse, mammoth, xlsx, officeparser,
 *    tesseract.js, marked) are loaded LAZILY via dynamic `import()` so
 *    the provider module remains cheap to load when no document is being
 *    ingested (the orchestrator imports providers eagerly on startup).
 *
 *  - OCR (tesseract.js) is slow (5–30 s per image) and downloads language
 *    data on first run. The `ingest_document` tool sets a 120 s timeout
 *    to accommodate this, and the chunker caps extracted text at 100 KB
 *    so a 200-page PDF doesn't blow up memory.
 *
 *  - Each document's extracted text is split into ~2 KB chunks before
 *    normalization so each chunk becomes its own Signal + Evidence pair
 *    with `format` / `fileName` / `chunkIndex` metadata. This lets the
 *    downstream trend / opportunity engines treat a long document as
 *    multiple corroborating observations rather than one giant blob.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  makeCapabilities,
  type IProvider,
  type ProviderQuery,
  type ProviderSearchResult,
  type RawItem,
} from './base.js';
import { ErrorCode } from '../errors.js';
import { logger } from '../logger.js';
import {
  ProviderHealth,
  SourceType,
  nowISO,
} from '../models.js';

// ---------------------------------------------------------------------------
// PUBLIC TYPES
// ---------------------------------------------------------------------------

export interface DocumentIngestInput {
  /** Absolute path to the file on disk. */
  filePath: string;
  /** Topic to tag every extracted Signal with. */
  topic?: string;
  /** Geographic scope to attach to every extracted Evidence. */
  geography?: string;
  /** Arbitrary extra metadata merged into each signal's `metadata` blob. */
  metadata?: Record<string, unknown>;
}

export type DocumentFormat =
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'image'
  | 'text'
  | 'markdown'
  | 'html'
  | 'unknown';

export interface DocumentIngestResult {
  fileName: string;
  format: DocumentFormat;
  /** For PDF / PPTX — count of pages / slides detected by the parser. */
  pages?: number;
  /** For XLSX — count of sheets in the workbook. */
  sheets?: number;
  /** Full extracted text (capped at 100 KB with a truncation marker). */
  extractedText: string;
  textLength: number;
  /** RawItem count produced — filled by `ingestDocument`. */
  signalsExtracted: number;
  evidenceExtracted: number;
  durationMs: number;
  /** Non-fatal extraction error (file still produced partial text). */
  error?: string;
}

export interface DocumentIngestOutput {
  result: DocumentIngestResult;
  rawItems: RawItem[];
}

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

/**
 * Hard cap on extracted text. A 200-page PDF can easily produce 1 MB of
 * raw text — keeping 100 KB is enough for the normalizer + trend engines
 * to find the strongest signals without ballooning SQLite row size.
 *
 * The truncation marker is appended so downstream consumers can tell
 * they're looking at a partial extract.
 */
const MAX_TEXT_BYTES = 100_000;

/**
 * Chunk size in characters. Each chunk becomes one Signal + Evidence pair.
 * 2 KB is small enough that the normalized snippet is meaningful but
 * large enough that 2 KB of a long document surfaces ~50–100 tokens of
 * context for the trend engine to work with.
 */
const CHUNK_SIZE = 2000;

// ---------------------------------------------------------------------------
// PROVIDER
// ---------------------------------------------------------------------------

export class DocumentProvider implements IProvider {
  capabilities() {
    return makeCapabilities(
      'document',
      SourceType.WEB_CONTENT, // documents are content; reuse the type
      ['ingest', 'extract', 'normalize'],
      ProviderHealth.OK,
      'none',
      { requestsPerMinute: 10, maxResultsPerCall: 100 },
    );
  }

  canHandle(_query: ProviderQuery): boolean {
    // The document provider does NOT participate in the standard search()
    // flow — it's invoked directly via ingestDocument(). Returning false
    // here means the orchestrator's `availableFor(query)` filter excludes
    // it from the PLAN step's provider selection.
    return false;
  }

  async health(): Promise<ProviderHealth> {
    // No external dependency to ping — the parsers are bundled. Healthy
    // unless the host filesystem is unreadable, which is outside our scope.
    return ProviderHealth.OK;
  }

  async search(query: ProviderQuery): Promise<ProviderSearchResult> {
    // Standard search not supported. Documents are ingested, not searched.
    return {
      providerName: 'document',
      items: [],
      errorCode: ErrorCode.INVALID_INPUT,
      error:
        'DocumentProvider does not support search(). Use ingestDocument() directly.',
      durationMs: 0,
      query: query.query,
    };
  }

  // -----------------------------------------------------------------------
  // MAIN ENTRY POINT
  // -----------------------------------------------------------------------

  /**
   * Ingest a single document, extract its text, and split into RawItems.
   *
   * Each RawItem will later be normalised into one Signal + one Evidence
   * by the normalizer (called by the `ingest_document` tool, NOT here —
   * keeps this provider pure: it produces raw items, the tool persists
   * them).
   *
   * Returns `{ result, rawItems }`. When extraction fails entirely,
   * `rawItems` is empty and `result.error` carries the cause. When
   * extraction succeeds partially (e.g. OCR with low confidence), the
   * extracted text is still returned as RawItems and `result.error` is
   * set to a non-fatal warning.
   */
  async ingestDocument(
    input: DocumentIngestInput,
  ): Promise<DocumentIngestOutput> {
    const t0 = Date.now();
    const filePath = input.filePath;

    if (!existsSync(filePath)) {
      return {
        result: {
          fileName: path.basename(filePath),
          format: 'unknown',
          extractedText: '',
          textLength: 0,
          signalsExtracted: 0,
          evidenceExtracted: 0,
          durationMs: Date.now() - t0,
          error: `File not found: ${filePath}`,
        },
        rawItems: [],
      };
    }

    const ext = path.extname(filePath).toLowerCase().slice(1);
    const fileName = path.basename(filePath);
    let format: DocumentFormat = 'unknown';
    let extractedText = '';
    let pages: number | undefined;
    let sheets: number | undefined;
    let error: string | undefined;

    try {
      switch (ext) {
        case 'pdf':
          format = 'pdf';
          ({ text: extractedText, pages } = await this.extractPdf(filePath));
          break;
        case 'docx':
          format = 'docx';
          extractedText = await this.extractDocx(filePath);
          break;
        case 'xlsx':
        case 'xls':
          format = 'xlsx';
          ({ text: extractedText, sheets } = await this.extractXlsx(filePath));
          break;
        case 'pptx':
          format = 'pptx';
          ({ text: extractedText, pages } = await this.extractPptx(filePath));
          break;
        case 'png':
        case 'jpg':
        case 'jpeg':
        case 'webp':
        case 'gif':
          format = 'image';
          extractedText = await this.extractImageOcr(filePath);
          break;
        case 'md':
        case 'markdown':
          format = 'markdown';
          extractedText = await this.extractMarkdownFile(filePath);
          break;
        case 'txt':
        case 'csv':
        case 'json':
        case 'xml':
        case 'log':
        case 'tsv':
          format = 'text';
          extractedText = await this.extractTextFile(filePath);
          break;
        case 'html':
        case 'htm':
          format = 'html';
          extractedText = await this.extractHtmlFile(filePath);
          break;
        default:
          // Unknown extension — try plain text. If it's binary, readFile
          // will succeed but the text will be garbage; the normalizer
          // handles that gracefully (it tokenizes and discards noise).
          format = 'text';
          extractedText = await this.extractTextFile(filePath);
      }
    } catch (e: any) {
      error = e?.message ?? String(e);
      logger.warn('Document extraction failed', {
        filePath,
        format,
        err: error,
      });
    }

    // Cap at MAX_TEXT_BYTES so a giant PDF doesn't blow up SQLite.
    if (extractedText.length > MAX_TEXT_BYTES) {
      extractedText =
        extractedText.slice(0, MAX_TEXT_BYTES) +
        '\n\n[... truncated at 100KB ...]';
    }

    const result: DocumentIngestResult = {
      fileName,
      format,
      pages,
      sheets,
      extractedText,
      textLength: extractedText.length,
      signalsExtracted: 0, // filled below
      evidenceExtracted: 0, // filled below
      durationMs: Date.now() - t0,
      error,
    };

    // Convert extracted text → RawItems. Each chunk becomes one raw item
    // (→ one Signal + one Evidence pair after normalization).
    const rawItems: RawItem[] = [];
    if (extractedText && !error) {
      const chunks = this.chunkText(extractedText, CHUNK_SIZE);
      for (let i = 0; i < chunks.length; i++) {
        rawItems.push({
          providerName: 'document',
          sourceType: SourceType.WEB_CONTENT,
          title: `${fileName} (chunk ${i + 1}/${chunks.length})`,
          snippet: chunks[i],
          url: undefined,
          hostName: undefined,
          date: nowISO(),
          rawMetadata: {
            format,
            fileName,
            filePath,
            chunkIndex: i,
            totalChunks: chunks.length,
            pages,
            sheets,
            topic: input.topic,
            ...input.metadata,
          },
        });
      }
    }

    result.signalsExtracted = rawItems.length;
    result.evidenceExtracted = rawItems.length;

    return { result, rawItems };
  }

  // -----------------------------------------------------------------------
  // FORMAT-SPECIFIC EXTRACTORS
  // -----------------------------------------------------------------------

  /**
   * PDF → text via pdf-parse. Returns the concatenated text of every page
   * plus the page count. pdf-parse handles most text-based PDFs; scanned
   * PDFs (image-only) will return near-empty text — for those, the
   * operator should pre-process with an OCR step (out of scope for V1).
   */
  private async extractPdf(
    filePath: string,
  ): Promise<{ text: string; pages: number }> {
    const pdfParse = (await import('pdf-parse')).default;
    const buffer = await readFile(filePath);
    const data = await pdfParse(buffer);
    return {
      text: data.text ?? '',
      pages: data.numpages ?? 0,
    };
  }

  /**
   * .docx → plain text via mammoth. Uses `extractRawText` (no formatting)
   * so the normalizer sees clean prose without HTML markup noise.
   */
  private async extractDocx(filePath: string): Promise<string> {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value ?? '';
  }

  /**
   * .xlsx → text by joining every sheet as CSV. Sheet separators are
   * `=== Sheet: <name> ===` headers so downstream consumers can tell
   * where one sheet ends. Returns sheet count.
   */
  private async extractXlsx(
    filePath: string,
  ): Promise<{ text: string; sheets: number }> {
    const XLSX = await import('xlsx');
    const workbook = XLSX.readFile(filePath);
    const sheets: string[] = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) continue;
      const csv = XLSX.utils.sheet_to_csv(sheet);
      sheets.push(`=== Sheet: ${sheetName} ===\n${csv}`);
    }
    return {
      text: sheets.join('\n\n'),
      sheets: workbook.SheetNames.length,
    };
  }

  /**
   * .pptx → text via officeparser. Returns the slide count (best-effort
   * — officeparser doesn't expose a counter, so we count "Slide N"
   * markers in the extracted text).
   */
  private async extractPptx(
    filePath: string,
  ): Promise<{ text: string; pages: number }> {
    const officeparser = await import('officeparser');
    const text: string = await officeparser.parseOffice(filePath);
    // officeparser emits text per slide; count by looking for slide
    // markers. Fallback to 1 when no markers found (single-slide deck
    // or parser format changed).
    const slideCount =
      (text.match(/Slide\s+\d+/gi) || []).length || 1;
    return { text, pages: slideCount };
  }

  /**
   * Image (png/jpg/jpeg/webp/gif) → text via Tesseract OCR.
   *
   * Uses `spa+eng` language data (Spanish + English) because CHISMOSO's
   * primary investigations are in Spanish-speaking markets. Operators
   * who need other languages can extend this list.
   *
   * This is the slowest extractor — 5–30 s per image. The
   * `ingest_document` tool has a 120 s timeout to accommodate it.
   */
  private async extractImageOcr(filePath: string): Promise<string> {
    const Tesseract = (await import('tesseract.js')).default;
    const { data } = await Tesseract.recognize(filePath, 'spa+eng', {
      logger: (m: { status: string; progress: number }) =>
        logger.debug('OCR progress', {
          status: m.status,
          progress: m.progress,
        }),
    });
    return data.text ?? '';
  }

  /**
   * Plain text file (utf-8). Covers .txt, .csv, .json, .xml, .log, .tsv.
   */
  private async extractTextFile(filePath: string): Promise<string> {
    return await readFile(filePath, 'utf8');
  }

  /**
   * Markdown → plain text. Uses `marked` lexer to strip markdown syntax
   * (headings, bold, links, code fences) so the normalizer sees prose.
   *
   * For very small .md files we just return the raw content — marked's
   * lexer has a non-trivial startup cost and most .md files we ingest
   * are short notes.
   */
  private async extractMarkdownFile(filePath: string): Promise<string> {
    const raw = await readFile(filePath, 'utf8');
    if (raw.length < 500) return raw;
    try {
      const { marked } = await import('marked');
      const tokens = marked.lexer(raw);
      // Walk the token tree and collect text-bearing leaves.
      const parts: string[] = [];
      const walk = (tok: any): void => {
        if (!tok) return;
        if (tok.type === 'text' || tok.type === 'codespan' || tok.type === 'escape') {
          if (typeof tok.text === 'string') parts.push(tok.text);
        }
        if (tok.type === 'heading' || tok.type === 'paragraph' || tok.type === 'list_item') {
          if (tok.tokens && Array.isArray(tok.tokens)) {
            for (const t of tok.tokens) walk(t);
          }
        }
        if (tok.type === 'list' && Array.isArray(tok.items)) {
          for (const it of tok.items) walk(it);
        }
      };
      for (const t of tokens) walk(t);
      const text = parts.join('\n').trim();
      return text.length > 0 ? text : raw;
    } catch {
      // marked parse failure → return raw markdown text
      return raw;
    }
  }

  /**
   * HTML file → plain text. Same stripping logic as WebContentProvider:
   * drop <script> / <style>, then strip all tags and collapse whitespace.
   */
  private async extractHtmlFile(filePath: string): Promise<string> {
    const html = await readFile(filePath, 'utf8');
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // -----------------------------------------------------------------------
  // CHUNKING
  // -----------------------------------------------------------------------

  /**
   * Splits text into chunks of approximately `chunkSize` characters,
   * preferring paragraph boundaries (`\n\n`) so each chunk is a coherent
   * block of prose rather than a mid-sentence cut.
   *
   * - Text shorter than `chunkSize` → single chunk.
   * - Paragraph longer than `chunkSize` → that paragraph is one chunk
   *   (we don't split mid-paragraph — the normalizer can still tokenize
   *   a long chunk fine).
   */
  private chunkText(text: string, chunkSize: number): string[] {
    if (!text) return [];
    if (text.length <= chunkSize) return [text];
    const chunks: string[] = [];
    const paragraphs = text.split(/\n\n+/);
    let current = '';
    for (const p of paragraphs) {
      if (current && (current + '\n\n' + p).length > chunkSize) {
        chunks.push(current);
        current = p;
      } else {
        current = current ? current + '\n\n' + p : p;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }
}
