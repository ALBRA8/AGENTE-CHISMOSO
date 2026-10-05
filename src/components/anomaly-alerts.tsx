'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  RefreshCw,
  TrendingUp,
  Activity,
} from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

// ---------------------------------------------------------------------------
// TYPES — mirror of the Anomaly shape returned by /api/anomalies.
// Kept local (not imported from @/lib/anomaly-detector) so the client bundle
// doesn't pull in better-sqlite3. The server-side types are the source of
// truth; this interface must stay in sync with them.
// ---------------------------------------------------------------------------

type AnomalyType =
  | 'volume_spike'
  | 'volume_drop'
  | 'velocity_change'
  | 'source_diversification'
  | 'confidence_drift';

type AnomalySeverity = 'low' | 'medium' | 'high';

interface Anomaly {
  id: string;
  topic: string;
  type: AnomalyType;
  severity: AnomalySeverity;
  observedAt: string;
  baseline: {
    mean: number;
    stddev: number;
    windowDays: number;
    samples: number;
  };
  currentValue: number;
  zscore: number;
  description: string;
  recommendedAction: string;
}

interface AnomaliesResponse {
  ranAt: string;
  topic: string | null;
  count: number;
  anomalies: Anomaly[];
}

interface AnomalyAlertsProps {
  /** Optional className for the outer Card. */
  className?: string;
  /** When true, only show medium+high severity (alerts). Default: false (show all). */
  alertsOnly?: boolean;
  /** Override the polling interval (ms). Default: 30000. */
  pollIntervalMs?: number;
}

const DEFAULT_POLL_MS = 30_000;

// Color mapping per task spec:
//   spike=red, drop=blue, velocity=amber, diversification=violet, confidence_drift=sky
const TYPE_BADGE_CLASS: Record<AnomalyType, string> = {
  volume_spike:
    'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300',
  volume_drop:
    'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-700 dark:bg-sky-950 dark:text-sky-300',
  velocity_change:
    'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300',
  source_diversification:
    'border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-700 dark:bg-violet-950 dark:text-violet-300',
  confidence_drift:
    'border-cyan-300 bg-cyan-50 text-cyan-700 dark:border-cyan-700 dark:bg-cyan-950 dark:text-cyan-300',
};

const SEVERITY_BADGE_CLASS: Record<AnomalySeverity, string> = {
  high:
    'border-rose-400 bg-rose-100 text-rose-800 dark:border-rose-600 dark:bg-rose-900 dark:text-rose-200',
  medium:
    'border-amber-400 bg-amber-100 text-amber-800 dark:border-amber-600 dark:bg-amber-900 dark:text-amber-200',
  low:
    'border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300',
};

const TYPE_LABEL: Record<AnomalyType, string> = {
  volume_spike: 'Pico de volumen',
  volume_drop: 'Caída de volumen',
  velocity_change: 'Cambio de velocidad',
  source_diversification: 'Diversificación de fuentes',
  confidence_drift: 'Deriva de confianza',
};

const TYPE_ICON: Record<AnomalyType, typeof TrendingUp> = {
  volume_spike: TrendingUp,
  volume_drop: TrendingUp,
  velocity_change: Activity,
  source_diversification: Bell,
  confidence_drift: AlertTriangle,
};

/**
 * AnomalyAlerts — live feed of statistical anomalies detected by CHISMOSO.
 *
 * Behavior:
 *   - Fetches /api/anomalies on mount.
 *   - Re-fetches every 30s (configurable via pollIntervalMs).
 *   - "Revisar ahora" button triggers an immediate refresh.
 *   - Empty state shows a pulsing dot + "Sin anomalías detectadas. Vigilando...".
 *   - When `alertsOnly` is true, fetches /api/alerts instead and only shows
 *     medium/high severity anomalies.
 *
 * Accessibility:
 *   - Each anomaly card is an <article> with an aria-label derived from
 *     topic + type + severity.
 *   - The pulsing dot in the empty state uses aria-hidden (decorative).
 *   - Refresh button has aria-label.
 */
