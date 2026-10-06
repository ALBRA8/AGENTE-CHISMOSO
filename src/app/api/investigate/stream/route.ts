import { NextRequest } from 'next/server';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rateLimit, getClientIP, LIMITS } from '@/lib/rate-limit';
import { apiBadRequest, apiRateLimited } from '@/lib/api-response';
import {
  validateObjective,
  validateGeography,
  validateMaxQueries,
  validateMaxRuntimeMs,
} from '@/lib/validation';

/**
 * SSE streaming endpoint for live investigation progress.
 *
 * Spawns the CHISMOSO CLI as a child process (same as /api/investigate) but
 * instead of waiting for it to finish, returns a `text/event-stream` response
 * that emits typed events as the child emits stdout/stderr lines.
 *
 * Supports BOTH:
 *   - POST with JSON body `{ objective, geography, maxQueries, maxRuntimeMs }`
 *     (same shape as /api/investigate) for fetch-based streaming clients.
 *   - GET with query params `?objective=...&geography=...&maxQueries=N&maxRuntimeMs=N`
 *     so the browser-native EventSource API can connect (it can only do GET).
 *
 * Event types emitted (SSE `event:` field):
 *   - log             { line, ts, stream: "stdout"|"stderr" }
 *   - stage           { stage: "spawning"|"started"|"clustering"|"completed", ... }
 *   - provider_done   { provider, count, durationMs, query? }
 *   - trend           { topic, state, score, sources, signals }
 *   - problem         { topic, severity, frequency, confidence, signals }
 *   - opportunity     { title, score, confidence, weak, evidenceCount }
 *   - saved           { investigationId, path }
 *   - error           { message, code }
 *   - done            { code, investigationId }
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const CHISMOSO_ROOT = '/home/z/my-project/chismoso';

/**
 * Pre-compiled CLI is preferred (faster startup — no TS compilation per call).
 * Falls back to `npx tsx src/cli.ts` when dist/ hasn't been built yet.
 */
const COMPILED_CLI = `${CHISMOSO_ROOT}/dist/cli.js`;
const USE_COMPILED = existsSync(COMPILED_CLI);

interface InvestigateParams {
  objective: string;
  geography: string;
  maxQueries: number;
  maxRuntimeMs: number;
}

function parseParams(
  objectiveRaw: unknown,
  geographyRaw: unknown,
  maxQueriesRaw: unknown,
  maxRuntimeMsRaw: unknown,
): { params: InvestigateParams | null; error: string | null } {
  const objectiveRes = validateObjective(objectiveRaw);
  if (!objectiveRes.ok) return { params: null, error: objectiveRes.error ?? 'invalid objective' };
  const geographyRes = validateGeography(geographyRaw);
  if (!geographyRes.ok) return { params: null, error: geographyRes.error ?? 'invalid geography' };
  const maxQueriesRes = validateMaxQueries(maxQueriesRaw);
  if (!maxQueriesRes.ok) return { params: null, error: maxQueriesRes.error ?? 'invalid maxQueries' };
  const maxRuntimeMsRes = validateMaxRuntimeMs(maxRuntimeMsRaw);
  if (!maxRuntimeMsRes.ok) return { params: null, error: maxRuntimeMsRes.error ?? 'invalid maxRuntimeMs' };
  return {
    params: {
      objective: objectiveRes.value!,
      geography: geographyRes.value!,
      maxQueries: maxQueriesRes.value!,
      maxRuntimeMs: maxRuntimeMsRes.value!,
    },
    error: null,
  };
}

