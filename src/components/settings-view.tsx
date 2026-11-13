'use client';

import * as React from 'react';

type SettingsSection = 'identity' | 'provider' | 'signals' | 'telegram' | 'whatsapp';

interface ProviderConfig {
  provider: string;
  base_url: string;
  model: string;
  api_key?: string;
  api_key_set?: boolean;
  temperature: number;
  top_p: number;
  max_tokens: number;
  timeout: number;
}

export function SettingsView() {
  const [section, setSection] = React.useState<SettingsSection>('provider');

  const tabs: { key: SettingsSection; label: string; icon: string }[] = [
    { key: 'identity', label: 'Identidad', icon: '🏷️' },
    { key: 'provider', label: 'Proveedor IA', icon: '🧠' },
    { key: 'signals', label: 'Búsqueda y Señales', icon: '🔍' },
    { key: 'telegram', label: 'Telegram', icon: '✈️' },
    { key: 'whatsapp', label: 'WhatsApp', icon: '📱' },
  ];

  return (
    <div className="w-full max-w-4xl mx-auto py-2">
      {/* Sub-tabs header matching AGENTE GENERAL */}
      <div className="flex gap-2 mb-6 border-b border-border/40 pb-2 overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setSection(t.key)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              section === t.key
                ? 'bg-accent text-accent-foreground shadow-sm font-semibold border-b-2 border-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/40'
            }`}
          >
            <span>{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {section === 'identity' && <IdentitySection />}
      {section === 'provider' && <ProviderSection />}
      {section === 'signals' && <SignalsSection />}
      {section === 'telegram' && <TelegramSection />}
      {section === 'whatsapp' && <WhatsAppSection />}
    </div>
  );
}

// =====================================================================
// 1. IDENTIDAD SECTION
// =====================================================================

function IdentitySection() {
  const [name, setName] = React.useState('CHISMOSO');
  const [role, setRole] = React.useState('Agente autónomo de inteligencia de señales (SIGINT/OSINT)');
  const [geography, setGeography] = React.useState('global');
  const [language, setLanguage] = React.useState('es');
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  React.useEffect(() => {
    fetch('/api/agent-identity')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) {
          setName(d.name || 'CHISMOSO');
          setRole(d.role || 'Agente autónomo de inteligencia de señales (SIGINT/OSINT)');
          setGeography(d.geography || 'global');
          setLanguage(d.language || 'es');
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch('/api/agent-identity', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), role: role.trim(), geography, language }),
      });
      if (!res.ok) throw new Error('Error al guardar');
      setMsg({ type: 'ok', text: `✅ Identidad guardada — el agente operará como "${name}"` });
    } catch (e: any) {
      setMsg({ type: 'err', text: e?.message || 'Error al guardar identidad' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="text-xs text-muted-foreground py-8 text-center">Cargando identidad...</div>;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2">🏷️ Identidad del Agente</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Configura el nombre, personalidad y ámbito de operación de CHISMOSO. Se sincroniza con chat, reportes y canales.
        </p>
      </div>

      {msg && (
        <div className={`p-3 rounded-lg text-xs font-medium ${msg.type === 'ok' ? 'bg-emerald-500/10 text-emerald-600 border border-emerald-500/20' : 'bg-red-500/10 text-red-600 border border-red-500/20'}`}>
          {msg.text}
        </div>
      )}

      <div className="border border-border/60 rounded-xl p-5 space-y-4 bg-card/50 shadow-sm">
        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-foreground">Nombre del agente</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="CHISMOSO"
            className="w-full text-xs px-3 py-2 rounded-lg border border-border bg-background focus:ring-1 focus:ring-primary outline-none"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-foreground">Rol / Misión del agente</label>
          <input
            type="text"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="Agente autónomo de inteligencia de señales y monitoreo OSINT"
            className="w-full text-xs px-3 py-2 rounded-lg border border-border bg-background focus:ring-1 focus:ring-primary outline-none"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-foreground">Geografía de Enfoque</label>
            <input
              type="text"
              value={geography}
              onChange={(e) => setGeography(e.target.value)}
              placeholder="global, Colombia, LATAM, US..."
              className="w-full text-xs px-3 py-2 rounded-lg border border-border bg-background focus:ring-1 focus:ring-primary outline-none"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-foreground">Idioma de Reportes</label>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="w-full text-xs px-3 py-2 rounded-lg border border-border bg-background focus:ring-1 focus:ring-primary outline-none"
            >
              <option value="es">Español (es)</option>
              <option value="en">English (en)</option>
              <option value="pt">Português (pt)</option>
            </select>
          </div>
        </div>

        {/* Vista previa */}
        <div className="p-3 rounded-lg bg-muted/40 border border-border/40 text-xs">
          <span className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider block mb-1">Vista Previa</span>
          <p className="italic text-foreground/90">
            &quot;Soy <strong>{name}</strong>, {role}. Enfoque geográfico: {geography}.&quot;
          </p>
        </div>

        <button
          onClick={save}
          disabled={saving}
          className="px-4 py-2 text-xs font-medium rounded-lg bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 transition-all flex items-center gap-1.5 shadow-sm"
        >
          {saving ? '⏳ Guardando...' : '💾 Guardar identidad'}
        </button>
      </div>
    </div>
  );
}

// =====================================================================
// 2. PROVEEDOR IA SECTION (Matches AGENTE GENERAL screenshots exactly)
// =====================================================================

function ProviderSection() {
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [msg, setMsg] = React.useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [apiKey, setApiKey] = React.useState('');
  const [showApiKey, setShowApiKey] = React.useState(false);
  const [provider, setProvider] = React.useState('nvidia');
  const [baseUrl, setBaseUrl] = React.useState('https://integrate.api.nvidia.com/v1');
  const [model, setModel] = React.useState('z-ai/glm-5.3-flash');
  const [temperature, setTemperature] = React.useState(0.5);
  const [topP, setTopP] = React.useState(1.0);
  const [maxTokens, setMaxTokens] = React.useState(1024);
  const [timeoutVal, setTimeoutVal] = React.useState(60);

  const providerDefaults: Record<string, { base_url: string; model: string }> = {
    nvidia: {
      base_url: 'https://integrate.api.nvidia.com/v1',
      model: 'z-ai/glm-5.3-flash',
    },
    groq: {
      base_url: 'https://api.groq.com/openai/v1',
      model: 'openai/gpt-oss-120b',
    },
    google: {
      base_url: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      model: 'gemini-1.5-flash',
    },
    openai: {
      base_url: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
    },
    mock: {
      base_url: '',
      model: 'mock',
    },
  };

  const handleProviderChange = (newP: string) => {
    setProvider(newP);
    const def = providerDefaults[newP];
    if (def) {
      setBaseUrl(def.base_url);
      setModel(def.model);
      const savedKey = (typeof window !== 'undefined' ? localStorage.getItem(`albra_key_${newP}`) : null) || '';
      setApiKey(savedKey);
    }
  };

  const load = async () => {
    try {
      const res = await fetch('/api/provider-settings');
      if (res.ok) {
        const cfg: ProviderConfig = await res.json();
        const p = cfg.provider || 'nvidia';
        setProvider(p);
        setBaseUrl(cfg.base_url || providerDefaults[p]?.base_url || '');
        setModel(cfg.model || providerDefaults[p]?.model || '');
        setTemperature(cfg.temperature ?? 0.5);
        setTopP(cfg.top_p ?? 1.0);
        setMaxTokens(cfg.max_tokens ?? 1024);
        setTimeoutVal(cfg.timeout ?? 60);
        const k = cfg.api_key || (typeof window !== 'undefined' ? localStorage.getItem(`albra_key_${p}`) : '') || '';
        setApiKey(k);
      }
    } catch {}
    setLoading(false);
  };

  React.useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const payload = {
        provider,
        base_url: baseUrl,
        model,
        api_key: apiKey.trim(),
        temperature,
        top_p: topP,
        max_tokens: maxTokens,
        timeout: timeoutVal,
      };

      const res = await fetch('/api/provider-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      if (typeof window !== 'undefined' && apiKey.trim()) {
        localStorage.setItem(`albra_key_${provider}`, apiKey.trim());
      }

      setMsg({ type: 'ok', text: '✅ Configuración y API Key guardadas con éxito' });
      await load();
    } catch (e: any) {
      setMsg({ type: 'err', text: e?.message || 'Error al guardar configuración' });
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setMsg(null);
    try {
      const res = await fetch('/api/provider-settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          base_url: baseUrl,
          model,
          api_key: apiKey.trim(),
        }),
      });
      const d = await res.json();
      setMsg(
        d.ok
          ? { type: 'ok', text: `✅ Conexión exitosa (${d.latency_ms ? d.latency_ms.toFixed(0) : '?'}ms)` }
          : { type: 'err', text: `❌ ${d.message || 'Fallo en conexión'}` }
      );
    } catch {
      setMsg({ type: 'err', text: 'Error de red al probar proveedor' });
    } finally {
      setTesting(false);
    }
  };

  const reset = async () => {
    if (!confirm('¿Restaurar defaults (NVIDIA NIM)?')) return;
    setSaving(true);
    try {
      handleProviderChange('nvidia');
      setMsg({ type: 'ok', text: 'Restaurado a NVIDIA NIM' });
    } catch {
      setMsg({ type: 'err', text: 'Error al resetear' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="text-xs text-muted-foreground py-8 text-center">Cargando proveedor...</div>;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2">🧠 Proveedor de IA</h2>
      </div>

      {msg && (
        <div className={`p-3 rounded-lg text-xs font-medium ${msg.type === 'ok' ? 'bg-emerald-500/10 text-emerald-600 border border-emerald-500/20' : 'bg-red-500/10 text-red-600 border border-red-500/20'}`}>
          {msg.text}
        </div>
      )}

      {/* Badges row matching AGENTE GENERAL exactly */}
      <div className="flex gap-2 items-center flex-wrap">
        <div className="border border-border/80 rounded-lg px-2.5 py-1 bg-card text-xs flex items-center gap-1.5 shadow-sm">
          <span className={`w-2 h-2 rounded-full ${provider !== 'mock' ? 'bg-emerald-500' : 'bg-muted-foreground'}`} />
          <span className="font-semibold uppercase tracking-wide">{provider}</span>
        </div>
        <div className="border border-border/80 rounded-lg px-2.5 py-1 bg-card text-xs flex items-center gap-1.5 shadow-sm">
          <span className={`w-2 h-2 rounded-full ${apiKey ? 'bg-emerald-500' : 'bg-muted-foreground'}`} />
          <span>{apiKey ? 'API Key Guardada ✓' : 'Sin Key'}</span>
        </div>
        <div className="border border-border/80 rounded-lg px-2.5 py-1 bg-card text-xs flex items-center gap-1.5 shadow-sm">
          <span className="w-2 h-2 rounded-full bg-emerald-500" />
          <span>{provider === 'groq' ? '⚡ Alta Velocidad' : 'Estándar'}</span>
        </div>
      </div>

      {/* Main card matching AGENTE GENERAL layout */}
      <div className="border border-border/60 rounded-xl p-5 space-y-4 bg-card/50 shadow-sm">
        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-foreground">Proveedor</label>
          <select
            value={provider}
            onChange={(e) => handleProviderChange(e.target.value)}
            className="w-full text-xs px-3 py-2 rounded-lg border border-border bg-background focus:ring-1 focus:ring-primary outline-none"
          >
            <option value="nvidia">NVIDIA NIM (GLM 5.3 Flash / Llama 3)</option>
            <option value="groq">Groq (Ultra Rápido — Llama 3.3 / GPT-OSS 120B)</option>
            <option value="google">Google Gemini (Gemini 1.5 Flash / 2.0)</option>
            <option value="openai">OpenAI Oficial (GPT-4o / GPT-4o-mini)</option>
            <option value="mock">Mock (offline / pruebas)</option>
          </select>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-foreground">Base URL</label>
          <input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://..."
            disabled={provider === 'mock'}
            className="w-full text-xs px-3 py-2 rounded-lg border border-border bg-background focus:ring-1 focus:ring-primary outline-none font-mono"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-foreground">Modelo</label>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="z-ai/glm-5.3-flash"
            disabled={provider === 'mock'}
            className="w-full text-xs px-3 py-2 rounded-lg border border-border bg-background focus:ring-1 focus:ring-primary outline-none font-mono"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-foreground">
            API Key {apiKey ? '(Guardada ✓)' : '(No configurada)'}
          </label>
          <div className="flex gap-2 items-center">
            <input
              type={showApiKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={provider === 'nvidia' ? 'nvapi-...' : provider === 'groq' ? 'gsk_...' : 'sk-...'}
              disabled={provider === 'mock'}
              autoComplete="off"
              className="flex-1 text-xs px-3 py-2 rounded-lg border border-border bg-background focus:ring-1 focus:ring-primary outline-none font-mono"
            />
            <button
              type="button"
              onClick={() => setShowApiKey(!showApiKey)}
              className="px-3 py-2 text-xs rounded-lg border border-border bg-muted/40 hover:bg-muted text-foreground transition-all flex items-center gap-1"
            >
              {showApiKey ? '🙈 Ocultar' : '👁️ Ver'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
          <div className="space-y-1.5">
            <div className="flex justify-between items-center text-xs">
              <span className="font-semibold text-foreground">Temperatura: {temperature.toFixed(2)}</span>
            </div>
            <input
              type="range"
              min="0"
              max="2"
              step="0.05"
              value={temperature}
              onChange={(e) => setTemperature(parseFloat(e.target.value))}
              className="w-full accent-primary cursor-pointer"
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex justify-between items-center text-xs">
              <span className="font-semibold text-foreground">top_p: {topP.toFixed(2)}</span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={topP}
              onChange={(e) => setTopP(parseFloat(e.target.value))}
              className="w-full accent-primary cursor-pointer"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-foreground">Max tokens</label>
            <input
              type="number"
              min="1"
              max="32768"
              value={maxTokens}
              onChange={(e) => setMaxTokens(parseInt(e.target.value) || 1024)}
              className="w-full text-xs px-3 py-2 rounded-lg border border-border bg-background focus:ring-1 focus:ring-primary outline-none"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-foreground">Timeout (s)</label>
            <input
              type="number"
              min="1"
              max="600"
              value={timeoutVal}
              onChange={(e) => setTimeoutVal(parseInt(e.target.value) || 60)}
              className="w-full text-xs px-3 py-2 rounded-lg border border-border bg-background focus:ring-1 focus:ring-primary outline-none"
            />
          </div>
        </div>

        <div className="flex gap-2 flex-wrap pt-2">
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 text-xs font-medium rounded-lg bg-foreground text-background hover:opacity-90 disabled:opacity-50 transition-all flex items-center gap-1.5 shadow-sm"
          >
            {saving ? '⏳ Guardando...' : '💾 Guardar'}
          </button>
          <button
            onClick={test}
            disabled={testing}
            className="px-4 py-2 text-xs font-medium rounded-lg border border-border bg-muted/30 hover:bg-muted text-foreground transition-all flex items-center gap-1.5"
          >
            {testing ? '⏳ Probando...' : '🔌 Probar'}
          </button>
          <button
            onClick={reset}
            disabled={saving}
            className="px-4 py-2 text-xs font-medium rounded-lg border border-border bg-muted/30 hover:bg-muted text-foreground transition-all flex items-center gap-1.5"
          >
            ↩️ Reset
          </button>
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// 3. BÚSQUEDA Y SEÑALES SECTION (CHISMOSO OSINT & Signals APIs)
// =====================================================================

function SignalsSection() {
  const [tavily, setTavily] = React.useState('');
  const [serper, setSerper] = React.useState('');
  const [brave, setBrave] = React.useState('');
  const [github, setGithub] = React.useState('');
  const [shodan, setShodan] = React.useState('');
  const [zai, setZai] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  React.useEffect(() => {
    fetch('/api/signals-config')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) {
          setTavily(d.tavily_api_key || '');
          setSerper(d.serper_api_key || '');
          setBrave(d.brave_api_key || '');
          setGithub(d.github_token || '');
          setShodan(d.shodan_api_key || '');
          setZai(d.zai_api_key || '');
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch('/api/signals-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tavily_api_key: tavily,
          serper_api_key: serper,
          brave_api_key: brave,
          github_token: github,
          shodan_api_key: shodan,
          zai_api_key: zai,
        }),
      });
      if (!res.ok) throw new Error('Error al guardar');
      setMsg({ type: 'ok', text: '✅ APIs de inteligencia y señales guardadas con éxito' });
    } catch (e: any) {
      setMsg({ type: 'err', text: e?.message || 'Error al guardar APIs de señales' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="text-xs text-muted-foreground py-8 text-center">Cargando APIs de señales...</div>;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2">🔍 Búsqueda y Señales (OSINT / SIGINT)</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Configura los motores de búsqueda profunda y APIs de inteligencia con los que CHISMOSO rastrea la web y detecta anomalías.
        </p>
      </div>

      {msg && (
        <div className={`p-3 rounded-lg text-xs font-medium ${msg.type === 'ok' ? 'bg-emerald-500/10 text-emerald-600 border border-emerald-500/20' : 'bg-red-500/10 text-red-600 border border-red-500/20'}`}>
          {msg.text}
        </div>
      )}

      {/* Badges */}
      <div className="flex gap-2 items-center flex-wrap">
        <div className="border border-border/80 rounded-lg px-2.5 py-1 bg-card text-xs flex items-center gap-1.5 shadow-sm">
          <span className={`w-2 h-2 rounded-full ${tavily ? 'bg-emerald-500' : 'bg-muted-foreground'}`} />
          <span>Tavily {tavily ? '✓' : '(Sin key)'}</span>
        </div>
        <div className="border border-border/80 rounded-lg px-2.5 py-1 bg-card text-xs flex items-center gap-1.5 shadow-sm">
          <span className={`w-2 h-2 rounded-full ${serper ? 'bg-emerald-500' : 'bg-muted-foreground'}`} />
          <span>Serper {serper ? '✓' : '(Sin key)'}</span>
        </div>
        <div className="border border-border/80 rounded-lg px-2.5 py-1 bg-card text-xs flex items-center gap-1.5 shadow-sm">
          <span className={`w-2 h-2 rounded-full ${brave ? 'bg-emerald-500' : 'bg-muted-foreground'}`} />
          <span>Brave {brave ? '✓' : '(Sin key)'}</span>
        </div>
        <div className="border border-border/80 rounded-lg px-2.5 py-1 bg-card text-xs flex items-center gap-1.5 shadow-sm">
          <span className={`w-2 h-2 rounded-full ${github ? 'bg-emerald-500' : 'bg-muted-foreground'}`} />
          <span>GitHub {github ? '✓' : '(Sin token)'}</span>
        </div>
      </div>

      <div className="border border-border/60 rounded-xl p-5 space-y-4 bg-card/50 shadow-sm">
        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-foreground flex items-center justify-between">
            <span>Tavily Search API Key</span>
            <span className="text-[10px] text-muted-foreground font-normal">Búsqueda web optimizada para agentes de IA</span>
          </label>
          <input
            type="password"
            value={tavily}
            onChange={(e) => setTavily(e.target.value)}
            placeholder="tvly-..."
            className="w-full text-xs px-3 py-2 rounded-lg border border-border bg-background focus:ring-1 focus:ring-primary outline-none font-mono"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-foreground flex items-center justify-between">
            <span>Serper API Key (Google Search)</span>
            <span className="text-[10px] text-muted-foreground font-normal">Rastreo de Google Search y Google News</span>
          </label>
          <input
            type="password"
            value={serper}
            onChange={(e) => setSerper(e.target.value)}
            placeholder="Serper API key..."
            className="w-full text-xs px-3 py-2 rounded-lg border border-border bg-background focus:ring-1 focus:ring-primary outline-none font-mono"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-foreground flex items-center justify-between">
            <span>Brave Search API Key</span>
            <span className="text-[10px] text-muted-foreground font-normal">Índice web independiente sin censura</span>
          </label>
          <input
            type="password"
            value={brave}
            onChange={(e) => setBrave(e.target.value)}
            placeholder="BSA..."
            className="w-full text-xs px-3 py-2 rounded-lg border border-border bg-background focus:ring-1 focus:ring-primary outline-none font-mono"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-foreground flex items-center justify-between">
            <span>GitHub Personal Access Token</span>
            <span className="text-[10px] text-muted-foreground font-normal">Auditoría de repositorios, commits y clones</span>
          </label>
          <input
            type="password"
            value={github}
            onChange={(e) => setGithub(e.target.value)}
            placeholder="ghp_... o github_pat_..."
            className="w-full text-xs px-3 py-2 rounded-lg border border-border bg-background focus:ring-1 focus:ring-primary outline-none font-mono"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-foreground">Shodan API Key</label>
            <input
              type="password"
              value={shodan}
              onChange={(e) => setShodan(e.target.value)}
              placeholder="Shodan key..."
              className="w-full text-xs px-3 py-2 rounded-lg border border-border bg-background focus:ring-1 focus:ring-primary outline-none font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-foreground">Z-AI Web Dev SDK Key</label>
            <input
              type="password"
              value={zai}
              onChange={(e) => setZai(e.target.value)}
              placeholder="zai_..."
              className="w-full text-xs px-3 py-2 rounded-lg border border-border bg-background focus:ring-1 focus:ring-primary outline-none font-mono"
            />
          </div>
        </div>

        <button
          onClick={save}
          disabled={saving}
          className="px-4 py-2 text-xs font-medium rounded-lg bg-foreground text-background hover:opacity-90 disabled:opacity-50 transition-all flex items-center gap-1.5 shadow-sm"
        >
          {saving ? '⏳ Guardando...' : '💾 Guardar APIs de señales'}
        </button>
      </div>
    </div>
  );
}

// =====================================================================
// 4. TELEGRAM SECTION (Matches AGENTE GENERAL screenshots exactly)
// =====================================================================

function TelegramSection() {
  const [token, setToken] = React.useState('');
  const [tokenSet, setTokenSet] = React.useState(false);
  const [enabled, setEnabled] = React.useState(false);
  const [status, setStatus] = React.useState<'unknown' | 'connected' | 'disconnected'>('unknown');
  const [botUsername, setBotUsername] = React.useState<string | null>(null);
  const [testing, setTesting] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  React.useEffect(() => {
    fetch('/api/telegram')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) {
          setTokenSet(Boolean(d.token_set));
          setEnabled(Boolean(d.enabled));
          if (d.bot_username) {
            setBotUsername(d.bot_username);
            setStatus('connected');
          } else if (d.token_set) {
            setStatus('disconnected');
          } else {
            setStatus('unknown');
          }
        }
      })
      .catch(() => setStatus('unknown'));
  }, []);

  const saveToken = async () => {
    if (!token.trim()) return;
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch('/api/telegram', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.trim(), enabled: true }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setToken('');
      setTokenSet(true);
      setEnabled(true);
      setMsg({ type: 'ok', text: '✅ Token de Telegram guardado' });
    } catch {
      setMsg({ type: 'err', text: 'No se pudo guardar el token de Telegram' });
    } finally {
      setSaving(false);
    }
  };

  const testConn = async () => {
    setTesting(true);
    setMsg(null);
    try {
      const res = await fetch('/api/telegram', { method: 'POST' });
      const d = await res.json();
      if (d.ok) {
        setStatus('connected');
        setBotUsername(d.bot_username || null);
        setMsg({ type: 'ok', text: `✅ Conectado a @${d.bot_username || 'bot'}` });
      } else {
        setStatus('disconnected');
        setMsg({ type: 'err', text: `❌ ${d.message || 'Error de conexión'}` });
      }
    } catch {
      setMsg({ type: 'err', text: 'Endpoint de Telegram no disponible' });
    } finally {
      setTesting(false);
    }
  };

  const toggle = async () => {
    const v = !enabled;
    setEnabled(v);
    try {
      await fetch('/api/telegram', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: v }),
      });
      setMsg({ type: 'ok', text: v ? 'Telegram Activado' : 'Telegram Desactivado' });
    } catch {
      setEnabled(!v);
      setMsg({ type: 'err', text: 'Error al cambiar estado' });
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2">✈️ Telegram</h2>
      </div>

      {msg && (
        <div className={`p-3 rounded-lg text-xs font-medium ${msg.type === 'ok' ? 'bg-emerald-500/10 text-emerald-600 border border-emerald-500/20' : 'bg-red-500/10 text-red-600 border border-red-500/20'}`}>
          {msg.text}
        </div>
      )}

      {/* Top Status Card matching AGENTE GENERAL image 3 */}
      <div className="border border-border/60 rounded-xl p-4 bg-card/50 shadow-sm flex justify-between items-center">
        <div className="flex items-center gap-2">
          <span
            className={`w-2.5 h-2.5 rounded-full ${
              status === 'connected' ? 'bg-emerald-500' : status === 'disconnected' ? 'bg-red-500' : 'bg-muted-foreground'
            }`}
          />
          <span className="text-xs font-medium">
            {status === 'connected' ? `Conectado (@${botUsername || 'bot'})` : status === 'disconnected' ? 'Desconectado' : 'Sin configurar'}
          </span>
        </div>
        <label className="flex items-center gap-2 cursor-pointer text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={enabled}
            onChange={toggle}
            disabled={!tokenSet}
            className="accent-primary rounded cursor-pointer"
          />
          <span>{enabled ? 'Activo' : 'Inactivo'}</span>
        </label>
      </div>

      {/* Form Card matching AGENTE GENERAL image 3 */}
      <div className="border border-border/60 rounded-xl p-5 space-y-4 bg-card/50 shadow-sm">
        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-foreground">
            Bot Token {tokenSet && '(configurado ✓)'}
          </label>
          <div className="flex gap-2">
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={tokenSet ? '••••••••••••••••••••••••••••••••••••' : '123456789:ABC...'}
              className="flex-1 text-xs px-3 py-2 rounded-lg border border-border bg-background focus:ring-1 focus:ring-primary outline-none font-mono"
              autoComplete="off"
            />
            <button
              onClick={saveToken}
              disabled={saving || !token.trim()}
              className="px-4 py-2 text-xs font-medium rounded-lg bg-foreground text-background hover:opacity-90 disabled:opacity-50 transition-all flex items-center justify-center shadow-sm"
              title="Guardar token"
            >
              {saving ? '⏳' : '💾'}
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground pt-0.5">
            Obtén tu token en{' '}
            <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">
              @BotFather
            </a>
          </p>
        </div>

        <button
          onClick={testConn}
          disabled={testing || !tokenSet}
          className="px-4 py-2 text-xs font-medium rounded-lg border border-border bg-muted/30 hover:bg-muted text-foreground transition-all flex items-center gap-1.5"
        >
          {testing ? '⏳ Verificando...' : '🔌 Verificar conexión'}
        </button>

        {!tokenSet && (
          <div className="p-3 rounded-lg text-xs font-medium bg-amber-500/10 text-amber-600 border border-amber-500/20 flex items-center gap-2">
            <span>⚠️</span>
            <span>Configura el token del bot.</span>
          </div>
        )}
      </div>
    </div>
  );
}

// =====================================================================
// 5. WHATSAPP SECTION (Matches AGENTE GENERAL screenshots exactly)
// =====================================================================

function WhatsAppSection() {
  const [status, setStatus] = React.useState<'unknown' | 'connected' | 'disconnected' | 'linking'>('unknown');
  const [qrCode, setQrCode] = React.useState<string | null>(null);
  const [phone, setPhone] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [connecting, setConnecting] = React.useState(false);
  const [msg, setMsg] = React.useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchQr = async () => {
    try {
      const res = await fetch('/api/whatsapp/daemon-proxy?path=/qr');
      if (res.ok) {
        const data = await res.json();
        if (data.qr) setQrCode(data.qr);
      }
    } catch {}
  };

  const loadStatus = async () => {
    try {
      const res = await fetch('/api/whatsapp/daemon-proxy?path=/status');
      if (!res.ok) {
        setStatus('disconnected');
        return;
      }
      const data = await res.json();
      if (data.status === 'connected') {
        setStatus('connected');
        setPhone(data.phone || null);
        setQrCode(null);
      } else if (data.status === 'linking') {
        setStatus('linking');
        await fetchQr();
      } else {
        setStatus(data.status || 'disconnected');
      }
    } catch {
      setStatus('disconnected');
    }
  };

  React.useEffect(() => {
    void loadStatus().finally(() => setLoading(false));

    pollRef.current = setInterval(() => {
      fetch('/api/whatsapp/daemon-proxy?path=/status')
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!data) return;
          if (data.status === 'connected') {
            setStatus('connected');
            setPhone(data.phone || null);
            setQrCode(null);
          } else if (data.status === 'linking') {
            setStatus('linking');
            fetchQr();
          } else if (data.status === 'disconnected') {
            setStatus('disconnected');
            setQrCode(null);
          }
        })
        .catch(() => {});
    }, 5000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const connect = async () => {
    setConnecting(true);
    setMsg(null);
    setQrCode(null);
    try {
      const res = await fetch('/api/whatsapp/daemon-proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/connect' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setMsg({ type: 'ok', text: 'Iniciando conexión WhatsApp... Escanea el código QR' });
      setStatus('linking');
      setTimeout(fetchQr, 2000);
    } catch {
      setMsg({ type: 'err', text: 'WhatsApp Daemon no responde en puerto 3002. Inícialo si deseas vincular QR.' });
      setStatus('disconnected');
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    if (!confirm('¿Desconectar WhatsApp?')) return;
    try {
      await fetch('/api/whatsapp/daemon-proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/disconnect' }),
      });
      setStatus('disconnected');
      setPhone(null);
      setQrCode(null);
      setMsg({ type: 'ok', text: 'WhatsApp Desconectado' });
    } catch {
      setMsg({ type: 'err', text: 'Error al desconectar' });
    }
  };

  if (loading) return <div className="text-xs text-muted-foreground py-8 text-center">Cargando WhatsApp...</div>;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2">📱 WhatsApp</h2>
      </div>

      {msg && (
        <div className={`p-3 rounded-lg text-xs font-medium ${msg.type === 'ok' ? 'bg-emerald-500/10 text-emerald-600 border border-emerald-500/20' : 'bg-red-500/10 text-red-600 border border-red-500/20'}`}>
          {msg.text}
        </div>
      )}

      {/* Status card matching AGENTE GENERAL image 4 */}
      <div className="border border-border/60 rounded-xl p-4 bg-card/50 shadow-sm flex justify-between items-center">
        <div className="flex items-center gap-2">
          <span
            className={`w-2.5 h-2.5 rounded-full ${
              status === 'connected' ? 'bg-emerald-500' : status === 'linking' ? 'bg-amber-500' : 'bg-muted-foreground'
            }`}
          />
          <span className="text-xs font-medium">
            {status === 'connected'
              ? `Conectado${phone ? ` — ${phone}` : ''}`
              : status === 'linking'
              ? 'Esperando QR...'
              : 'Desconectado'}
          </span>
        </div>
        {status === 'connected' ? (
          <button onClick={disconnect} className="px-3 py-1.5 text-xs rounded-lg border border-red-500/30 text-red-500 hover:bg-red-500/10 transition-all">
            🔌 Desconectar
          </button>
        ) : (
          <button
            onClick={connect}
            disabled={connecting || status === 'linking'}
            className="px-4 py-2 text-xs font-medium rounded-lg bg-foreground text-background hover:opacity-90 disabled:opacity-50 transition-all flex items-center gap-1.5 shadow-sm"
          >
            {connecting ? '⏳' : status === 'linking' ? '🔄 Esperando...' : '📱 Conectar por QR'}
          </button>
        )}
      </div>

      {/* QR Code Container matching AGENTE GENERAL image 4 */}
      {(status === 'linking' || status === 'disconnected') && (
        <div className="border border-border/60 rounded-xl p-8 bg-card/50 shadow-sm text-center space-y-4">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-foreground">Escanea el código QR</h3>
            <p className="text-xs text-muted-foreground">
              Abre WhatsApp en tu teléfono → Configuración → Dispositivos vinculados → Escanear código QR
            </p>
          </div>

          <div className="flex justify-center py-2">
            {qrCode ? (
              <div className="p-4 bg-white rounded-xl shadow-md inline-block">
                {qrCode.startsWith('data:image') || qrCode.startsWith('http') ? (
                  <img src={qrCode} alt="WhatsApp QR Code" className="w-56 h-56 rounded-lg object-contain" />
                ) : (
                  <div className="w-56 h-56 bg-zinc-100 flex items-center justify-center text-zinc-600 text-xs text-center p-3 rounded-lg font-mono break-all">
                    {qrCode}
                  </div>
                )}
              </div>
            ) : (
              <div className="w-56 h-56 border-2 border-dashed border-border rounded-xl flex flex-col items-center justify-center gap-2 bg-muted/20">
                <span className="text-2xl">📱</span>
                <span className="text-xs text-muted-foreground font-medium">
                  {status === 'linking' ? 'Generando QR de WhatsApp...' : 'Haz clic en "Conectar por QR"'}
                </span>
              </div>
            )}
          </div>

          <div>
            <button
              onClick={fetchQr}
              className="px-4 py-2 text-xs font-medium rounded-lg border border-border bg-muted/30 hover:bg-muted text-foreground transition-all inline-flex items-center gap-1.5"
            >
              🔄 Refrescar QR
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
