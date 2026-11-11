import { NextRequest } from 'next/server';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rateLimit, getClientIP, LIMITS } from '@/lib/rate-limit';
import {
  apiBadRequest,
  apiOk,
  apiRateLimited,
  apiServerError,
  apiUnavailable,
} from '@/lib/api-response';
import { authedPOST, getAuthStatus } from '@/lib/middleware';
import { appendAudit } from '@/lib/audit-log-server';
import { onShutdown, isShuttingDown } from '@/lib/graceful-shutdown';
import { getCurrentTraceId, TRACE_ID_ENV } from '@/lib/trace-id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

const CHISMOSO_ROOT = '/home/z/my-project/chismoso';
const UPLOAD_DIR = '/tmp/chismoso-uploads';

/** Maximum file size accepted by the upload endpoint — 50 MB. */
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

/** File extensions accepted by the ingest pipeline. */
const ALLOWED_EXTENSIONS = new Set([
  'pdf',
  'docx',
  'xlsx',
  'xls',
  'pptx',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'txt',
  'csv',
  'json',
  'xml',
  'log',
  'tsv',
  'md',
  'markdown',
  'html',
  'htm',
]);

/**
 * Pre-compiled CLI is preferred (faster startup — no TS compilation per call).
 * Falls back to `npx tsx src/cli.ts` when dist/ hasn't been built yet.
 */
const COMPILED_CLI = `${CHISMOSO_ROOT}/dist/cli.js`;
const USE_COMPILED = existsSync(COMPILED_CLI);

interface IngestResponse {
  ok: boolean;
  investigationId: string;
  fileName: string;
  format: string;
  pages?: number;
  sheets?: number;
  textLength: number;
  signalsStored: number;
  evidenceStored: number;
  durationMs: number;
  extractedTextPath?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/**
 * Sanitize the upload's filename for safe storage on disk. Strips path
 * separators, control characters, and anything outside [\w.-]. The
 * original filename (preserved by the multipart parser) is still passed
 * through to the CLI for display.
 */
function safeFileName(name: string): string {
  const base = path.basename(name);
  return base.replace(/[^\w.-]/g, '_').slice(0, 200);
}

/**
 * Parse the JSON payload that the chismoso CLI prints to stdout at the
 * end of a successful `ingest` run. The CLI prints a single JSON object;
 * any non-JSON line on stdout (none expected today) is ignored.
 */
function parseCliResult(stdout: string): IngestResponse | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  // The CLI prints exactly one JSON object. Find the first '{' and parse
  // to the matching '}' — tolerant of any stderr noise that slipped onto
  // stdout (the CLI routes logs to stderr, but be defensive).
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(trimmed.slice(start, end + 1));
    return obj as IngestResponse;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// POST /api/ingest — multipart/form-data with file + topic + geography
// ---------------------------------------------------------------------------

export const POST = authedPOST(async (req: NextRequest) => {
  // --- Drain / shutdown guard -------------------------------------------
  if (isShuttingDown()) {
    return apiUnavailable('Server is shutting down');
  }

  // --- Rate limit (per-IP, 5/min) ---------------------------------------
  const ip = getClientIP(req);
  const rl = rateLimit(`ingest:${ip}`, LIMITS.investigate);
  if (!rl.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
    return apiRateLimited(retryAfter);
  }

  // --- Parse multipart body ---------------------------------------------
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return apiBadRequest('Expected multipart/form-data with a file upload');
  }

  const file = formData.get('file');
  if (!(file instanceof File)) {
    return apiBadRequest('Missing "file" field in multipart form data');
  }
  if (file.size === 0) {
    return apiBadRequest('Uploaded file is empty');
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return apiBadRequest(
      `File too large: ${file.size} bytes (max ${MAX_FILE_SIZE_BYTES})`,
    );
  }

  const originalName = file.name || 'upload.bin';
  const ext = path.extname(originalName).toLowerCase().slice(1);
  if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
    return apiBadRequest(
      `Unsupported file extension ".${ext || '(none)'}". ` +
        `Supported: ${Array.from(ALLOWED_EXTENSIONS).join(', ')}`,
    );
  }

  // Optional metadata fields from the form.
  const topicRaw = formData.get('topic');
  const geographyRaw = formData.get('geography');
  const topic =
    typeof topicRaw === 'string' && topicRaw.trim().length > 0
      ? topicRaw.trim().slice(0, 200)
      : path.basename(originalName, path.extname(originalName));
  const geography =
    typeof geographyRaw === 'string' && geographyRaw.trim().length > 0
      ? geographyRaw.trim().slice(0, 100)
      : 'global';

