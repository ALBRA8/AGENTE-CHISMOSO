'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Radar,
  Activity,
  Database,
  Loader2,
  Play,
  RefreshCw,
  ChevronRight,
  CircleDot,
  TrendingUp,
  AlertTriangle,
  Target,
  FileText,
  Server,
  CheckCircle2,
  XCircle,
  Clock,
  Sparkles,
  Zap,
  Bell,
  Search,
  Network,
} from 'lucide-react';
import { InvestigationStream } from '@/components/investigation-stream';
import { AnomalyAlerts } from '@/components/anomaly-alerts';
import { TopicsEvolution } from '@/components/topics-evolution';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { DashboardSummary } from '@/components/dashboard-summary';
// AGENT-3: Chat agent integration — floating sidebar + toggle button
import { ChatAgent } from '@/components/chat-agent';
import { ChatToggle } from '@/components/chat-toggle';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProviderInfo {
  name: string;
  type: string;
  capabilities: string[];
  status: string;
  limits: { requestsPerMinute?: number; maxResultsPerCall?: number };
  authentication: string;
  health: string;
}

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

interface MachineReport {
  investigationId: string;
  query: string;
  scope: string;
  generatedAt: string;
  executiveSummary: string;
  overallConfidence: number;
  limitations: string[];
  recommendedNextAction: string;
  providersUsed: string[];
  trends: any[];
  problems: any[];
  opportunities: any[];
  signals: any[];
  evidence: any[];
}

