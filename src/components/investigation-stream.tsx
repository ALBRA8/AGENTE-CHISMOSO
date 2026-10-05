'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Loader2,
  CheckCircle2,
  AlertTriangle,
  TrendingUp,
  Target,
  Database,
  FileText,
  Save,
  Server,
  Activity,
} from 'lucide-react';

/**
 * InvestigationStream — React client component that consumes the SSE stream
 * from /api/investigate/stream and renders live investigation progress.
 *
 * Usage (parent integrates conditionally when user clicks "Investigate"):
 *
 *   <InvestigationStream
 *     objective={objective}
 *     geography={geography}
 *     maxQueries={maxQueries}
 *     maxRuntimeMs={180_000}
 *     onComplete={({ investigationId }) => fetchReport(investigationId)}
 *     onError={(msg) => setError(msg)}
 *   />
 *
 * The component auto-starts on mount by opening an EventSource to
 * /api/investigate/stream?objective=...&geography=...&maxQueries=N&maxRuntimeMs=N.
 */

export interface StreamEvent {
  type:
    | 'log'
    | 'stage'
    | 'provider_done'
    | 'trend'
    | 'problem'
    | 'opportunity'
    | 'saved'
    | 'done'
    | 'error';
  data: Record<string, unknown>;
  ts: string;
}

interface InvestigationStreamProps {
  objective: string;
  geography: string;
  maxQueries: number;
  maxRuntimeMs?: number;
  onComplete?: (result: { investigationId: string }) => void;
  onError?: (message: string) => void;
}

