'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { TrendingUp, RefreshCw, Loader2 } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface Observation {
  observed_at: string;
  sources_count: number;
  signals_count: number;
  evidence_count: number;
  confidence: number | null;
  note: string | null;
}

interface TopicHistoryResponse {
  topic: string;
  history: Observation[];
}

interface TopicsEvolutionProps {
  /** Canonical topic name. Will be URL-encoded before fetching. */
  topic: string;
  /** Optional className for the outer card. */
  className?: string;
}

const VIEW_W = 300;
const VIEW_H = 120;
const PAD_L = 8;
const PAD_R = 8;
const PAD_T = 8;
const PAD_B = 18;
const PLOT_W = VIEW_W - PAD_L - PAD_R;
const PLOT_H = VIEW_H - PAD_T - PAD_B;
const VIOLET = '#8b5cf6';
const VIOLET_SOFT = 'rgba(139, 92, 246, 0.15)';

/**
 * TopicsEvolution — temporal evolution chart for a single CHISMOSO topic.
 *
 * Fetches `/api/topics/[topic]` on mount, renders an inline SVG line chart
 * of `signals_count` over time (last 30 observations), shows the latest
 * confidence as a badge, and exposes a refresh button.
 *
 * Hand-rolled SVG (no recharts/visx dependency) — polyline points are
 * computed manually from the history array.
 */
export function TopicsEvolution({ topic, className }: TopicsEvolutionProps) {
  const [history, setHistory] = useState<Observation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const url = `/api/topics/${encodeURIComponent(topic)}?limit=30`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = (await res.json()) as TopicHistoryResponse;
      setHistory(json.history ?? []);
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setHistory([]);
    } finally {
      if (isRefresh) setRefreshing(false); else setLoading(false);
    }
  }, [topic]);

  useEffect(() => {
    void fetchData(false);
  }, [fetchData]);

  // Compute polyline points + scales. We memoize so a refresh that returns
  // identical data doesn't cause a re-render of the path string.
  const { points, areaPath, latest, peak, firstDate, lastDate } = useMemo(() => {
    const rows = history.slice(-30);
    const n = rows.length;
    if (n === 0) {
      return {
        points: '',
        areaPath: '',
        latest: null as Observation | null,
        peak: 0,
        firstDate: '',
        lastDate: '',
      };
    }
    const maxSig = Math.max(1, ...rows.map((r) => r.signals_count));
    const peak = maxSig;
    const xFor = (i: number) => PAD_L + (n === 1 ? PLOT_W / 2 : (PLOT_W * i) / (n - 1));
    const yFor = (v: number) => PAD_T + PLOT_H - (PLOT_H * v) / Math.max(1, peak);

    const coords = rows.map((r, i) => ({ x: xFor(i), y: yFor(r.signals_count) }));
    const points = coords.map((c) => `${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(' ');
    const areaPath = coords.length > 0
      ? `M ${coords[0].x.toFixed(2)} ${(PAD_T + PLOT_H).toFixed(2)} ` +
        coords.map((c) => `L ${c.x.toFixed(2)} ${c.y.toFixed(2)}`).join(' ') +
        ` L ${coords[coords.length - 1].x.toFixed(2)} ${(PAD_T + PLOT_H).toFixed(2)} Z`
      : '';

    const latest = rows[rows.length - 1] ?? null;
    const firstDate = rows[0] ? shortDate(rows[0].observed_at) : '';
    const lastDate = rows[rows.length - 1] ? shortDate(rows[rows.length - 1].observed_at) : '';

    return { points, areaPath, latest, peak, firstDate, lastDate };
  }, [history]);

  const confidencePct = latest?.confidence != null
    ? Math.round(latest.confidence * 100)
    : null;

  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 truncate">
              <TrendingUp className="h-4 w-4 shrink-0 text-violet-500" />
              <span className="truncate">{topic}</span>
            </CardTitle>
            <CardDescription className="mt-1">
              Signal evolution · last {history.length || 0} observations
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {confidencePct != null && (
              <Badge
                variant="secondary"
                className={
                  confidencePct >= 60
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                    : confidencePct >= 30
                      ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300'
                      : 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300'
                }
                title="Latest confidence reading"
              >
                {confidencePct}% conf
              </Badge>
            )}
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => void fetchData(true)}
              disabled={refreshing || loading}
              aria-label="Refresh topic history"
              title="Refresh"
            >
              {refreshing
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <RefreshCw className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex h-[120px] items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading...
          </div>
        ) : error ? (
          <div className="flex h-[120px] items-center justify-center text-sm text-rose-600 dark:text-rose-400">
            Error: {error}
          </div>
        ) : history.length === 0 ? (
          <div className="flex h-[120px] items-center justify-center text-sm text-muted-foreground">
            No observations yet for this topic.
          </div>
        ) : (
          <>
            <svg
              viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
              width="100%"
              height={VIEW_H}
              role="img"
              aria-label={`Signal count over time for ${topic}`}
              className="overflow-visible"
            >
              {/* baseline */}
              <line
                x1={PAD_L}
                y1={PAD_T + PLOT_H}
                x2={PAD_L + PLOT_W}
                y2={PAD_T + PLOT_H}
                stroke="currentColor"
                strokeOpacity="0.2"
                strokeWidth="1"
              />
              {/* area under curve (soft fill) */}
              {areaPath && <path d={areaPath} fill={VIOLET_SOFT} />}
              {/* the actual line */}
              {points && (
                <polyline
                  points={points}
                  fill="none"
                  stroke={VIOLET}
                  strokeWidth="2"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              )}
              {/* end-point dot */}
              {(() => {
                const last = points.split(' ').pop();
                if (!last) return null;
                const [cx, cy] = last.split(',').map(Number);
                return (
                  <circle
                    cx={cx}
                    cy={cy}
                    r={3.5}
                    fill={VIOLET}
                    stroke="white"
                    strokeWidth="1.5"
                  />
                );
              })()}
              {/* axis labels: first / last observation date */}
              {firstDate && (
                <text
                  x={PAD_L}
                  y={VIEW_H - 4}
                  fontSize="9"
                  fill="currentColor"
                  fillOpacity="0.55"
                >
                  {firstDate}
                </text>
              )}
              {lastDate && (
                <text
                  x={PAD_L + PLOT_W}
                  y={VIEW_H - 4}
                  fontSize="9"
                  textAnchor="end"
                  fill="currentColor"
                  fillOpacity="0.55"
                >
                  {lastDate}
                </text>
              )}
            </svg>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>
                Latest signals: <strong className="text-foreground">{latest?.signals_count ?? 0}</strong>
              </span>
              <span>
                Peak signals: <strong className="text-foreground">{peak}</strong>
              </span>
              <span>
                Sources: <strong className="text-foreground">{latest?.sources_count ?? 0}</strong>
              </span>
              {latest?.note && (
                <span>
                  State: <strong className="text-foreground">{latest.note}</strong>
                </span>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function shortDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${month}-${day} ${hh}:${mm}`;
  } catch {
    return iso.slice(0, 16);
  }
}
