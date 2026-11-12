'use client';

/**
 * SettingsPanel
 *
 * Self-contained config dialog for CHISMOSO. Renders a gear-icon button
 * (so the header can just drop `<SettingsPanel />` into its toolbar) that
 * opens a Dialog with eight accordion sections:
 *
 *   1. General         — domain, log level, geography, DB path, output dir
 *   2. Authentication  — auth enabled, token count, session TTL, header name
 *   3. Providers       — registered data sources + health (from /api/providers cache)
 *   4. MCP Servers     — configured Model Context Protocol servers
 *   5. Mesh            — multi-agent mesh: enabled + subscribers
 *   6. LLM             — model + circuit breaker state
 *   7. Backups         — last backup timestamp, retention, file count
 *   8. Observability   — Sentry DSN (masked) + metrics endpoint
 *
 * Security model:
 *   - READ: pulls the safe, redacted config from GET /api/config.
 *     Secrets are NEVER returned by the API (token count, not tokens;
 *     masked Sentry DSN, not the raw key).
 *   - WRITE: this panel does NOT write to .env directly. Each setting's
 *     "Apply" button issues a PUT /api/config that returns the EXACT CLI
 *     command + env var name the operator must run on the server. We
 *     render that command in a copyable code block.
 *   - Safe client-only preferences (like theme) are persisted to
 *     localStorage by the ThemeToggle, not here.
 *
 * Why accordion + dialog instead of a separate /settings page:
 *   - The dashboard's primary action is "investigate". Config is secondary,
 *     so it lives behind a gear button that doesn't compete for attention.
 *   - An accordion keeps all eight sections discoverable without forcing
 *     the user to scroll past empty ones.
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
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  Settings as SettingsIcon,
  Loader2,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Shield,
  Server,
  Network,
  Cpu,
  Database,
  Activity,
  Eye,
  Copy,
  KeyRound,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Types — mirror the response of GET /api/config.
// ---------------------------------------------------------------------------

interface ConfigResponse {
  general: {
    domain: string;
    logLevel: string;
    geography: string;
    dbPath: string;
    outputDir: string;
  };
  auth: {
    enabled: boolean;
    tokenCount: number;
    sessionTtlSec: number;
    headerName: string;
    cookieName: string;
  };
  providers: {
    count: number;
    healthy: number;
    items: Array<{ name: string; type: string; health: string; capabilities: string[] }>;
  };
  mcp: {
    servers: Array<{ name: string; transport: 'stdio' | 'sse' | 'http' | 'unknown' }>;
    count: number;
  };
  mesh: {
    enabled: boolean;
    subscriberCount: number;
    subscribers: Array<{ agentName: string; webhookUrl: string; active: boolean }>;
  };
  llm: {
    circuitBreakerState: 'closed' | 'open' | 'half-open' | 'unknown';
    model: string;
  };
  observability: {
    sentryConfigured: boolean;
    sentryDsnMasked: string | null;
    metricsEndpoint: string;
  };
  backups: {
    lastBackupAt: string | null;
    retentionDays: number;
    backupDir: string;
    fileCount: number;
  };
}

interface PutResponse {
  applied: boolean;
  reason: string;
  envVar: string;
  cli: string;
  requestedKey: string;
  requestedValue: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function healthColor(health: string): string {
  switch (health) {
    case 'OK': return 'bg-emerald-500';
    case 'DEGRADED': return 'bg-amber-500';
    case 'UNAVAILABLE': return 'bg-red-500';
    case 'AUTH_REQUIRED': return 'bg-orange-500';
    case 'RATE_LIMITED': return 'bg-yellow-500';
    default: return 'bg-muted-foreground';
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('es-CO', {
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

/** Tiny copy-to-clipboard button with a "Copied!" check state. */
function CopyButton({ text, label = 'Copiar comando' }: { text: string; label?: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 px-2 text-[11px]"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard blocked — user can select + copy manually */
        }
      }}
      title={label}
    >
      {copied ? (
        <>
          <CheckCircle2 className="h-3 w-3 text-emerald-500" />
          Copiado
        </>
      ) : (
        <>
          <Copy className="h-3 w-3" />
          Copiar
        </>
      )}
    </Button>
  );
}

/**
 * A single read-only field row: label on the left, value on the right,
 * monospaced when the value is a path / env var / ID.
 */
