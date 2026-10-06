'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import {
  Activity,
  Target,
  TrendingUp,
  Server,
  Bell,
  Network,
  Database,
  CheckCircle2,
  XCircle,
  Sparkles,
  Play,
  FileText,
  RefreshCw,
  ArrowRight,
} from 'lucide-react';

/**
 * DashboardSummary
 *
 * Landing dashboard shown when the user has NOT yet selected / run an
 * investigation. Aggregates data from 5 endpoints and renders a 2×2 grid
 * of cards on desktop, stacked on mobile:
 *
 *   1. Overview stats   — investigations / providers OK / anomalies / mesh
 *   2. Latest opportunities — top 3 across all investigations (by score)
 *   3. Top trending topics   — top 5 by observation count
 *   4. Quick start tips      — small "how to use" guide
 *
 * All fetches are defensive: if any endpoint 5xx's or returns a bad shape
 * (e.g. /api/mesh/config when the DB is cold), we render a "—" instead of
 * crashing the whole dashboard.
 */

// ---------------------------------------------------------------------------
// Types — kept local so we don't depend on API route exports
// ---------------------------------------------------------------------------

interface InvestigationSummary {
  id: string;
  query: string;
  scope: string;
  startedAt: string;
  status: string;
  signalsFound: number;
  evidenceFound: number;
  trendsFound: number;
  problemsFound: number;
  opportunitiesFound: number;
}

interface ProviderInfo {
  name: string;
  type: string;
  capabilities: string[];
  status: string;
  health: string;
}

interface AnomalyResponse {
  count: number;
  anomalies: Array<{ id?: string }>;
}

interface MeshConfigResponse {
  enabled?: boolean;
  subscribers?: Array<{ agentName?: string }>;
  error?: string;
}

interface TopicItem {
  canonical: string;
  lastSeen: string;
  observationCount: number;
  sourcesCount: number;
  latestConfidence: number | null;
}

interface OpportunitySummary {
  id?: string;
  title?: string;
  score?: number;
  confidence?: number;
  suggestedNextAgent?: string;
  description?: string;
}

interface InvestigationDetail {
  id: string;
  machine: { opportunities?: OpportunitySummary[] } | null;
  markdown?: string;
}

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

function StatTile({
  icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-3 flex flex-col gap-1 min-w-0">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className={`text-2xl font-semibold tabular-nums ${accent ?? ''}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground truncate">{sub}</div>}
    </div>
  );
}

function MiniOppCard({ opp, query }: { opp: OpportunitySummary; query?: string }) {
  const score = opp.score ?? 0;
  const conf = Math.round((opp.confidence ?? 0) * 100);
  return (
    <li className="rounded-md border p-2.5 hover:bg-accent/40 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium line-clamp-2 flex-1 min-w-0">
          {opp.title ?? '(sin título)'}
        </span>
        <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200 shrink-0 text-[10px] py-0 px-1.5">
          {score}/100
        </Badge>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
        <span>conf. {conf}%</span>
        {opp.suggestedNextAgent && (
          <>
            <span>·</span>
            <code className="font-mono">{opp.suggestedNextAgent}</code>
          </>
        )}
      </div>
      {query && (
        <div className="mt-1 text-[10px] text-muted-foreground/80 line-clamp-1">
          <FileText className="h-2.5 w-2.5 inline mr-1 align-text-bottom" />
          {query}
        </div>
      )}
    </li>
  );
}

function TopicRow({ topic }: { topic: TopicItem }) {
  const conf = topic.latestConfidence;
  const confPct = conf !== null && conf !== undefined ? Math.round(conf * 100) : null;
  return (
    <li className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-accent/40 transition-colors">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium truncate">{topic.canonical}</div>
        <div className="text-[10px] text-muted-foreground">
          {topic.observationCount} obs · {topic.sourcesCount} fuentes
        </div>
      </div>
      {confPct !== null ? (
        <Badge variant="outline" className="text-[10px] py-0 px-1.5 tabular-nums">
          {confPct}%
        </Badge>
      ) : (
        <span className="text-[10px] text-muted-foreground/60">—</span>
      )}
    </li>
  );
}

