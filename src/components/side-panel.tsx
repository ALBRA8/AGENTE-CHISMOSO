'use client';

/**
 * SidePanel
 *
 * Self-contained "Intel" dialog that replaces the old always-visible right
 * sidebar. The sidebar used to show five tabs (Providers / Alertas / Topics
 * / Mesh / Sem) alongside the past-investigations list, eating 320px of
 * horizontal space on every screen. Collapsing it into a dialog triggered
 * by a single "Intel" button clears the main column for the investigation
 * form + results — the actual primary task.
 *
 * The dialog preserves ALL five sub-sections (plus a sixth "Investigaciones"
 * tab for past reports). Each sub-section is self-loading: providers, mesh,
 * anomalies, topics, and semantic search each fetch their own data on first
 * activation, so opening the dialog is cheap and only the active tab pays
 * its fetch cost.
 *
 * Props:
 *   - investigations / investigationsLoading / onRefreshInvestigations:
 *     the past-investigations list is owned by the parent
 *     (InvestigationPanel) so it can stay in sync with the form's result.
 *   - onSelectInvestigation(id): fired when the user clicks a past
 *     investigation; the parent loads it into the result view.
 */
import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Loader2,
  RefreshCw,
  Server,
  Bell,
  TrendingUp,
  Network,
  Search,
  ChevronRight,
  Database,
  CircleDot,
} from 'lucide-react';
import { AnomalyAlerts } from '@/components/anomaly-alerts';
import { TopicsEvolution } from '@/components/topics-evolution';

// ---------------------------------------------------------------------------
// Types — mirror the InvestigationSummary from investigation-panel.tsx.
// Kept local so this file doesn't pull the panel's full type graph.
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
  health: string;
  capabilities?: string[];
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
    default: return 'bg-muted text-muted-foreground';
  }
}

function formatDate(iso: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('es-CO', {
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
// SideTab type
// ---------------------------------------------------------------------------

type SideTab = 'providers' | 'anomalies' | 'topics' | 'mesh' | 'semantic' | 'history';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface SidePanelProps {
  investigations: InvestigationSummary[];
  investigationsLoading: boolean;
  onRefreshInvestigations: () => void;
  onSelectInvestigation: (id: string) => void;
  /** Optional controlled open state. When omitted, the dialog manages its
   *  own open state internally (default). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** className for the trigger button. */
  triggerClassName?: string;
}

export function SidePanel({
  investigations,
  investigationsLoading,
  onRefreshInvestigations,
  onSelectInvestigation,
  open: controlledOpen,
  onOpenChange,
  triggerClassName,
}: SidePanelProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;

  const [sideTab, setSideTab] = React.useState<SideTab>('providers');

  // --- providers ---
  const [providers, setProviders] = React.useState<ProviderInfo[]>([]);
  const [providersLoading, setProvidersLoading] = React.useState(false);

  const refreshProviders = React.useCallback(async () => {
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

  // --- mesh ---
  const [meshStatus, setMeshStatus] = React.useState<any>(null);
  const [meshLoading, setMeshLoading] = React.useState(false);

  const refreshMeshStatus = React.useCallback(async () => {
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

  // --- semantic search ---
  const [semQuery, setSemQuery] = React.useState('');
  const [semResults, setSemResults] = React.useState<Array<{ signalId: string; score: number; snippet: string; url?: string }>>([]);
  const [semLoading, setSemLoading] = React.useState(false);

  const runSemanticSearch = React.useCallback(async () => {
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

  // --- topics evolution ---
  const [evolutionTopic, setEvolutionTopic] = React.useState('');

  // -------------------------------------------------------------------------
  // Load providers + mesh the first time the dialog opens (lazy). Each
  // tab's content is mounted only when active, so anomalies / topics /
  // semantic don't pay any cost until the user clicks them.
  // -------------------------------------------------------------------------

  React.useEffect(() => {
    if (!open) return;
    if (providers.length === 0) void refreshProviders();
    if (meshStatus === null) void refreshMeshStatus();
  }, [open, providers.length, meshStatus, refreshProviders, refreshMeshStatus]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className={`h-8 ${triggerClassName ?? ''}`}>
          <Network className="h-4 w-4" />
          Intel
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Network className="h-4 w-4 text-muted-foreground" />
            Inteligencia continua
          </DialogTitle>
          <DialogDescription className="text-xs">
            Anomalías, evolución de topics, mesh multi-agente, búsqueda semántica e historial de investigaciones.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={sideTab} onValueChange={(v) => setSideTab(v as SideTab)}>
          <TabsList className="grid grid-cols-6 w-full">
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
            <TabsTrigger value="history" className="text-[10px] px-1 py-1">
              <Database className="h-3 w-3 mr-0.5" />
              Hist.
            </TabsTrigger>
          </TabsList>

          {/* Providers tab */}
          <TabsContent value="providers" className="mt-3 space-y-2">
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
                          'bg-muted-foreground'
                        }`} />
                        <Badge variant="outline" className="text-[9px] py-0 px-1.5">{p.health}</Badge>
                      </div>
                    </div>
                    <div className="mt-1 text-[10px] text-muted-foreground font-mono">{p.type}</div>
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>

          {/* Anomalies tab */}
          <TabsContent value="anomalies" className="mt-3">
            <AnomalyAlerts />
          </TabsContent>

          {/* Topics evolution tab */}
          <TabsContent value="topics" className="mt-3 space-y-2">
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
          </TabsContent>

          {/* Mesh tab */}
          <TabsContent value="mesh" className="mt-3 space-y-2">
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
                  Los endpoints <code>/api/mesh/events</code> y{' '}
                  <code>/api/mesh/external-signals</code> permiten a otros agentes
                  consumir oportunidades y empujar señales externas a CHISMOSO.
                </p>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground py-4 text-center">Sin datos de mesh.</div>
            )}
          </TabsContent>

          {/* Semantic search tab */}
          <TabsContent value="semantic" className="mt-3 space-y-2">
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
                Ejecuta una investigación primero para acumular señales. La búsqueda
                semántica usa embeddings locales (TF-IDF hash, dim 256).
              </p>
            )}
          </TabsContent>

          {/* History tab — past investigations */}
          <TabsContent value="history" className="mt-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Investigaciones previas</span>
              <Button variant="ghost" size="icon" onClick={onRefreshInvestigations} disabled={investigationsLoading} className="h-6 w-6">
                <RefreshCw className={`h-3 w-3 ${investigationsLoading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
            {investigationsLoading && investigations.length === 0 ? (
              <div className="text-xs text-muted-foreground py-4 flex items-center justify-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Cargando...
              </div>
            ) : investigations.length === 0 ? (
              <div className="text-xs text-muted-foreground py-6 text-center">
                Todavía no hay investigaciones guardadas.
              </div>
            ) : (
              <ul className="space-y-1.5 max-h-80 overflow-y-auto pr-1">
                {investigations.map((inv) => (
                  <li key={inv.id}>
                    <button
                      onClick={() => {
                        onSelectInvestigation(inv.id);
                        setOpen(false);
                      }}
                      className="w-full text-left rounded-md border p-2 hover:bg-accent/60 transition-colors"
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
          </TabsContent>
        </Tabs>

        {/* Footer hint — explains what the dialog is for */}
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground border-t pt-2">
          <CircleDot className="h-3 w-3" />
          <span>
            Estos paneles se actualizan al abrir el dialog. Cierra y reabre para forzar un refresh.
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