export function AnomalyAlerts({
  className,
  alertsOnly = false,
  pollIntervalMs = DEFAULT_POLL_MS,
}: AnomalyAlertsProps) {
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const endpoint = alertsOnly ? '/api/alerts' : '/api/anomalies';

  const fetchData = useCallback(
    async (isRefresh: boolean) => {
      if (isRefresh) setRefreshing(true); else setLoading(true);
      setError(null);
      try {
        const res = await fetch(endpoint, { cache: 'no-store' });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const json = (await res.json()) as { anomalies?: Anomaly[]; alerts?: Anomaly[] };
        // /api/anomalies returns `anomalies`; /api/alerts returns `alerts`.
        const list = json.anomalies ?? json.alerts ?? [];
        setAnomalies(list);
        setLastUpdated(new Date().toISOString());
      } catch (e: any) {
        setError(e?.message ?? String(e));
        setAnomalies([]);
      } finally {
        if (isRefresh) setRefreshing(false); else setLoading(false);
      }
    },
    [endpoint],
  );

  useEffect(() => {
    void fetchData(false);
    intervalRef.current = setInterval(() => void fetchData(true), pollIntervalMs);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchData, pollIntervalMs]);

  // Sort by severity (high→medium→low) then by |zscore| desc for visual priority.
  const sorted = useMemo(() => {
    const sevRank: Record<AnomalySeverity, number> = { high: 0, medium: 1, low: 2 };
    return [...anomalies].sort((a, b) => {
      const sa = sevRank[a.severity] ?? 9;
      const sb = sevRank[b.severity] ?? 9;
      if (sa !== sb) return sa - sb;
      return Math.abs(b.zscore) - Math.abs(a.zscore);
    });
  }, [anomalies]);

  const highCount = sorted.filter((a) => a.severity === 'high').length;
  const mediumCount = sorted.filter((a) => a.severity === 'medium').length;

  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2">
              <Bell className="h-4 w-4 shrink-0 text-violet-500" />
              <span>{alertsOnly ? 'Alertas activas' : 'Anomalías detectadas'}</span>
            </CardTitle>
            <CardDescription className="mt-1">
              {loading
                ? 'Verificando…'
                : sorted.length === 0
                  ? 'Vigilando señales en tiempo real'
                  : `${sorted.length} detectadas · ${highCount} altas · ${mediumCount} medias`}
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5"
            onClick={() => void fetchData(true)}
            disabled={refreshing || loading}
            aria-label="Revisar ahora"
            title="Revisar ahora"
          >
            {refreshing
              ? <RefreshCw className="h-4 w-4 animate-spin" />
              : <RefreshCw className="h-4 w-4" />}
            <span className="hidden sm:inline">Revisar ahora</span>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex min-h-[120px] items-center justify-center text-sm text-muted-foreground">
            <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
            Cargando anomalías…
          </div>
        ) : error ? (
          <div className="flex min-h-[120px] items-center justify-center text-sm text-rose-600 dark:text-rose-400">
            Error: {error}
          </div>
        ) : sorted.length === 0 ? (
          <div className="flex min-h-[120px] flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            <span className="relative flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" aria-hidden="true" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500" aria-hidden="true" />
            </span>
            <span>Sin anomalías detectadas. Vigilando…</span>
            {lastUpdated && (
              <span className="text-xs text-muted-foreground/70">
                Última revisión: {relativeTime(lastUpdated)}
              </span>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="max-h-96 space-y-3 overflow-y-auto pr-1 [scrollbar-width:thin]">
              {sorted.map((a) => (
                <AnomalyCard key={a.id} anomaly={a} />
              ))}
            </div>
            {lastUpdated && (
              <div className="text-right text-xs text-muted-foreground/70">
                Última revisión: {relativeTime(lastUpdated)}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// SINGLE ANOMALY CARD
// ---------------------------------------------------------------------------

function AnomalyCard({ anomaly }: { anomaly: Anomaly }) {
  const Icon = TYPE_ICON[anomaly.type] ?? AlertTriangle;
  const ariaLabel = `Anomalía ${TYPE_LABEL[anomaly.type]} en ${anomaly.topic}, severidad ${anomaly.severity}`;
  return (
    <article
      className="rounded-lg border border-border/80 bg-card/60 p-3 transition-colors hover:bg-accent/40"
      aria-label={ariaLabel}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="font-semibold text-foreground">{anomaly.topic}</span>
        <Badge variant="outline" className={TYPE_BADGE_CLASS[anomaly.type]}>
          {TYPE_LABEL[anomaly.type]}
        </Badge>
        <Badge variant="outline" className={SEVERITY_BADGE_CLASS[anomaly.severity]}>
          {anomaly.severity}
        </Badge>
        <span className="ml-auto text-xs text-muted-foreground" title={anomaly.observedAt}>
          {relativeTime(anomaly.observedAt)}
        </span>
      </div>
      <p className="mt-2 text-sm text-foreground/90">{anomaly.description}</p>
      <p className="mt-1 text-xs italic text-muted-foreground">
        Recomendación: {anomaly.recommendedAction}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          z=<strong className="text-foreground">{anomaly.zscore.toFixed(2)}</strong>
        </span>
        <span>
          baseline μ=<strong className="text-foreground">{anomaly.baseline.mean}</strong>,{' '}
          σ=<strong className="text-foreground">{anomaly.baseline.stddev}</strong>
        </span>
        <span>
          actual=<strong className="text-foreground">{anomaly.currentValue}</strong>
        </span>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function relativeTime(iso: string): string {
  try {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return iso;
    const diffMs = Date.now() - t;
    if (diffMs < 0) return 'justo ahora';
    const s = Math.floor(diffMs / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    const d = Math.floor(h / 24);
    return `${d}d`;
  } catch {
    return iso;
  }
}