export function InvestigationStream({
  objective,
  geography,
  maxQueries,
  maxRuntimeMs = 180_000,
  onComplete,
  onError,
}: InvestigationStreamProps) {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isDone, setIsDone] = useState(false);
  const [hasError, setHasError] = useState<string | null>(null);
  const [currentStage, setCurrentStage] = useState<string>('idle');

  const scrollRef = useRef<HTMLDivElement>(null);
  const onCompleteRef = useRef(onComplete);
  const onErrorRef = useRef(onError);
  const finishedRef = useRef(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const pushEvent = useCallback((type: StreamEvent['type'], data: Record<string, unknown>) => {
    setEvents((prev) => {
      // Cap stored events at 500 to avoid unbounded memory growth during long
      // investigations that emit lots of stdout lines (the markdown report).
      const next = prev.length >= 500 ? prev.slice(prev.length - 499) : prev;
      return [...next, { type, data, ts: new Date().toISOString() }];
    });
  }, []);

  const start = useCallback(() => {
    if (!objective.trim()) return;
    if (finishedRef.current) return;
    finishedRef.current = false;

    const params = new URLSearchParams({
      objective: objective.trim(),
      geography: geography.trim() || 'global',
      maxQueries: String(maxQueries),
      maxRuntimeMs: String(maxRuntimeMs),
    });
    const url = `/api/investigate/stream?${params.toString()}`;
    const es = new EventSource(url);
    esRef.current = es;

    // Reset state once the stream is actually open. Doing this in the 'open'
    // callback (async) instead of synchronously in the effect body keeps
    // react-hooks/set-state-in-effect happy and avoids cascading renders.
    es.addEventListener('open', () => {
      setEvents([]);
      setIsRunning(true);
      setIsDone(false);
      setHasError(null);
      setCurrentStage('spawning');
    });

    const finish = (fn?: () => void) => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      try {
        es.close();
      } catch {
        /* ignore */
      }
      setIsRunning(false);
      fn?.();
    };

    const parse = (raw: string | null | undefined): Record<string, unknown> | null => {
      if (!raw) return null;
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return null;
      }
    };

    es.addEventListener('log', (e) => {
      const d = parse((e as MessageEvent).data);
      if (d) pushEvent('log', d);
    });
    es.addEventListener('stage', (e) => {
      const d = parse((e as MessageEvent).data);
      if (d) {
        pushEvent('stage', d);
        const stage = (d.stage as string | undefined) ?? '';
        if (stage) setCurrentStage(stage);
      }
    });
    es.addEventListener('provider_done', (e) => {
      const d = parse((e as MessageEvent).data);
      if (d) pushEvent('provider_done', d);
    });
    es.addEventListener('trend', (e) => {
      const d = parse((e as MessageEvent).data);
      if (d) pushEvent('trend', d);
    });
    es.addEventListener('problem', (e) => {
      const d = parse((e as MessageEvent).data);
      if (d) pushEvent('problem', d);
    });
    es.addEventListener('opportunity', (e) => {
      const d = parse((e as MessageEvent).data);
      if (d) pushEvent('opportunity', d);
    });
    es.addEventListener('saved', (e) => {
      const d = parse((e as MessageEvent).data);
      if (d) pushEvent('saved', d);
    });
    es.addEventListener('done', (e) => {
      const d = parse((e as MessageEvent).data) ?? {};
      pushEvent('done', d);
      const invId = (d.investigationId as string | undefined) ?? 'unknown';
      finish(() => {
        setIsDone(true);
        setCurrentStage('completed');
        onCompleteRef.current?.({ investigationId: invId });
      });
    });
    es.addEventListener('error', (e) => {
      // Two flavors of 'error':
      //   1. Custom event sent by the server with `data` payload — MessageEvent.
      //   2. Native EventSource error (connection drop) — Event with no `data`.
      // We distinguish by checking whether data is a non-empty string.
      if (finishedRef.current) return;
      const me = e as MessageEvent;
      let msg = 'Connection error';
      let data: Record<string, unknown> = { message: msg, code: 'CONNECTION' };
      if (typeof me.data === 'string' && me.data.length > 0) {
        const parsed = parse(me.data);
        if (parsed) {
          data = parsed;
          msg = (parsed.message as string | undefined) ?? msg;
        } else {
          data = { message: me.data, code: 'RAW' };
          msg = me.data;
        }
        pushEvent('error', data);
        finish(() => {
          setHasError(msg);
          setCurrentStage('error');
          onErrorRef.current?.(msg);
        });
      } else if (es.readyState === EventSource.CLOSED) {
        // Server closed connection without sending `done`. Treat as fatal.
        pushEvent('error', { message: 'Stream closed unexpectedly', code: 'CLOSED' });
        finish(() => {
          setHasError('Stream closed unexpectedly');
          setCurrentStage('error');
          onErrorRef.current?.('Stream closed unexpectedly');
        });
      }
      // If readyState is CONNECTING, EventSource is retrying — ignore.
    });

    return () => {
      finish();
    };
  }, [objective, geography, maxQueries, maxRuntimeMs]);

  // Auto-start on mount.
  useEffect(() => {
    const cleanup = start();
    return cleanup;
  }, [start]);

  // Auto-scroll to bottom on new events.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events]);

  const statusBadge = isDone
    ? { label: 'COMPLETED', variant: 'default' as const, cls: 'bg-emerald-600 text-white' }
    : hasError
      ? { label: 'ERROR', variant: 'destructive' as const, cls: '' }
      : isRunning
        ? { label: 'RUNNING', variant: 'secondary' as const, cls: 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300' }
        : { label: 'IDLE', variant: 'secondary' as const, cls: '' };

  return (
    <Card className="w-full">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            {isRunning && <Loader2 className="h-4 w-4 animate-spin text-violet-500" />}
            {isDone && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
            {hasError && <AlertTriangle className="h-4 w-4 text-red-500" />}
            {!isRunning && !isDone && !hasError && <Activity className="h-4 w-4 text-muted-foreground" />}
            <span>Live Investigation Stream</span>
            {isRunning && currentStage !== 'idle' && currentStage !== 'spawning' && (
              <Badge variant="outline" className="text-[10px] font-mono uppercase">
                {currentStage}
              </Badge>
            )}
          </CardTitle>
          <Badge variant={statusBadge.variant} className={`text-[10px] font-bold uppercase ${statusBadge.cls}`}>
            {statusBadge.label}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div
          ref={scrollRef}
          className="max-h-96 overflow-y-auto rounded-md border bg-muted/30 p-3 font-mono text-xs space-y-1"
          aria-live="polite"
          aria-busy={isRunning}
        >
          {events.length === 0 && (
            <div className="flex items-center gap-2 text-muted-foreground italic">
              <Loader2 className="h-3 w-3 animate-spin" />
              Waiting for first event from CHISMOSO orchestrator...
            </div>
          )}
          {events.map((ev, i) => (
            <EventLine key={i} event={ev} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// EventLine — renders a single stream event with appropriate color coding
// ---------------------------------------------------------------------------

function EventLine({ event }: { event: StreamEvent }) {
  switch (event.type) {
    case 'stage': {
      const d = event.data;
      const stage = (d.stage as string | undefined) ?? '';
      const isCompleted = stage === 'completed';
      const isStarted = stage === 'started' || stage === 'spawning';
      const colorCls = isCompleted
        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
        : isStarted
          ? 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300'
          : 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300';
      const parts: string[] = [];
      if (d.objective) parts.push(`objective="${d.objective}"`);
      if (d.geography) parts.push(`geography=${d.geography}`);
      if (typeof d.clusters === 'number') parts.push(`clusters=${d.clusters} signals=${d.signals}`);
      if (d.status) parts.push(`status=${d.status}`);
      if (typeof d.signals === 'number' && typeof d.trends === 'number') {
        parts.push(`signals=${d.signals} trends=${d.trends} problems=${d.problems} opportunities=${d.opportunities}`);
      }
      if (typeof d.durationMs === 'number' && d.durationMs > 0) parts.push(`(${d.durationMs}ms)`);
      return (
        <div className="flex items-start gap-2 py-1">
          <span
            className={`mt-0.5 inline-flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-[10px] font-bold uppercase ${colorCls}`}
          >
            {isCompleted ? <CheckCircle2 className="h-3 w-3" /> : <Loader2 className="h-3 w-3" />}
            {stage}
          </span>
          <span className="text-muted-foreground">{parts.join('  ')}</span>
        </div>
      );
    }

    case 'provider_done': {
      const d = event.data;
      const provider = (d.provider as string | undefined) ?? 'provider';
      const count = (d.count as number | undefined) ?? 0;
      const durationMs = (d.durationMs as number | undefined) ?? 0;
      const query = (d.query as string | undefined) ?? '';
      const Icon = provider === 'web_search' ? Database : provider === 'reddit_communities' ? Server : Database;
      return (
        <div className="flex items-start gap-2 py-0.5 text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" />
          <Icon className="mt-0.5 h-3 w-3 shrink-0 opacity-70" />
          <span className="break-all">
            {provider} returned <span className="font-bold">{count}</span> items ({durationMs}ms)
            {query ? <span className="opacity-70"> — {query}</span> : null}
          </span>
        </div>
      );
    }

    case 'trend': {
      const d = event.data;
      const topic = (d.topic as string | undefined) ?? '';
      const state = (d.state as string | undefined) ?? '';
      const score = (d.score as number | undefined) ?? 0;
      const sources = (d.sources as number | undefined) ?? 0;
      return (
        <div className="flex items-start gap-2 py-0.5 text-sky-600 dark:text-sky-400">
          <TrendingUp className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="break-all">
            trend detected: <span className="font-semibold">{topic}</span> [{state}] score {score}
            <span className="opacity-70"> — {sources} sources</span>
          </span>
        </div>
      );
    }

    case 'problem': {
      const d = event.data;
      const topic = (d.topic as string | undefined) ?? '';
      const severity = (d.severity as number | undefined) ?? 0;
      const frequency = (d.frequency as number | undefined) ?? 0;
      const confidence = (d.confidence as number | undefined) ?? 0;
      return (
        <div className="flex items-start gap-2 py-0.5 text-amber-600 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="break-all">
            problem detected: <span className="font-semibold">{topic}</span> severity {severity}
            <span className="opacity-70"> (freq {frequency}, conf {Math.round(confidence * 100)}%)</span>
          </span>
        </div>
      );
    }

    case 'opportunity': {
      const d = event.data;
      const title = (d.title as string | undefined) ?? '';
      const score = (d.score as number | undefined) ?? 0;
      const weak = (d.weak as boolean | undefined) ?? false;
      const evidenceCount = (d.evidenceCount as number | undefined) ?? 0;
      return (
        <div className="flex items-start gap-2 py-0.5 font-bold text-emerald-700 dark:text-emerald-300">
          <Target className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="break-all">
            opportunity: {title} — score {score}
            {weak ? <span className="opacity-70"> (weak)</span> : null}
            <span className="opacity-70"> ({evidenceCount} evidence)</span>
          </span>
        </div>
      );
    }

    case 'saved': {
      const d = event.data;
      const id = (d.investigationId as string | undefined) ?? 'unknown';
      const path = (d.path as string | undefined) ?? '';
      return (
        <div className="flex items-start gap-2 py-0.5 text-emerald-600 dark:text-emerald-400">
          <Save className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="break-all text-[10px]">
            saved {id} <span className="opacity-70">→ {path}</span>
          </span>
        </div>
      );
    }

    case 'done': {
      const d = event.data;
      const code = (d.code as number | undefined) ?? -1;
      const id = (d.investigationId as string | undefined) ?? 'unknown';
      return (
        <div className="mt-2 flex items-start gap-2 border-t pt-2">
          <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
            <CheckCircle2 className="h-3 w-3" />
            done
          </span>
          <span className="text-muted-foreground">
            code={code}  investigationId=<span className="font-mono">{id}</span>
          </span>
        </div>
      );
    }

    case 'error': {
      const d = event.data;
      const message = (d.message as string | undefined) ?? 'Unknown error';
      const code = (d.code as string | undefined) ?? '';
      return (
        <div className="flex items-start gap-2 py-0.5 font-bold text-red-600 dark:text-red-400">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="break-all">
            error: {message}
            {code ? <span className="opacity-70"> [{code}]</span> : null}
          </span>
        </div>
      );
    }

    case 'log':
    default: {
      const d = event.data;
      const line = (d.line as string | undefined) ?? JSON.stringify(d);
      const stream = (d.stream as string | undefined) ?? '';
      const streamCls =
        stream === 'stderr'
          ? 'text-amber-700/70 dark:text-amber-500/70'
          : 'text-muted-foreground/70';
      return (
        <div className={`whitespace-pre-wrap break-all ${streamCls}`}>
          {line}
        </div>
      );
    }
  }
}