  // --- Persist the upload to disk ---------------------------------------
  // We can't pass the file bytes directly to the CLI subprocess — it
  // expects a file path. So we stage the upload to /tmp/chismoso-uploads/
  // and pass that path. The path is unique per request (uuid prefix) so
  // concurrent uploads don't collide.
  let stagedPath: string;
  try {
    await mkdir(UPLOAD_DIR, { recursive: true });
    const uuid = randomUUID();
    const safeName = safeFileName(originalName);
    stagedPath = path.join(UPLOAD_DIR, `${uuid}-${safeName}`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    await writeFile(stagedPath, bytes);
  } catch (e: any) {
    return apiServerError('Could not stage upload', { message: e?.message ?? String(e) });
  }

  // --- Audit + auth context ---------------------------------------------
  const authStatus = getAuthStatus(req);
  const actor =
    authStatus.ok && authStatus.reason !== 'auth_disabled'
      ? 'user:operator'
      : 'agent:chismoso';
  appendAudit({
    actor,
    action: 'ingest.start',
    target_type: 'document',
    target_id: stagedPath,
    ip,
    user_agent: req.headers.get('user-agent') ?? undefined,
    metadata: {
      fileName: originalName,
      fileSize: file.size,
      topic,
      geography,
    },
  });

  // --- Spawn the CLI subprocess -----------------------------------------
  // We use the same pattern as /api/investigate: spawn the chismoso CLI
  // with array args (no shell), capture stdout (the JSON result) and
  // stderr (logs), and respect client-abort / SIGTERM to kill the child.
  const cliArgs = [
    'ingest',
    stagedPath,
    `--topic=${topic}`,
    `--geography=${geography}`,
  ];
  const childCmd = USE_COMPILED ? 'node' : 'npx';
  const childArgs = USE_COMPILED
    ? [COMPILED_CLI, ...cliArgs]
    : ['tsx', 'src/cli.ts', ...cliArgs];

  const result = await new Promise<{
    stdout: string;
    stderr: string;
    code: number | null;
  }>((resolve) => {
    const traceId = getCurrentTraceId() ?? 'no-trace';
    const child = spawn(childCmd, childArgs, {
      cwd: CHISMOSO_ROOT,
      env: {
        ...process.env,
        CHISMOSO_LOG_LEVEL: 'WARN',
        [TRACE_ID_ENV]: traceId,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    const killChild = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 2000).unref?.();
    };
    const abortListener = () => killChild();
    req.signal.addEventListener('abort', abortListener);
    const unregisterShutdown = onShutdown(() => killChild());
    const timeout = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }, 110_000); // 110s — under the route's maxDuration of 120s

    child.on('close', (code) => {
      clearTimeout(timeout);
      req.signal.removeEventListener('abort', abortListener);
      unregisterShutdown();
      resolve({ stdout, stderr, code });
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      req.signal.removeEventListener('abort', abortListener);
      unregisterShutdown();
      resolve({
        stdout,
        stderr: stderr + '\n' + (err?.message ?? String(err)),
        code: -1,
      });
    });
  });

  const parsed = parseCliResult(result.stdout);

  // --- Audit + result handling ------------------------------------------
  appendAudit({
    actor,
    action: 'ingest.complete',
    target_type: 'document',
    target_id: parsed?.investigationId ?? 'unknown',
    ip,
    user_agent: req.headers.get('user-agent') ?? undefined,
    metadata: {
      fileName: originalName,
      topic,
      geography,
      signalsStored: parsed?.signalsStored ?? 0,
      evidenceStored: parsed?.evidenceStored ?? 0,
      exitCode: result.code,
    },
  });

  if (!parsed) {
    return apiServerError(
      'Document ingestion failed — no result from CLI',
      process.env.NODE_ENV !== 'production'
        ? {
            stdout: result.stdout.slice(-500),
            stderr: result.stderr.split('\n').slice(-20).join('\n'),
          }
        : undefined,
    );
  }

  return apiOk({
    ok: !parsed.error,
    investigationId: parsed.investigationId,
    fileName: parsed.fileName,
    format: parsed.format,
    pages: parsed.pages,
    sheets: parsed.sheets,
    textLength: parsed.textLength,
    signalsStored: parsed.signalsStored,
    evidenceStored: parsed.evidenceStored,
    durationMs: parsed.durationMs,
    extractedTextPath: parsed.extractedTextPath,
    error: parsed.error,
  });
});