function Spinner({ className }: { className?: string }) {
  return <RefreshCw className={`h-3 w-3 animate-spin ${className ?? ''}`} />;
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

// Limit how many detail fetches we fan out — keep the dashboard snappy even
// when the user has dozens of past investigations.
const MAX_DETAIL_FETCHES = 5;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DashboardSummary({ onOpenChat }: { onOpenChat?: () => void }) {
  const [investigations, setInvestigations] = useState<InvestigationSummary[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [anomalyCount, setAnomalyCount] = useState<number | null>(null);
  const [anomalyFailed, setAnomalyFailed] = useState(false);
  const [mesh, setMesh] = useState<MeshConfigResponse | null>(null);
  const [meshFailed, setMeshFailed] = useState(false);
  const [topics, setTopics] = useState<TopicItem[]>([]);
  const [topicsFailed, setTopicsFailed] = useState(false);
  const [topOpps, setTopOpps] = useState<Array<OppportunityWithQuery>>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    // Fire the 4 independent calls in parallel — the opportunities fetch
    // depends on the investigations list, so it runs as a follow-up.
    const [invRes, provRes, anomRes, meshRes, topRes] = await Promise.all([
      fetchJson<{ investigations: InvestigationSummary[] }>('/api/investigations'),
      fetchJson<{ providers: ProviderInfo[] }>('/api/providers'),
      fetchJson<AnomalyResponse>('/api/anomalies'),
      fetchJson<MeshConfigResponse>('/api/mesh/config'),
      fetchJson<{ topics: TopicItem[] }>('/api/topics'),
    ]);

    const invList = invRes?.investigations ?? [];
    const provList = provRes?.providers ?? [];
    setAnomalyFailed(anomRes === null);
    const anCnt = anomRes?.count ?? anomRes?.anomalies?.length ?? 0;
    setMeshFailed(meshRes === null);
    setTopicsFailed(topRes === null);
    const topList = (topRes?.topics ?? []).slice().sort(
      (a, b) => (b.observationCount ?? 0) - (a.observationCount ?? 0),
    );

    setInvestigations(invList);
    setProviders(provList);
    setAnomalyCount(anCnt);
    setMesh(meshRes);
    setTopics(topList.slice(0, 5));

    // Fan out: fetch detail for the N most recent investigations so we can
    // extract top opportunities across all of them.
    try {
      const recent = invList.slice(0, MAX_DETAIL_FETCHES);
      const details = await Promise.all(
        recent.map((inv) => fetchJson<InvestigationDetail>(`/api/investigations/${inv.id}`)),
      );
      const allOpps: Array<OppportunityWithQuery> = [];
      details.forEach((d, idx) => {
        if (!d?.machine?.opportunities) return;
        const query = invList[idx]?.query;
        for (const opp of d.machine.opportunities) {
          allOpps.push({ ...opp, _query: query });
        }
      });
      allOpps.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      setTopOpps(allOpps.slice(0, 3));
    } catch {
      setTopOpps([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------

  const providersOk = providers.filter((p) => p.health === 'OK').length;
  const meshEnabled = Boolean(mesh?.enabled);
  const meshSubs = mesh?.subscribers?.length ?? 0;
  const hasInvestigations = investigations.length > 0;
  const hasTopics = topics.length > 0;
  const hasOpps = topOpps.length > 0;

  return (
    <div className="space-y-4">
      {/* AGENT-3: Chat CTA banner — surfaces the conversational agent */}
      {onOpenChat && (
        <button
          type="button"
          onClick={onOpenChat}
          className="group w-full text-left rounded-lg border border-violet-200 dark:border-violet-900/60 bg-violet-50 dark:bg-violet-950/30 hover:bg-violet-100 dark:hover:bg-violet-900/50 transition-colors px-3 py-2.5 flex items-center gap-2 shadow-sm"
          aria-label="Abrir chat con CHISMOSO"
        >
          <span className="text-base leading-none" aria-hidden>💡</span>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-violet-900 dark:text-violet-100">
              Tip: Habla con CHISMOSO
            </div>
            <div className="text-[10px] text-violet-700/80 dark:text-violet-300/70 truncate">
              Pregunta por tendencias, anomalías o investigaciones en lenguaje natural.
            </div>
          </div>
          <ArrowRight className="h-3.5 w-3.5 text-violet-500 group-hover:translate-x-0.5 transition-transform shrink-0" />
        </button>
      )}

      {/* Section header */}
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-violet-500" />
            Resumen del sistema
          </h2>
          <p className="text-[11px] text-muted-foreground">
            Estado global de CHISMOSO · investigaciones, providers, anomalías y mesh en una sola mirada.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setRefreshKey((k) => k + 1)}
          disabled={loading}
          className="h-7 px-2 text-[11px]"
        >
          {loading ? <Spinner /> : <RefreshCw className="h-3 w-3" />}
          <span className="ml-1.5 hidden sm:inline">Refrescar</span>
        </Button>
      </div>

      {/* 2x2 grid (desktop) / stacked (mobile) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* ------------------------------------------------------------- */}
        {/* Card 1 — Overview stats */}
        {/* ------------------------------------------------------------- */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Activity className="h-4 w-4 text-muted-foreground" />
              Estado general
            </CardTitle>
            <CardDescription className="text-[11px]">
              Investigaciones, providers saludables, anomalías activas y mesh multi-agente.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2.5">
              <StatTile
                icon={<Database className="h-3 w-3" />}
                label="Investigaciones"
                value={loading && investigations.length === 0 ? <Spinner /> : investigations.length}
                sub={hasInvestigations ? `${investigations[0]?.status ?? ''}` : 'ninguna aún'}
                accent="text-violet-600"
              />
              <StatTile
                icon={<Server className="h-3 w-3" />}
                label="Providers OK"
                value={loading && providers.length === 0 ? <Spinner /> : `${providersOk}/${providers.length}`}
                sub={providers.length === 0 ? 'sin providers' : `${providers.length} registrados`}
                accent="text-emerald-600"
              />
              <StatTile
                icon={<Bell className="h-3 w-3" />}
                label="Anomalías activas"
                value={
                  anomalyCount === null && loading ? (
                    <Spinner />
                  ) : anomalyFailed ? (
                    '—'
                  ) : (
                    anomalyCount ?? 0
                  )
                }
                sub={
                  anomalyFailed
                    ? 'endpoint caído'
                    : anomalyCount === null
                      ? 'sin datos'
                      : anomalyCount > 0
                        ? 'revisar panel'
                        : 'sistema estable'
                }
                accent={anomalyFailed ? '' : anomalyCount && anomalyCount > 0 ? 'text-amber-600' : 'text-emerald-600'}
              />
              <StatTile
                icon={<Network className="h-3 w-3" />}
                label="Mesh"
                value={
                  mesh === null && loading ? (
                    <Spinner />
                  ) : meshFailed ? (
                    '—'
                  ) : meshEnabled ? (
                    <span className="flex items-center gap-1">
                      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                      On
                    </span>
                  ) : (
                    <span className="flex items-center gap-1">
                      <XCircle className="h-4 w-4 text-muted-foreground" />
                      Off
                    </span>
                  )
                }
                sub={
                  meshFailed
                    ? 'endpoint caído'
                    : meshSubs > 0
                      ? `${meshSubs} suscriptores`
                      : 'sin suscriptores'
                }
                accent={meshFailed ? '' : meshEnabled ? 'text-emerald-600' : ''}
              />
            </div>
          </CardContent>
        </Card>

        {/* ------------------------------------------------------------- */}
        {/* Card 2 — Latest opportunities (top 3) */}
        {/* ------------------------------------------------------------- */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Target className="h-4 w-4 text-muted-foreground" />
              Oportunidades destacadas
            </CardTitle>
            <CardDescription className="text-[11px]">
              Top 3 por score entre las investigaciones más recientes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading && !hasOpps ? (
              <div className="space-y-2">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : hasOpps ? (
              <ul className="space-y-2 max-h-72 overflow-y-auto pr-1">
                {topOpps.map((opp, i) => (
                  <MiniOppCard key={(opp.id ?? '') + i} opp={opp} query={opp._query} />
                ))}
              </ul>
            ) : (
              <div className="text-xs text-muted-foreground py-6 text-center border rounded-md">
                Aún no hay oportunidades. Ejecuta tu primera investigación arriba.
              </div>
            )}
          </CardContent>
        </Card>

        {/* ------------------------------------------------------------- */}
        {/* Card 3 — Top trending topics (top 5) */}
        {/* ------------------------------------------------------------- */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
              Topics en vigilancia
            </CardTitle>
            <CardDescription className="text-[11px]">
              Top 5 topics por número de observaciones registradas.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading && !hasTopics ? (
              <div className="space-y-2">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : topicsFailed ? (
              <div className="text-xs text-muted-foreground py-6 text-center border rounded-md">
                El endpoint <code className="font-mono">/api/topics</code> está caído.
                <br />
                Intenta refrescar en unos segundos.
              </div>
            ) : hasTopics ? (
              <ol className="space-y-1 max-h-72 overflow-y-auto pr-1">
                {topics.map((t, i) => (
                  <TopicRow key={t.canonical + i} topic={t} />
                ))}
              </ol>
            ) : (
              <div className="text-xs text-muted-foreground py-6 text-center border rounded-md">
                Sin topics observados todavía.
              </div>
            )}
          </CardContent>
        </Card>

        {/* ------------------------------------------------------------- */}
        {/* Card 4 — Quick start tips */}
        {/* ------------------------------------------------------------- */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Play className="h-4 w-4 text-muted-foreground" />
              Cómo empezar
            </CardTitle>
            <CardDescription className="text-[11px]">
              Guía rápida para tus primeras investigaciones con CHISMOSO.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="space-y-2.5">
              <TipStep
                n={1}
                title="Define un objetivo"
                body="Escribe en lenguaje natural qué quieres investigar. Cuanto más concreto, mejor — ej: «automatización de pequeños restaurantes en Colombia»."
              />
              <TipStep
                n={2}
                title="Elige el modo"
                body="ReAct (en vivo) te muestra cada paso del agente en tiempo real. Sync (clásico) espera y devuelve el reporte al final."
              />
              <TipStep
                n={3}
                title="Revisa el reporte"
                body="CHISMOSO devuelve señales, tendencias, problemas y oportunidades con score accionable. La pestaña «Reporte» muestra el documento completo en markdown."
              />
              <TipStep
                n={4}
                title="Vigila continuamente"
                body="Usa el panel derecho para ver anomalías, evolución de topics, mesh multi-agente y búsqueda semántica sobre señales acumuladas."
              />
            </ol>
            <div className="mt-3 flex items-center gap-1.5 text-[10px] text-muted-foreground/80 border-t pt-2">
              <ArrowRight className="h-3 w-3" />
              <span>Empieza escribiendo tu objetivo en el formulario de arriba.</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

type OppportunityWithQuery = OpportunitySummary & { _query?: string };

function TipStep({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <li className="flex gap-2.5">
      <span className="shrink-0 h-5 w-5 rounded-full bg-violet-100 dark:bg-violet-900/60 text-violet-700 dark:text-violet-300 text-[10px] font-semibold flex items-center justify-center mt-0.5">
        {n}
      </span>
      <div className="min-w-0">
        <div className="text-xs font-medium">{title}</div>
        <p className="text-[11px] text-muted-foreground leading-relaxed">{body}</p>
      </div>
    </li>
  );
}