function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <span className="text-xs text-muted-foreground shrink-0 min-w-[7rem]">{label}</span>
      <span
        className={`text-xs text-right min-w-0 break-all ${
          mono ? 'font-mono' : ''
        }`}
      >
        {value === '' || value === null || value === undefined ? (
          <span className="text-muted-foreground/60">—</span>
        ) : (
          value
        )}
      </span>
    </div>
  );
}

/**
 * Editable setting row: label, current value, an inline editor (Input /
 * Select / Switch), and a "Save" button that issues PUT /api/config and
 * renders the returned CLI command in a copyable code block.
 *
 * The PUT response is always `applied: false` — we never write to .env
 * from the dashboard. The CLI command is what the operator runs on the
 * server.
 */
function EditableSetting({
  label,
  currentValue,
  envVar,
  editor,
  putKey,
}: {
  label: string;
  currentValue: React.ReactNode;
  envVar: string;
  editor: React.ReactNode;
  putKey: string;
}) {
  const [pendingValue, setPendingValue] = React.useState<string>('');
  const [response, setResponse] = React.useState<PutResponse | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Read the pending value out of the editor via a ref-like callback.
  // The editor is a controlled element (Input/Select/Switch); we wire its
  // onChange to setPendingValue. The "Apply" button sends whatever is in
  // pendingValue. If pendingValue is empty / unchanged, the button is disabled.
  const editorWithHandler = (
    <div onChange={(e) => {
      const target = e.target as HTMLInputElement | HTMLSelectElement;
      setPendingValue(target.value);
    }}>
      {editor}
    </div>
  );

  const apply = React.useCallback(async () => {
    if (!pendingValue) return;
    setSubmitting(true);
    setError(null);
    setResponse(null);
    try {
      const r = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: putKey, value: pendingValue }),
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data?.error ?? `Error ${r.status}`);
      } else {
        setResponse(data as PutResponse);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  }, [pendingValue, putKey]);

  return (
    <div className="space-y-1.5 py-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground shrink-0 min-w-[7rem]">{label}</span>
        <span className="text-xs font-mono text-right min-w-0 break-all">
          {currentValue === '' || currentValue === null || currentValue === undefined ? (
            <span className="text-muted-foreground/60">—</span>
          ) : (
            currentValue
          )}
        </span>
      </div>
      <div className="flex items-center gap-2">
        {editorWithHandler}
        <Button
          size="sm"
          className="h-7 px-2 text-[11px] shrink-0"
          disabled={!pendingValue || submitting}
          onClick={apply}
        >
          {submitting ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            'Aplicar'
          )}
        </Button>
      </div>
      {error && (
        <p className="text-[10px] text-destructive">{error}</p>
      )}
      {response && (
        <div className="rounded-md border bg-muted/40 p-2 space-y-1">
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <AlertTriangle className="h-3 w-3 text-amber-500" />
            <span>{response.reason}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <code className="flex-1 text-[10px] font-mono break-all">
              {response.cli}
            </code>
            <CopyButton text={response.cli} />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section components — each renders the fields for one accordion section.
// Kept as small functions so the main component stays readable.
// ---------------------------------------------------------------------------

function GeneralSection({ cfg }: { cfg: ConfigResponse }) {
  return (
    <div className="space-y-1">
      <Field label="Dominio" value={cfg.general.domain} mono />
      <Field label="Geografía" value={cfg.general.geography} />
      <Field label="Nivel de log" value={cfg.general.logLevel} mono />
      <Field label="Ruta DB" value={cfg.general.dbPath} mono />
      <Field label="Directorio salida" value={cfg.general.outputDir} mono />
      <div className="border-t pt-2 mt-2 space-y-2">
        <EditableSetting
          label="Nuevo log level"
          currentValue={cfg.general.logLevel}
          envVar="CHISMOSO_LOG_LEVEL"
          putKey="logLevel"
          editor={
            <Select>
              <SelectTrigger className="h-7 text-xs flex-1">
                <SelectValue placeholder="DEBUG / INFO / WARN / ERROR" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="DEBUG">DEBUG</SelectItem>
                <SelectItem value="INFO">INFO</SelectItem>
                <SelectItem value="WARN">WARN</SelectItem>
                <SelectItem value="ERROR">ERROR</SelectItem>
              </SelectContent>
            </Select>
          }
        />
        <EditableSetting
          label="Nueva geografía"
          currentValue={cfg.general.geography}
          envVar="CHISMOSO_GEOGRAPHY"
          putKey="geography"
          editor={
            <Input
              placeholder="ej: Colombia"
              className="h-7 text-xs flex-1"
            />
          }
        />
      </div>
    </div>
  );
}

function AuthSection({ cfg }: { cfg: ConfigResponse }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3 py-1.5">
        <span className="text-xs text-muted-foreground">Auth habilitado</span>
        <Badge variant={cfg.auth.enabled ? 'default' : 'secondary'} className="text-[10px]">
          {cfg.auth.enabled ? 'ON' : 'OFF'}
        </Badge>
      </div>
      <Field label="Tokens configurados" value={cfg.auth.tokenCount} mono />
      <Field label="Header agente" value={cfg.auth.headerName} mono />
      <Field label="Cookie sesión" value={cfg.auth.cookieName} mono />
      <Field
        label="TTL sesión"
        value={`${Math.round(cfg.auth.sessionTtlSec / 3600)}h (${cfg.auth.sessionTtlSec}s)`}
        mono
      />
      <div className="rounded-md border bg-muted/30 p-2 mt-2 text-[10px] text-muted-foreground">
        <div className="flex items-start gap-1.5">
          <KeyRound className="h-3 w-3 mt-0.5 shrink-0" />
          <span>
            Genera nuevos tokens con{' '}
            <code className="font-mono">chismoso auth token</code>{' '}
            y añade el hash a{' '}
            <code className="font-mono">CHISMOSO_AUTH_TOKENS</code>{' '}
            en <code className="font-mono">.env</code>. Los usuarios operador
            se gestionan con <code className="font-mono">chismoso auth user add</code>.
          </span>
        </div>
      </div>
    </div>
  );
}

function ProvidersSection({ cfg, loading }: { cfg: ConfigResponse; loading: boolean }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">
          {cfg.providers.count} providers · {cfg.providers.healthy} saludables
        </span>
        {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
      </div>
      {cfg.providers.count === 0 ? (
        <div className="text-[11px] text-muted-foreground py-3 text-center border rounded-md">
          {loading
            ? 'Cargando providers...'
            : 'Sin providers en caché. Abre la pestaña Providers del panel Intel para llenar la caché.'}
        </div>
      ) : (
        <ul className="space-y-1 max-h-48 overflow-y-auto pr-1">
          {cfg.providers.items.map((p) => (
            <li
              key={p.name}
              className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5"
            >
              <div className="min-w-0">
                <div className="text-[11px] font-mono truncate">{p.name}</div>
                <div className="text-[9px] text-muted-foreground">{p.type}</div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className={`h-2 w-2 rounded-full ${healthColor(p.health)}`} />
                <Badge variant="outline" className="text-[9px] py-0 px-1.5">
                  {p.health}
                </Badge>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function McpSection({ cfg }: { cfg: ConfigResponse }) {
  return (
    <div className="space-y-1.5">
      <Field label="Servidores" value={cfg.mcp.count} mono />
      {cfg.mcp.count === 0 ? (
        <div className="text-[11px] text-muted-foreground py-3 text-center border rounded-md">
          No hay servidores MCP configurados vía{' '}
          <code className="font-mono">CHISMOSO_MCP_SERVERS</code>. Usa{' '}
          <code className="font-mono">chismoso mcp add</code> para registrar uno.
        </div>
      ) : (
        <ul className="space-y-1">
          {cfg.mcp.servers.map((s) => (
            <li
              key={s.name}
              className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5"
            >
              <span className="text-[11px] font-mono truncate">{s.name}</span>
              <Badge variant="outline" className="text-[9px] py-0 px-1.5">
                {s.transport}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MeshSection({ cfg }: { cfg: ConfigResponse }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3 py-1.5">
        <span className="text-xs text-muted-foreground">Mesh multi-agente</span>
        <Badge variant={cfg.mesh.enabled ? 'default' : 'secondary'} className="text-[10px]">
          {cfg.mesh.enabled ? 'Activo' : 'Inactivo'}
        </Badge>
      </div>
      <Field label="Suscriptores" value={cfg.mesh.subscriberCount} mono />
      {cfg.mesh.subscribers.length > 0 && (
        <ul className="space-y-1 max-h-32 overflow-y-auto pr-1">
          {cfg.mesh.subscribers.map((s) => (
            <li
              key={s.agentName + s.webhookUrl}
              className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5"
            >
              <div className="min-w-0">
                <div className="text-[11px] font-mono truncate">{s.agentName}</div>
                <div className="text-[9px] text-muted-foreground truncate">{s.webhookUrl}</div>
              </div>
              <Badge
                variant={s.active ? 'default' : 'outline'}
                className="text-[9px] py-0 px-1.5 shrink-0"
              >
                {s.active ? 'activo' : 'pausa'}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <div className="rounded-md border bg-muted/30 p-2 mt-2 text-[10px] text-muted-foreground">
        Gestiona suscriptores con{' '}
        <code className="font-mono">chismoso mesh subscribe --agent=N --url=URL</code>{' '}
        y <code className="font-mono">chismoso mesh enable|disable</code>.
      </div>
    </div>
  );
}

function LlmSection({ cfg }: { cfg: ConfigResponse }) {
  return (
    <div className="space-y-1">
      <Field label="Modelo" value={cfg.llm.model} mono />
      <div className="flex items-center justify-between gap-3 py-1.5">
        <span className="text-xs text-muted-foreground">Circuit breaker</span>
        <Badge
          variant="outline"
          className={`text-[10px] ${
            cfg.llm.circuitBreakerState === 'open'
              ? 'border-red-400 text-red-600 dark:text-red-400'
              : cfg.llm.circuitBreakerState === 'half-open'
                ? 'border-amber-400 text-amber-600 dark:text-amber-400'
                : ''
          }`}
        >
          {cfg.llm.circuitBreakerState}
        </Badge>
      </div>
      {cfg.llm.circuitBreakerState === 'unknown' && (
        <div className="text-[10px] text-muted-foreground">
          El estado del breaker vive en el proceso chismoso. Ejecuta{' '}
          <code className="font-mono">chismoso doctor</code> para verlo en vivo.
        </div>
      )}
    </div>
  );
}

function BackupsSection({ cfg }: { cfg: ConfigResponse }) {
  return (
    <div className="space-y-1">
      <Field label="Último backup" value={formatDate(cfg.backups.lastBackupAt)} />
      <Field label="Archivos" value={cfg.backups.fileCount} mono />
      <Field label="Retención" value={`${cfg.backups.retentionDays} días`} />
      <Field label="Directorio" value={cfg.backups.backupDir} mono />
      <div className="flex items-center gap-2 pt-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-[11px]"
          onClick={async () => {
            try {
              await fetch('/api/doctor?fix=true', { method: 'POST' });
            } catch {
              /* the doctor route will surface errors in its own response */
            }
          }}
        >
          <RefreshCw className="h-3 w-3" />
          Ejecutar doctor (fix)
        </Button>
      </div>
      <div className="rounded-md border bg-muted/30 p-2 mt-1 text-[10px] text-muted-foreground">
        Los backups se ejecutan vía{' '}
        <code className="font-mono">scripts/backup-sqlite.sh</code>{' '}
        (cron recomendado: diario). Ajusta la retención con{' '}
        <code className="font-mono">CHISMOSO_BACKUP_RETENTION_DAYS</code>.
      </div>
    </div>
  );
}

function ObservabilitySection({ cfg }: { cfg: ConfigResponse }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3 py-1.5">
        <span className="text-xs text-muted-foreground">Sentry</span>
        <Badge
          variant={cfg.observability.sentryConfigured ? 'default' : 'secondary'}
          className="text-[10px]"
        >
          {cfg.observability.sentryConfigured ? 'configurado' : 'no configurado'}
        </Badge>
      </div>
      {cfg.observability.sentryConfigured && (
        <Field
          label="DSN (enmascarado)"
          value={cfg.observability.sentryDsnMasked}
          mono
        />
      )}
      <Field label="Metrics endpoint" value={cfg.observability.metricsEndpoint} mono />
      <div className="border-t pt-2 mt-2 space-y-2">
        <EditableSetting
          label="Nuevo Sentry DSN"
          currentValue={cfg.observability.sentryDsnMasked ?? '(no configurado)'}
          envVar="SENTRY_DSN"
          putKey="sentryDsn"
          editor={
            <Input
              type="password"
              placeholder="https://...@sentry.io/..."
              className="h-7 text-xs flex-1"
            />
          }
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface SettingsPanelProps {
  /** Override the trigger button classes (e.g. to match header sizing). */
  triggerClassName?: string;
}

export function SettingsPanel({ triggerClassName }: SettingsPanelProps) {
  const [open, setOpen] = React.useState(false);
  const [config, setConfig] = React.useState<ConfigResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Fetch the config every time the dialog opens (so the operator always
  // sees fresh state — auth tokens may have been added since last open).
  const loadConfig = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/config');
      const data = await r.json();
      if (!r.ok) {
        setError(data?.error ?? `Error ${r.status}`);
        setConfig(null);
      } else {
        setConfig(data.config as ConfigResponse);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Network error');
      setConfig(null);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (open) void loadConfig();
  }, [open, loadConfig]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={triggerClassName}
          aria-label="Configuración"
          title="Configuración"
        >
          <SettingsIcon className="h-[1.15rem] w-[1.15rem]" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <SettingsIcon className="h-4 w-4 text-muted-foreground" />
            Configuración
          </DialogTitle>
          <DialogDescription className="text-xs">
            Estado efectivo del agente CHISMOSO. Los cambios se aplican vía CLI —
            el dashboard no escribe en <code className="font-mono">.env</code>{' '}
            directamente (riesgo de seguridad).
          </DialogDescription>
        </DialogHeader>

        {loading && !config && (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Cargando configuración...
          </div>
        )}

        {error && !loading && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
            No se pudo cargar la configuración: {error}
          </div>
        )}

        {config && (
          <>
            <div className="flex items-center justify-between gap-2 px-1">
              <span className="text-[10px] text-muted-foreground">
                8 secciones · haz click para expandir
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={loadConfig}
                disabled={loading}
              >
                {loading ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3" />
                )}
                Refrescar
              </Button>
            </div>

            <Accordion type="single" collapsible defaultValue="general" className="w-full">
              <AccordionItem value="general">
                <AccordionTrigger className="text-sm">
                  <span className="flex items-center gap-2">
                    <Eye className="h-4 w-4 text-muted-foreground" />
                    General
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <GeneralSection cfg={config} />
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="auth">
                <AccordionTrigger className="text-sm">
                  <span className="flex items-center gap-2">
                    <Shield className="h-4 w-4 text-muted-foreground" />
                    Autenticación
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <AuthSection cfg={config} />
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="providers">
                <AccordionTrigger className="text-sm">
                  <span className="flex items-center gap-2">
                    <Server className="h-4 w-4 text-muted-foreground" />
                    Providers
                    <Badge variant="outline" className="text-[9px] py-0 px-1.5">
                      {config.providers.count}
                    </Badge>
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <ProvidersSection cfg={config} loading={loading} />
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="mcp">
                <AccordionTrigger className="text-sm">
                  <span className="flex items-center gap-2">
                    <Cpu className="h-4 w-4 text-muted-foreground" />
                    MCP Servers
                    <Badge variant="outline" className="text-[9px] py-0 px-1.5">
                      {config.mcp.count}
                    </Badge>
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <McpSection cfg={config} />
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="mesh">
                <AccordionTrigger className="text-sm">
                  <span className="flex items-center gap-2">
                    <Network className="h-4 w-4 text-muted-foreground" />
                    Mesh
                    {config.mesh.enabled && (
                      <span className="h-2 w-2 rounded-full bg-emerald-500" />
                    )}
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <MeshSection cfg={config} />
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="llm">
                <AccordionTrigger className="text-sm">
                  <span className="flex items-center gap-2">
                    <Cpu className="h-4 w-4 text-muted-foreground" />
                    LLM
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <LlmSection cfg={config} />
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="backups">
                <AccordionTrigger className="text-sm">
                  <span className="flex items-center gap-2">
                    <Database className="h-4 w-4 text-muted-foreground" />
                    Backups
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <BackupsSection cfg={config} />
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="observability">
                <AccordionTrigger className="text-sm">
                  <span className="flex items-center gap-2">
                    <Activity className="h-4 w-4 text-muted-foreground" />
                    Observabilidad
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <ObservabilitySection cfg={config} />
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