interface InvestigateResponse {
  ok: boolean;
  status: string;
  investigationId: string;
  counts?: {
    signals: number;
    trends: number;
    problems: number;
    opportunities: number;
  };
  report: {
    investigationId: string;
    status: string;
    markdown: string;
    machine: MachineReport;
  };
  log: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusColor(status: string): string {
  switch (status) {
    case 'COMPLETED': return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200';
    case 'PARTIAL': return 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200';
    case 'INSUFFICIENT_EVIDENCE': return 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200';
    case 'FAILED': return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200';
    case 'RUNNING': return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200';
    default: return 'bg-muted text-muted-foreground';
  }
}

function healthColor(health: string): string {
  switch (health) {
    case 'OK': return 'bg-emerald-500';
    case 'DEGRADED': return 'bg-amber-500';
    case 'UNAVAILABLE': return 'bg-red-500';
    case 'AUTH_REQUIRED': return 'bg-orange-500';
    case 'RATE_LIMITED': return 'bg-yellow-500';
    default: return 'bg-muted';
  }
}

function formatDate(iso: string): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString('es-CO', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function ProvidersPanel({ providers, loading, onRefresh }: {
  providers: ProviderInfo[];
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <Card className="w-full">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Server className="h-4 w-4 text-muted-foreground" />
            Providers
          </CardTitle>
          <CardDescription className="text-xs">
            Fuentes de datos registradas en CHISMOSO V1
          </CardDescription>
        </div>
        <Button variant="ghost" size="icon" onClick={onRefresh} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </CardHeader>
      <CardContent>
        {loading && providers.length === 0 ? (
          <div className="text-sm text-muted-foreground py-4 flex items-center justify-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Cargando providers...
          </div>
        ) : providers.length === 0 ? (
          <div className="text-sm text-muted-foreground py-4 text-center">
            No se pudieron cargar los providers.
          </div>
        ) : (
          <ul className="space-y-2 max-h-72 overflow-y-auto pr-1">
            {providers.map((p) => (
              <li
                key={p.name}
                className="rounded-md border p-2.5 hover:bg-accent/40 transition-colors"
              >
                <div className="flex items-center justify-between gap-2">
                  <code className="text-xs font-mono">{p.name}</code>
                  <div className="flex items-center gap-1.5">
                    <span className={`h-2 w-2 rounded-full ${healthColor(p.health)}`} />
                    <Badge variant="outline" className="text-[10px] py-0 px-1.5">{p.health}</Badge>
                  </div>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                  <span className="font-mono">{p.type}</span>
                  <span>·</span>
                  <span>{p.capabilities.join(', ')}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function InvestigationsPanel({ investigations, loading, onRefresh, onSelect, selectedId }: {
  investigations: InvestigationSummary[];
  loading: boolean;
  onRefresh: () => void;
  onSelect: (id: string) => void;
  selectedId?: string;
}) {
  return (
    <Card className="w-full">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Database className="h-4 w-4 text-muted-foreground" />
            Investigaciones previas
          </CardTitle>
          <CardDescription className="text-xs">
            Reportes guardados en disco
          </CardDescription>
        </div>
        <Button variant="ghost" size="icon" onClick={onRefresh} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </CardHeader>
      <CardContent>
        {loading && investigations.length === 0 ? (
          <div className="text-sm text-muted-foreground py-4 flex items-center justify-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Cargando...
          </div>
        ) : investigations.length === 0 ? (
          <div className="text-sm text-muted-foreground py-6 text-center">
            Todavía no hay investigaciones guardadas.
          </div>
        ) : (
          <ul className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
            {investigations.map((inv) => (
              <li key={inv.id}>
                <button
                  onClick={() => onSelect(inv.id)}
                  className={`w-full text-left rounded-md border p-2 hover:bg-accent/60 transition-colors ${
                    selectedId === inv.id ? 'border-primary bg-accent/60' : ''
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs font-medium line-clamp-2 flex-1">{inv.query || '(sin query)'}</span>
                    <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0 mt-0.5" />
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                    <Badge className={`text-[9px] py-0 px-1 ${statusColor(inv.status)}`} variant="secondary">
                      {inv.status}
                    </Badge>
                    <span>{inv.signalsFound} sig</span>
                    <span>·</span>
                    <span>{inv.trendsFound} trends</span>
                    <span>·</span>
                    <span>{inv.opportunitiesFound} opps</span>
                  </div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground">{formatDate(inv.startedAt)}</div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function StatsGrid({ report }: { report: MachineReport | null }) {
  if (!report) return null;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <StatCard
        icon={<Activity className="h-4 w-4" />}
        label="Señales"
        value={report.signals?.length ?? 0}
        accent="text-sky-600"
      />
      <StatCard
        icon={<TrendingUp className="h-4 w-4" />}
        label="Tendencias"
        value={report.trends?.length ?? 0}
        accent="text-violet-600"
      />
      <StatCard
        icon={<AlertTriangle className="h-4 w-4" />}
        label="Problemas"
        value={report.problems?.length ?? 0}
        accent="text-amber-600"
      />
      <StatCard
        icon={<Target className="h-4 w-4" />}
        label="Oportunidades"
        value={report.opportunities?.length ?? 0}
        accent="text-emerald-600"
      />
    </div>
  );
}

function StatCard({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: number; accent?: string }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        {icon} {label}
      </div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${accent ?? ''}`}>{value}</div>
    </div>
  );
}

function OpportunityCard({ opp }: { opp: any }) {
  const breakdown = opp.scoreBreakdown ?? {};
  return (
    <Card className="border-l-4 border-l-emerald-500">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm leading-snug line-clamp-2">{opp.title}</CardTitle>
          <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200 shrink-0">
            {opp.score}/100
          </Badge>
        </div>
        <CardDescription className="text-xs">
          Confianza: {Math.round((opp.confidence ?? 0) * 100)}% · Siguiente agente:{' '}
          <code className="font-mono">{opp.suggestedNextAgent}</code>
        </CardDescription>
      </CardHeader>
      <CardContent className="text-xs space-y-2">
        <p className="text-muted-foreground line-clamp-3">{opp.description}</p>
        {opp.problem && (
          <div className="rounded bg-amber-50 dark:bg-amber-950/30 p-2 text-amber-900 dark:text-amber-100">
            <span className="font-semibold">Problema:</span>{' '}
            <span className="line-clamp-2">{opp.problem}</span>
          </div>
        )}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5">
          {[
            ['Demand', breakdown.demand],
            ['Growth', breakdown.growth],
            ['Problem', breakdown.problemSeverity],
            ['Monetization', breakdown.monetization],
            ['Timing', breakdown.timing],
            ['Market fit', breakdown.marketFit],
            ['Competition', breakdown.competition],
            ['Uncertainty', breakdown.uncertainty],
          ].map(([label, val]) => (
            <div key={label as string} className="rounded border bg-muted/30 p-1.5">
              <div className="text-[9px] uppercase text-muted-foreground">{label}</div>
              <div className="text-sm font-mono tabular-nums">{val as number ?? '—'}</div>
            </div>
          ))}
        </div>
        {Array.isArray(opp.evidence) && opp.evidence.length > 0 && (
          <details className="text-[10px] text-muted-foreground">
            <summary className="cursor-pointer hover:text-foreground">
              {opp.evidence.length} evidencias
            </summary>
            <ul className="mt-1 space-y-1 max-h-32 overflow-y-auto">
              {opp.evidence.slice(0, 10).map((e: any, i: number) => (
                <li key={i} className="border-l-2 border-muted pl-2">
                  <div className="flex items-center gap-1">
                    <Badge variant="outline" className="text-[9px] py-0 px-1">{e.evidenceType}</Badge>
                    <span className="font-mono">{e.source}</span>
                  </div>
                  <p className="line-clamp-2 mt-0.5">{e.rawValue ?? e.normalizedValue}</p>
                  {e.url && (
                    <a
                      href={e.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[9px] text-sky-600 hover:underline break-all"
                    >
                      {e.url}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

function TrendCard({ trend }: { trend: any }) {
  const stateColor = (() => {
    switch (trend.state) {
      case 'STRONG_TREND': return 'bg-violet-100 text-violet-800 dark:bg-violet-900 dark:text-violet-200';
      case 'EMERGING_TREND': return 'bg-sky-100 text-sky-800 dark:bg-sky-900 dark:text-sky-200';
      case 'WEAK_SIGNAL': return 'bg-muted text-muted-foreground';
      case 'NOISE': return 'bg-muted/50 text-muted-foreground/70';
      case 'ESTABLISHED_TREND': return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200';
      case 'DECLINING_TREND': return 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200';
      default: return 'bg-muted text-muted-foreground';
    }
  })();
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm leading-snug">{trend.topic}</CardTitle>
          <div className="flex flex-col gap-1 items-end">
            <Badge className={stateColor} variant="secondary">{trend.state?.replace(/_/g, ' ')}</Badge>
            <span className="text-xs font-mono tabular-nums">{trend.score}/100</span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="text-xs space-y-2">
        <p className="text-muted-foreground">{trend.description}</p>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-1.5">
          {[
            ['Growth', trend.growth],
            ['Velocity', trend.velocity],
            ['Persistence', trend.persistence],
            ['Cross-src', trend.crossSourceConfirmation],
            ['Confidence', trend.confidence !== undefined ? Math.round(trend.confidence * 100) / 100 : null],
          ].map(([label, val]) => (
            <div key={label as string} className="rounded border bg-muted/30 p-1.5">
              <div className="text-[9px] uppercase text-muted-foreground">{label}</div>
              <div className="text-sm font-mono tabular-nums">
                {val !== null && val !== undefined ? String(val) : '—'}
              </div>
            </div>
          ))}
        </div>
        {Array.isArray(trend.evidence) && trend.evidence.length > 0 && (
          <details className="text-[10px] text-muted-foreground">
            <summary className="cursor-pointer hover:text-foreground">
              {trend.evidence.length} evidencias · {trend.sourcesCount} fuentes
            </summary>
            <ul className="mt-1 space-y-1 max-h-32 overflow-y-auto">
              {trend.evidence.slice(0, 5).map((e: any, i: number) => (
                <li key={i} className="border-l-2 border-muted pl-2">
                  <div className="flex items-center gap-1">
                    <Badge variant="outline" className="text-[9px] py-0 px-1">{e.evidenceType}</Badge>
                    <span className="font-mono">{e.source}</span>
                  </div>
                  <p className="line-clamp-2 mt-0.5">{e.rawValue ?? e.normalizedValue}</p>
                  {e.url && (
                    <a href={e.url} target="_blank" rel="noopener noreferrer" className="text-[9px] text-sky-600 hover:underline break-all">
                      {e.url}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

function ProblemCard({ problem }: { problem: any }) {
  return (
    <Card className="border-l-4 border-l-amber-500">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm leading-snug line-clamp-2">
            {problem.description?.split('.')[0]}
          </CardTitle>
          <div className="flex flex-col gap-1 items-end">
            <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200" variant="secondary">
              sev {problem.severity}/100
            </Badge>
            <span className="text-xs font-mono text-muted-foreground">freq {problem.frequency}/100</span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="text-xs space-y-2">
        <p className="text-muted-foreground line-clamp-3">{problem.description}</p>
        {Array.isArray(problem.segmentsAffected) && problem.segmentsAffected.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {problem.segmentsAffected.map((s: string, i: number) => (
              <Badge key={i} variant="outline" className="text-[10px]">{s}</Badge>
            ))}
          </div>
        )}
        <div className="text-[10px] text-muted-foreground flex items-center gap-2">
          <Clock className="h-3 w-3" />
          {formatDate(problem.firstSeen)} → {formatDate(problem.lastSeen)}
        </div>
      </CardContent>
    </Card>
  );
}

function MarkdownView({ markdown }: { markdown: string }) {
  return (
    <div className="rounded-lg border bg-card p-4 overflow-x-auto">
      <pre className="text-xs font-mono whitespace-pre-wrap break-words leading-relaxed">
        {markdown}
      </pre>
    </div>
  );
}

function LimitationsList({ limitations }: { limitations: string[] }) {
  if (!limitations || limitations.length === 0) return null;
  return (
    <Alert>
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle className="text-sm">Limitaciones</AlertTitle>
      <AlertDescription>
        <ul className="mt-1 space-y-1 text-xs">
          {limitations.map((l, i) => (
            <li key={i} className="flex gap-1.5">
              <span className="text-muted-foreground">•</span>
              <span>{l}</span>
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

const SAMPLE_OBJECTIVES = [
  'Investiga qué tendencias y problemas emergentes podrían generar oportunidades de negocio para automatización de pequeños restaurantes en Colombia.',
  'Busca quejas y frustraciones de pequeños negocios sobre gestión manual de inventario o pedidos por WhatsApp.',
  'Detecta oportunidades emergentes en herramientas de IA para pymes en Latinoamérica.',
];

export default function Home() {
  const [objective, setObjective] = useState('');
  const [geography, setGeography] = useState('Colombia');
  const [maxQueries, setMaxQueries] = useState(4);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<InvestigateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logTail, setLogTail] = useState<string[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [investigations, setInvestigations] = useState<InvestigationSummary[]>([]);
  const [investigationsLoading, setInvestigationsLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [tab, setTab] = useState<'opportunities' | 'trends' | 'problems' | 'markdown'>('opportunities');
  // NEW: Investigation mode — "sync" (existing) or "react" (streaming SSE)
  const [mode, setMode] = useState<'sync' | 'react'>('react');
  const [streaming, setStreaming] = useState(false);
  // NEW: Right-panel tab — "providers" (existing), "anomalies", "topics", "mesh", "semantic"
  const [sideTab, setSideTab] = useState<'providers' | 'anomalies' | 'topics' | 'mesh' | 'semantic'>('providers');
  // AGENT-3: chat sidebar state — when open, the page content shrinks
  // (380px right padding on lg+ screens) so the chat doesn't overlap content.
  const [chatOpen, setChatOpen] = useState(false);
  // NEW: Semantic search state
  const [semQuery, setSemQuery] = useState('');
  const [semResults, setSemResults] = useState<Array<{ signalId: string; score: number; snippet: string; url?: string }>>([]);
  const [semLoading, setSemLoading] = useState(false);
  // NEW: Mesh status
  const [meshStatus, setMeshStatus] = useState<any>(null);
  const [meshLoading, setMeshLoading] = useState(false);
  // NEW: Topic selected for evolution chart
  const [evolutionTopic, setEvolutionTopic] = useState<string>('');

  // --------------------------------------------------------------------------
  // Load providers + investigations on mount
  // --------------------------------------------------------------------------

  const refreshProviders = useCallback(async () => {
    setProvidersLoading(true);
    try {
      const r = await fetch('/api/providers');
      const data = await r.json();
      setProviders(data.providers ?? []);
    } catch {
      setProviders([]);
    } finally {
      setProvidersLoading(false);
    }
  }, []);

  const refreshInvestigations = useCallback(async () => {
    setInvestigationsLoading(true);
    try {
      const r = await fetch('/api/investigations');
      const data = await r.json();
      setInvestigations(data.investigations ?? []);
    } catch {
      setInvestigations([]);
    } finally {
      setInvestigationsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshProviders();
    refreshInvestigations();
    // refreshMeshStatus will be called after its declaration below
  }, [refreshProviders, refreshInvestigations]);

  // --------------------------------------------------------------------------
  // NEW: Semantic search
  // --------------------------------------------------------------------------

  const runSemanticSearch = useCallback(async () => {
    const q = semQuery.trim();
    if (!q) return;
    setSemLoading(true);
    try {
      const r = await fetch('/api/semantic-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, topK: 10 }),
      });
      const data = await r.json();
      setSemResults(data.results ?? []);
    } catch {
      setSemResults([]);
    } finally {
      setSemLoading(false);
    }
  }, [semQuery]);

  // --------------------------------------------------------------------------
  // NEW: Mesh status
  // --------------------------------------------------------------------------

  const refreshMeshStatus = useCallback(async () => {
    setMeshLoading(true);
    try {
      const r = await fetch('/api/mesh/config');
      const data = await r.json();
      setMeshStatus(data);
    } catch {
      setMeshStatus(null);
    } finally {
      setMeshLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshMeshStatus();
  }, [refreshMeshStatus]);

  // --------------------------------------------------------------------------
  // NEW: ReAct streaming investigation
  // --------------------------------------------------------------------------

  const runStreamingInvestigation = useCallback(() => {
    if (!objective.trim()) {
      setError('Escribe un objetivo de investigación.');
      return;
    }
    setError(null);
    setResult(null);
    setStreaming(true);
    // The InvestigationStream component will:
    //   1. Open EventSource to /api/investigate/stream
    //   2. Render live progress lines
    //   3. Call onComplete({investigationId}) when done
    //   4. Call onError(msg) on failure
    // We do nothing else here — the component owns the lifecycle.
  }, [objective]);

  // --------------------------------------------------------------------------
  // Investigation handler
  // --------------------------------------------------------------------------

  const runInvestigation = useCallback(async () => {
    if (!objective.trim()) {
      setError('Escribe un objetivo de investigación.');
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    setLogTail([]);
    setProgress(5);

    // Fake progress bar — gives the user visual feedback during the long-running call.
    const progressTimer = setInterval(() => {
      setProgress((p) => (p < 90 ? p + Math.random() * 3 : p));
    }, 1500);

    try {
      const r = await fetch('/api/investigate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          objective: objective.trim(),
          geography: geography.trim() || 'global',
          maxQueries,
          maxRuntimeMs: 180_000,
        }),
      });
      const data: InvestigateResponse = await r.json();
      setProgress(100);
      if (!r.ok) {
        setError(data?.log?.split('\n').slice(-5).join('\n') ?? 'Error desconocido en la investigación.');
      } else {
        setResult(data);
        // Auto-select the new investigation so it appears in the side panel.
        setSelectedId(data.investigationId);
        // Refresh the list so the new investigation appears.
        refreshInvestigations();
        setTab('opportunities');
      }
      // Keep the last ~30 lines of the log for debugging.
      setLogTail((data.log ?? '').split('\n').filter(Boolean).slice(-30));
    } catch (e: any) {
      setError(e?.message ?? 'Error de red al llamar a /api/investigate.');
    } finally {
      clearInterval(progressTimer);
      setLoading(false);
    }
  }, [objective, geography, maxQueries, refreshInvestigations]);

  // --------------------------------------------------------------------------
  // Selecting a past investigation
  // --------------------------------------------------------------------------

  const selectInvestigation = useCallback(async (id: string) => {
    setSelectedId(id);
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/investigations/${id}`);
      if (!r.ok) {
        setError(`No se pudo cargar la investigación ${id}.`);
        return;
      }
      const data = await r.json();
      setResult({
        investigationId: id,
        status: 'COMPLETED',
        counts: undefined,
        report: {
          investigationId: id,
          status: 'COMPLETED',
          markdown: data.markdown ?? '',
          machine: data.machine ?? null,
        },
        log: '',
        ok: true,
      });
      setTab('opportunities');
    } catch (e: any) {
      setError(e?.message ?? 'Error al cargar la investigación.');
    } finally {
      setLoading(false);
    }
  }, []);

  // --------------------------------------------------------------------------
  // Derived state
  // --------------------------------------------------------------------------

  const machine: MachineReport | null = result?.report?.machine ?? null;

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <div
      className={`min-h-screen flex flex-col bg-gradient-to-b from-background to-muted/30 transition-all duration-300 ${
        chatOpen ? 'lg:pr-[380px]' : ''
      }`}
    >
      {/* Header */}
      <header className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 sticky top-0 z-30">
        <div className="container mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center text-white">
              <Radar className="h-4 w-4" />
            </div>
            <div>
              <h1 className="text-base font-semibold tracking-tight leading-none">CHISMOSO</h1>
              <p className="text-[10px] text-muted-foreground leading-none mt-0.5">
                Inteligencia de señales · tendencias · oportunidades
              </p>
            </div>
          </div>
          <Badge variant="outline" className="text-[10px]">v1.0</Badge>
        </div>
      </header>

      {/* Main */}
      <main className="container mx-auto px-4 py-6 flex-1 w-full max-w-7xl">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
          {/* Left column: form + results */}
          <div className="space-y-4">
            {/* Investigation form */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Sparkles className="h-4 w-4 text-violet-500" />
                  Nueva investigación
                </CardTitle>
                <CardDescription className="text-xs">
                  Describe el objetivo en lenguaje natural. CHISMOSO planifica, recopila, normaliza, detecta tendencias y oportunidades, y produce un reporte accionable.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="objective" className="text-xs">Objetivo</Label>
                  <Textarea
                    id="objective"
                    placeholder="Ej: Investiga qué tendencias y problemas emergentes podrían generar oportunidades de negocio para automatización de pequeños restaurantes en Colombia."
                    value={objective}
                    onChange={(e) => setObjective(e.target.value)}
                    rows={3}
                    maxLength={1000}
                    className="resize-y"
                  />
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {SAMPLE_OBJECTIVES.map((s, i) => (
                      <button
                        key={i}
                        onClick={() => setObjective(s)}
                        className="text-[10px] text-muted-foreground hover:text-foreground hover:bg-accent rounded px-2 py-0.5 border border-dashed transition-colors"
                      >
                        Ejemplo {i + 1}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="geography" className="text-xs">Geografía</Label>
                    <Input
                      id="geography"
                      placeholder="Colombia"
                      value={geography}
                      onChange={(e) => setGeography(e.target.value)}
                      className="text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="maxQueries" className="text-xs">Queries máx.</Label>
                    <Input
                      id="maxQueries"
                      type="number"
                      min={1}
                      max={10}
                      value={maxQueries}
                      onChange={(e) => setMaxQueries(Math.min(Math.max(parseInt(e.target.value || '4', 10), 1), 10))}
                      className="text-sm"
                    />
                  </div>
                  <div className="flex items-end">
                    <Button
                      onClick={mode === 'react' ? runStreamingInvestigation : runInvestigation}
                      disabled={(loading || streaming || !objective.trim())}
                      className="w-full"
                      size="sm"
                    >
                      {(loading || streaming) ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                          Investigando...
                        </>
                      ) : mode === 'react' ? (
                        <>
                          <Zap className="h-4 w-4 mr-1.5" />
                          Investigar en vivo
                        </>
                      ) : (
                        <>
                          <Play className="h-4 w-4 mr-1.5" />
                          Investigar
                        </>
                      )}
                    </Button>
                  </div>
                </div>

                {/* NEW: Mode selector */}
                <div className="flex items-center gap-2 pt-1">
                  <Label className="text-xs text-muted-foreground whitespace-nowrap">Modo:</Label>
                  <div className="flex bg-muted rounded-md p-0.5 gap-0.5">
                    <button
                      onClick={() => setMode('react')}
                      className={`text-[11px] px-2.5 py-1 rounded transition-colors ${
                        mode === 'react' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
                      }`}
                      title="ReAct loop con LLM tool-use + streaming SSE en vivo"
                    >
                      <Zap className="h-3 w-3 inline mr-1" />
                      ReAct (en vivo)
                    </button>
                    <button
                      onClick={() => setMode('sync')}
                      className={`text-[11px] px-2.5 py-1 rounded transition-colors ${
                        mode === 'sync' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
                      }`}
                      title="Pipeline clásico — espera silenciosamente y devuelve el reporte al final"
                    >
                      <Play className="h-3 w-3 inline mr-1" />
                      Sync (clásico)
                    </button>
                  </div>
                  <span className="text-[10px] text-muted-foreground">
                    {mode === 'react'
                      ? 'LLM adaptativo + streaming SSE — verás cada paso en vivo'
                      : 'Pipeline determinista con barra de progreso — resultados al final'}
                  </span>
                </div>

                {/* NEW: Streaming SSE live panel */}
                {streaming && mode === 'react' && (
                  <InvestigationStream
                    objective={objective}
                    geography={geography}
                    maxQueries={maxQueries}
                    maxRuntimeMs={180_000}
                    onComplete={({ investigationId }) => {
                      setStreaming(false);
                      void selectInvestigation(investigationId);
                    }}
                    onError={(msg) => {
                      setError(msg);
                      setStreaming(false);
                    }}
                  />
                )}

                {loading && (
                  <div className="space-y-1.5">
                    <Progress value={progress} className="h-1.5" />
                    <p className="text-[10px] text-muted-foreground">
                      CHISMOSO está recopilando señales, normalizando evidencia y detectando tendencias. Esto puede tardar 15–60s.
                    </p>
                  </div>
                )}

                {error && (
                  <Alert variant="destructive">
                    <XCircle className="h-4 w-4" />
                    <AlertTitle className="text-sm">Error</AlertTitle>
                    <AlertDescription className="text-xs whitespace-pre-wrap font-mono">{error}</AlertDescription>
                  </Alert>
                )}
              </CardContent>
            </Card>

            {/* Results */}
            {result && machine && (
              <div className="space-y-4">
                {/* Header */}
                <Card>
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <CardTitle className="text-base leading-tight flex items-center gap-2">
                          <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                          <span className="line-clamp-2">{machine.query}</span>
                        </CardTitle>
                        <CardDescription className="text-xs mt-1 flex items-center gap-2">
                          <Badge className={`text-[10px] ${statusColor(result.status)}`} variant="secondary">
                            {result.status}
                          </Badge>
                          <span>Confianza global: <strong className="font-mono">{Math.round((machine.overallConfidence ?? 0) * 100)}%</strong></span>
                          <span>·</span>
                          <span className="font-mono text-[10px]">{result.investigationId}</span>
                        </CardDescription>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <p className="text-xs text-muted-foreground line-clamp-3">{machine.executiveSummary}</p>
                  </CardContent>
                </Card>

                <StatsGrid report={machine} />

                <LimitationsList limitations={machine.limitations ?? []} />

                {/* Recommended next action */}
                <Alert>
                  <Target className="h-4 w-4" />
                  <AlertTitle className="text-sm">Próxima acción recomendada</AlertTitle>
                  <AlertDescription className="text-xs">{machine.recommendedNextAction}</AlertDescription>
                </Alert>

                {/* Tabs for details */}
                <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
                  <TabsList className="grid grid-cols-4 w-full">
                    <TabsTrigger value="opportunities" className="text-xs">
                      <Target className="h-3 w-3 mr-1" />
                      Oportunidades ({machine.opportunities?.length ?? 0})
                    </TabsTrigger>
                    <TabsTrigger value="trends" className="text-xs">
                      <TrendingUp className="h-3 w-3 mr-1" />
                      Tendencias ({machine.trends?.length ?? 0})
                    </TabsTrigger>
                    <TabsTrigger value="problems" className="text-xs">
                      <AlertTriangle className="h-3 w-3 mr-1" />
                      Problemas ({machine.problems?.length ?? 0})
                    </TabsTrigger>
                    <TabsTrigger value="markdown" className="text-xs">
                      <FileText className="h-3 w-3 mr-1" />
                      Reporte
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="opportunities" className="mt-3 space-y-3">
                    {(!machine.opportunities || machine.opportunities.length === 0) ? (
                      <div className="text-sm text-muted-foreground py-6 text-center border rounded-lg">
                        No se detectaron oportunidades con evidencia suficiente.
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {machine.opportunities
                          .slice()
                          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
                          .map((o, i) => (
                            <OpportunityCard key={o.id ?? i} opp={o} />
                          ))}
                      </div>
                    )}
                  </TabsContent>

                  <TabsContent value="trends" className="mt-3 space-y-3">
                    {(!machine.trends || machine.trends.length === 0) ? (
                      <div className="text-sm text-muted-foreground py-6 text-center border rounded-lg">
                        No se detectaron tendencias.
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {machine.trends
                          .slice()
                          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
                          .map((t, i) => (
                            <TrendCard key={t.id ?? i} trend={t} />
                          ))}
                      </div>
                    )}
                  </TabsContent>

                  <TabsContent value="problems" className="mt-3 space-y-3">
                    {(!machine.problems || machine.problems.length === 0) ? (
                      <div className="text-sm text-muted-foreground py-6 text-center border rounded-lg">
                        No se detectaron problemas con evidencia suficiente (se requieren ≥2 snippets de fricción distintos).
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {machine.problems.map((p, i) => (
                          <ProblemCard key={p.id ?? i} problem={p} />
                        ))}
                      </div>
                    )}
                  </TabsContent>

                  <TabsContent value="markdown" className="mt-3">
                    <div className="rounded-lg border bg-card p-4 overflow-x-auto">
                      <MarkdownRenderer markdown={result.report.markdown} />
                    </div>
                  </TabsContent>
                </Tabs>

                {/* Provider log */}
                {logTail.length > 0 && (
                  <details>
                    <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                      Ver log de providers ({logTail.length} líneas)
                    </summary>
                    <ScrollArea className="h-48 mt-2 rounded-md border bg-zinc-950 text-zinc-100 p-2">
                      <pre className="text-[10px] font-mono whitespace-pre-wrap break-words">
                        {logTail.join('\n')}
                      </pre>
                    </ScrollArea>
                  </details>
                )}
              </div>
            )}

            {!result && !loading && !streaming && (
              <DashboardSummary onOpenChat={() => setChatOpen(true)} />
            )}
          </div>

          {/* Right column: tabbed panel with providers / anomalies / topics / mesh / semantic */}
          <div className="space-y-4">
            {/* Tabbed panel */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Network className="h-4 w-4 text-muted-foreground" />
                  Inteligencia continua
                </CardTitle>
                <CardDescription className="text-xs">
                  Anomalías, evolución de topics, mesh multi-agente, búsqueda semántica
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Tabs value={sideTab} onValueChange={(v) => setSideTab(v as any)}>
                  <TabsList className="grid grid-cols-5 w-full mb-3" size="sm">
                    <TabsTrigger value="providers" className="text-[10px] px-1 py-1">
                      <Server className="h-3 w-3 mr-0.5" />
                      Prov.
                    </TabsTrigger>
                    <TabsTrigger value="anomalies" className="text-[10px] px-1 py-1">
                      <Bell className="h-3 w-3 mr-0.5" />
                      Alertas
                    </TabsTrigger>
                    <TabsTrigger value="topics" className="text-[10px] px-1 py-1">
                      <TrendingUp className="h-3 w-3 mr-0.5" />
                      Topics
                    </TabsTrigger>
                    <TabsTrigger value="mesh" className="text-[10px] px-1 py-1">
                      <Network className="h-3 w-3 mr-0.5" />
                      Mesh
                    </TabsTrigger>
                    <TabsTrigger value="semantic" className="text-[10px] px-1 py-1">
                      <Search className="h-3 w-3 mr-0.5" />
                      Sem.
                    </TabsTrigger>
                  </TabsList>

                  {/* Providers tab */}
                  {sideTab === 'providers' && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">Fuentes registradas</span>
                        <Button variant="ghost" size="icon" onClick={refreshProviders} disabled={providersLoading} className="h-6 w-6">
                          <RefreshCw className={`h-3 w-3 ${providersLoading ? 'animate-spin' : ''}`} />
                        </Button>
                      </div>
                      {providersLoading && providers.length === 0 ? (
                        <div className="text-xs text-muted-foreground py-4 flex items-center justify-center gap-2">
                          <Loader2 className="h-4 w-4 animate-spin" /> Cargando...
                        </div>
                      ) : providers.length === 0 ? (
                        <div className="text-xs text-muted-foreground py-4 text-center">Sin providers.</div>
                      ) : (
                        <ul className="space-y-1.5 max-h-80 overflow-y-auto pr-1">
                          {providers.map((p) => (
                            <li key={p.name} className="rounded-md border p-2 hover:bg-accent/40 transition-colors">
                              <div className="flex items-center justify-between gap-2">
                                <code className="text-[10px] font-mono">{p.name}</code>
                                <div className="flex items-center gap-1.5">
                                  <span className={`h-2 w-2 rounded-full ${
                                    p.health === 'OK' ? 'bg-emerald-500' :
                                    p.health === 'UNAVAILABLE' ? 'bg-red-500' :
                                    p.health === 'DEGRADED' ? 'bg-amber-500' :
                                    'bg-muted'
                                  }`} />
                                  <Badge variant="outline" className="text-[9px] py-0 px-1.5">{p.health}</Badge>
                                </div>
                              </div>
                              <div className="mt-1 text-[10px] text-muted-foreground font-mono">{p.type}</div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}

                  {/* Anomalies tab */}
                  {sideTab === 'anomalies' && (
                    <AnomalyAlerts />
                  )}

                  {/* Topics evolution tab */}
                  {sideTab === 'topics' && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-1.5">
                        <Input
                          placeholder="Topic a vigilar (ej: restaurantes)"
                          value={evolutionTopic}
                          onChange={(e) => setEvolutionTopic(e.target.value)}
                          className="text-xs h-7"
                        />
                      </div>
                      {evolutionTopic.trim() ? (
                        <TopicsEvolution topic={evolutionTopic.trim()} />
                      ) : (
                        <div className="text-xs text-muted-foreground py-6 text-center">
                          Escribe un topic para ver su evolución temporal.
                        </div>
                      )}
                    </div>
                  )}

                  {/* Mesh tab */}
                  {sideTab === 'mesh' && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">Mesh multi-agente</span>
                        <Button variant="ghost" size="icon" onClick={refreshMeshStatus} disabled={meshLoading} className="h-6 w-6">
                          <RefreshCw className={`h-3 w-3 ${meshLoading ? 'animate-spin' : ''}`} />
                        </Button>
                      </div>
                      {meshStatus ? (
                        <div className="space-y-2 text-xs">
                          <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">Estado:</span>
                            <Badge variant={meshStatus.enabled ? 'default' : 'secondary'} className="text-[10px]">
                              {meshStatus.enabled ? 'Activo' : 'Inactivo'}
                            </Badge>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">Suscriptores:</span>
                            <span className="font-mono">{meshStatus.subscribers?.length ?? 0}</span>
                          </div>
                          {meshStatus.subscribers && meshStatus.subscribers.length > 0 && (
                            <ul className="space-y-1 max-h-48 overflow-y-auto">
                              {meshStatus.subscribers.map((s: any, i: number) => (
                                <li key={i} className="border rounded p-1.5 text-[10px]">
                                  <div className="font-mono">{s.agentName ?? s.agent_name ?? 'unknown'}</div>
                                  <div className="text-muted-foreground truncate">{s.webhookUrl ?? s.webhook_url}</div>
                                </li>
                              ))}
                            </ul>
                          )}
                          <p className="text-[10px] text-muted-foreground pt-1">
                            Los endpoints <code>/api/mesh/events</code> y <code>/api/mesh/external-signals</code> permiten a otros agentes (AGENTE-LEADS, NEX-SCOPE) consumir oportunidades y empujar señales externas a CHISMOSO.
                          </p>
                        </div>
                      ) : (
                        <div className="text-xs text-muted-foreground py-4 text-center">Sin datos de mesh.</div>
                      )}
                    </div>
                  )}

                  {/* Semantic search tab */}
                  {sideTab === 'semantic' && (
                    <div className="space-y-2">
                      <span className="text-xs text-muted-foreground">Búsqueda semántica sobre señales acumuladas</span>
                      <div className="flex items-center gap-1.5">
                        <Input
                          placeholder="Ej: fricción con cobros manuales"
                          value={semQuery}
                          onChange={(e) => setSemQuery(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') void runSemanticSearch(); }}
                          className="text-xs h-7"
                        />
                        <Button size="sm" onClick={runSemanticSearch} disabled={semLoading || !semQuery.trim()} className="h-7 px-2">
                          {semLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}
                        </Button>
                      </div>
                      {semResults.length > 0 ? (
                        <ul className="space-y-1.5 max-h-80 overflow-y-auto pr-1">
                          {semResults.map((r) => (
                            <li key={r.signalId} className="border rounded p-1.5 text-[10px]">
                              <div className="flex items-center gap-1.5 mb-0.5">
                                <Badge variant="outline" className="text-[9px] py-0 px-1">
                                  {Math.round(r.score * 100)}%
                                </Badge>
                                <span className="font-mono text-muted-foreground truncate">{r.signalId}</span>
                              </div>
                              <p className="line-clamp-2">{r.snippet}</p>
                              {r.url && (
                                <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-[9px] text-sky-600 hover:underline break-all">
                                  {r.url}
                                </a>
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-[10px] text-muted-foreground py-2">
                          Ejecuta una investigación primero para acumular señales. La búsqueda semántica usa embeddings locales (TF-IDF hash, dim 256).
                        </p>
                      )}
                    </div>
                  )}
                </Tabs>
              </CardContent>
            </Card>

            <InvestigationsPanel
              investigations={investigations}
              loading={investigationsLoading}
              onRefresh={refreshInvestigations}
              onSelect={selectInvestigation}
              selectedId={selectedId}
            />
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t bg-background mt-auto">
        <div className="container mx-auto px-4 py-3 flex items-center justify-between text-[10px] text-muted-foreground">
          <span>
            CHISMOSO V1.1 · {providers.length} providers · {investigations.length} investigaciones
            {meshStatus?.enabled ? ' · mesh activo' : ''}
          </span>
          <span className="flex items-center gap-1">
            <CircleDot className="h-3 w-3" />
            SQLite · z-ai-web-dev-sdk · ReAct · SSE · Embeddings · Mesh
          </span>
        </div>
      </footer>

      {/* AGENT-3: Floating chat toggle + chat sidebar.
          Rendered at the end of the main wrapper so they overlay correctly
          and so the lg:pr-[380px] above reserves space on large screens. */}
      <ChatToggle open={chatOpen} onToggle={() => setChatOpen(!chatOpen)} />
      <ChatAgent open={chatOpen} onClose={() => setChatOpen(false)} />
    </div>
  );
}