function runInvestigationStream(params: InvestigateParams, signal: AbortSignal): Response {
  const { objective, geography, maxQueries, maxRuntimeMs } = params;

  // Build CLI args. We pass --save so reports are persisted to disk too.
  // When the pre-compiled CLI exists, we invoke `node dist/cli.js ...` (no
  // TS compilation overhead — ~370ms faster startup than `npx tsx src/cli.ts`).
  // Otherwise we fall back to the tsx dev runner.
  const cliArgs = [
    'investigate',
    objective,
    `--geography=${geography}`,
    `--max-queries=${maxQueries}`,
    `--max-runtime-ms=${maxRuntimeMs}`,
    '--save',
  ];
  const childCmd = USE_COMPILED ? 'node' : 'npx';
  const childArgs = USE_COMPILED
    ? [COMPILED_CLI, ...cliArgs]
    : ['tsx', 'src/cli.ts', ...cliArgs];

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(payload));
        } catch {
          /* controller may already be closed */
        }
      };

      const closeStream = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      };

      send('stage', { stage: 'spawning', objective, geography, maxQueries, maxRuntimeMs });

      const child = spawn(childCmd, childArgs, {
        cwd: CHISMOSO_ROOT,
        // INFO so the logger.info() milestone lines (Clustering complete, Trend
        // detected, etc.) are emitted. They go to stdout as JSON.
        env: { ...process.env, CHISMOSO_LOG_LEVEL: 'INFO' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // FIX-2 (AUDIT-PERF Critical #5): if the client disconnects (closes
      // the tab, navigates away, network drops) the request signal fires
      // 'abort'. We kill the spawned CLI promptly so it stops consuming
      // provider quota and CPU for a stream no one is reading.
      const abortListener = () => {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        // Give it 2s to clean up gracefully, then SIGKILL.
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }, 2000);
      };
      signal.addEventListener('abort', abortListener);

      let stdoutBuffer = '';
      let stderrBuffer = '';
      let investigationId = 'unknown';

      const handleLine = (line: string, streamName: 'stdout' | 'stderr') => {
        const trimmed = line.replace(/\r$/, '');
        if (trimmed.length === 0) return;

        // Emit raw log line for both streams.
        send('log', { line: trimmed, ts: new Date().toISOString(), stream: streamName });

        // Try JSON parse — logger.info emits JSON on stdout, logger.error on stderr.
        let parsed: Record<string, unknown> | null = null;
        const t = trimmed.trim();
        if (t.startsWith('{') && t.endsWith('}')) {
          try {
            parsed = JSON.parse(t) as Record<string, unknown>;
          } catch {
            /* not JSON, ignore */
          }
        }
        const msg = (parsed?.msg as string | undefined) ?? '';
        const candidate = msg || t;

        // Milestone detection — patterns from logger.info + cli.ts console.error markers.
        if (/Starting investigation:/.test(candidate)) {
          const m = candidate.match(/Starting investigation:\s*"([^"]+)"(?:\s*\(geography:\s*([^)]+)\))?/);
          send('stage', {
            stage: 'started',
            objective: m?.[1] ?? objective,
            geography: m?.[2] ?? geography,
          });
        } else if (/WebSearchProvider returned/.test(candidate)) {
          send('provider_done', {
            provider: 'web_search',
            count: Number(parsed?.count ?? 0),
            durationMs: Number(parsed?.durationMs ?? 0),
            query: (parsed?.query as string | undefined) ?? '',
          });
        } else if (/RedditProvider returned/.test(candidate)) {
          send('provider_done', {
            provider: 'reddit_communities',
            count: Number(parsed?.count ?? 0),
            durationMs: Number(parsed?.durationMs ?? 0),
            query: (parsed?.query as string | undefined) ?? '',
          });
        } else if (/WebContentProvider returned/.test(candidate)) {
          send('provider_done', {
            provider: 'web_content',
            count: Number(parsed?.count ?? 0),
            durationMs: Number(parsed?.durationMs ?? 0),
          });
        } else if (/Clustering complete/.test(candidate)) {
          send('stage', {
            stage: 'clustering',
            clusters: Number(parsed?.clusters ?? 0),
            signals: Number(parsed?.signals ?? 0),
          });
        } else if (/Trend detected/.test(candidate)) {
          send('trend', {
            topic: (parsed?.topic as string | undefined) ?? '',
            state: (parsed?.state as string | undefined) ?? '',
            score: Number(parsed?.score ?? 0),
            sources: Number(parsed?.sources ?? 0),
            signals: Number(parsed?.signals ?? 0),
          });
        } else if (/Problem detected/.test(candidate)) {
          send('problem', {
            topic: (parsed?.topic as string | undefined) ?? '',
            severity: Number(parsed?.severity ?? 0),
            frequency: Number(parsed?.frequency ?? 0),
            confidence: Number(parsed?.confidence ?? 0),
            signals: Number(parsed?.signals ?? 0),
          });
        } else if (/Opportunity generated/.test(candidate)) {
          send('opportunity', {
            title: (parsed?.title as string | undefined) ?? '',
            score: Number(parsed?.score ?? 0),
            confidence: Number(parsed?.confidence ?? 0),
            weak: Boolean(parsed?.weak ?? false),
            evidenceCount: Number(parsed?.evidenceCount ?? 0),
          });
        } else if (/Investigation completed/.test(candidate)) {
          const invId = (parsed?.investigationId as string | undefined) ?? '';
          if (invId) investigationId = invId;
          send('stage', {
            stage: 'completed',
            status: (parsed?.status as string | undefined) ?? '',
            signals: Number(parsed?.signals ?? 0),
            trends: Number(parsed?.trends ?? 0),
            problems: Number(parsed?.problems ?? 0),
            opportunities: Number(parsed?.opportunities ?? 0),
            durationMs: Number(parsed?.durationMs ?? 0),
            investigationId: invId,
          });
        } else if (/Reports saved to /.test(candidate)) {
          const m = candidate.match(/Reports saved to\s+(\S+)\/report-(inv_\w+)\.\{md,json\}/);
          if (m) {
            investigationId = m[2];
            send('saved', { investigationId: m[2], path: m[1] });
          } else {
            send('saved', { investigationId, path: candidate });
          }
        }
      };

      const onChunk = (chunk: Buffer, streamName: 'stdout' | 'stderr') => {
        const text = chunk.toString();
        if (streamName === 'stdout') stdoutBuffer += text;
        else stderrBuffer += text;
        const buffer = streamName === 'stdout' ? stdoutBuffer : stderrBuffer;
        const nlIdx = buffer.lastIndexOf('\n');
        if (nlIdx !== -1) {
          const lines = buffer.slice(0, nlIdx).split('\n');
          const remainder = buffer.slice(nlIdx + 1);
          if (streamName === 'stdout') stdoutBuffer = remainder;
          else stderrBuffer = remainder;
          for (const ln of lines) handleLine(ln, streamName);
        }
      };

      child.stdout.on('data', (d: Buffer) => onChunk(d, 'stdout'));
      child.stderr.on('data', (d: Buffer) => onChunk(d, 'stderr'));

      // Safety timeout: kill child after maxRuntimeMs + 30s grace.
      const timeout = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        send('error', {
          message: `Investigation timed out after ${maxRuntimeMs + 30_000}ms`,
          code: 'TIMEOUT',
        });
      }, maxRuntimeMs + 30_000);

      const finalize = (code: number | null) => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abortListener);
        // Flush any trailing buffered lines (no final newline).
        if (stdoutBuffer.length > 0) handleLine(stdoutBuffer, 'stdout');
        if (stderrBuffer.length > 0) handleLine(stderrBuffer, 'stderr');
        send('done', { code: code ?? -1, investigationId });
        closeStream();
      };

      child.on('error', (err) => {
        send('error', { message: err?.message ?? String(err), code: 'SPAWN_ERROR' });
        finalize(-1);
      });

      child.on('close', (code) => {
        finalize(code);
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

/**
 * POST /api/investigate/stream
 * Body: { objective, geography?, maxQueries?, maxRuntimeMs? }
 */
export async function POST(req: NextRequest) {
  // --- Rate limit (per-IP, 5/min) ---------------------------------------
  const ip = getClientIP(req);
  const rl = rateLimit(`stream:${ip}`, LIMITS.stream);
  if (!rl.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
    return apiRateLimited(retryAfter);
  }

  let body: {
    objective?: unknown;
    geography?: unknown;
    maxQueries?: unknown;
    maxRuntimeMs?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return apiBadRequest('Invalid JSON body');
  }
  const { params, error } = parseParams(
    body.objective,
    body.geography,
    body.maxQueries,
    body.maxRuntimeMs,
  );
  if (!params) {
    return apiBadRequest(error ?? 'Invalid params');
  }
  return runInvestigationStream(params, req.signal);
}

/**
 * GET /api/investigate/stream?objective=...&geography=...&maxQueries=N&maxRuntimeMs=N
 *
 * Exists so the browser-native EventSource API can connect (it can only do GET).
 * The React component InvestigationStream uses this.
 */
export async function GET(req: NextRequest) {
  // --- Rate limit (per-IP, 5/min) ---------------------------------------
  const ip = getClientIP(req);
  const rl = rateLimit(`stream:${ip}`, LIMITS.stream);
  if (!rl.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
    return apiRateLimited(retryAfter);
  }

  const url = new URL(req.url);
  const objective = url.searchParams.get('objective') ?? undefined;
  const geography = url.searchParams.get('geography') ?? undefined;
  const maxQueriesRaw = url.searchParams.get('maxQueries');
  const maxRuntimeMsRaw = url.searchParams.get('maxRuntimeMs');
  const { params, error } = parseParams(
    objective,
    geography,
    maxQueriesRaw ?? undefined,
    maxRuntimeMsRaw ?? undefined,
  );
  if (!params) {
    return apiBadRequest(error ?? 'Invalid params');
  }
  return runInvestigationStream(params, req.signal);
}
