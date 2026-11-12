'use client';

import * as React from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Brain, MessageCircle, Server, Network, Bell, Database, Shield, HardDrive } from 'lucide-react';

interface ConfigSection {
  key: string;
  value: string;
  category: string;
  description?: string;
  isSecret?: boolean;
}

export function SettingsView() {
  const [config, setConfig] = React.useState<Record<string, Record<string, ConfigSection>>>({});
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState<string | null>(null);
  const [whatsappTest, setWhatsappTest] = React.useState<{ status: string; message: string } | null>(null);

  // WhatsApp form state
  const [waType, setWaType] = React.useState<'webhook' | 'daemon'>('webhook');
  const [waWebhookUrl, setWaWebhookUrl] = React.useState('');
  const [waDaemonUrl, setWaDaemonUrl] = React.useState('');
  const [waPhone, setWaPhone] = React.useState('');
  const [waEnabled, setWaEnabled] = React.useState(false);

  // LLM form state
  const [llmModel, setLlmModel] = React.useState('');
  const [llmTemp, setLlmTemp] = React.useState('0.7');

  React.useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(data => {
        setConfig(data.config ?? {});
        // Load WhatsApp settings from config
        const wa = data.config?.whatsapp ?? {};
        setWaType((wa['whatsapp.connection_type']?.value as any) ?? 'webhook');
        setWaWebhookUrl(wa['whatsapp.webhook_url']?.value ?? '');
        setWaDaemonUrl(wa['whatsapp.daemon_url']?.value ?? '');
        setWaPhone(wa['whatsapp.phone_number']?.value ?? '');
        setWaEnabled(wa['whatsapp.enabled']?.value === 'true');
        // Load LLM settings
        const llm = data.config?.llm ?? {};
        setLlmModel(llm['llm.model']?.value ?? '');
        setLlmTemp(llm['llm.temperature']?.value ?? '0.7');
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const saveSettings = async (category: string, settings: Array<{ key: string; value: string; category: string; description?: string; isSecret?: boolean }>) => {
    setSaving(category);
    setSaved(null);
    try {
      const r = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings }),
      });
      const data = await r.json();
      if (r.ok) {
        setSaved(`${category}: ${data.message ?? 'guardado'}`);
        setTimeout(() => setSaved(null), 3000);
      } else {
        setSaved(`Error: ${data.error ?? 'no se pudo guardar'}`);
      }
    } catch (e: any) {
      setSaved(`Error: ${e?.message ?? 'fetch failed'}`);
    } finally {
      setSaving(null);
    }
  };

  const testWhatsapp = async () => {
    setWhatsappTest({ status: 'testing', message: 'Enviando...' });
    try {
      const r = await fetch('/api/config/whatsapp/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: waPhone }),
      });
      const data = await r.json();
      if (r.ok) {
        setWhatsappTest({ status: 'ok', message: `✅ Enviado via ${data.via}` });
      } else {
        setWhatsappTest({ status: 'error', message: `❌ ${data.error ?? data.details ?? 'error'}` });
      }
    } catch (e: any) {
      setWhatsappTest({ status: 'error', message: `❌ ${e?.message ?? 'fetch failed'}` });
    }
  };

  if (loading) {
    return <div className="text-sm text-muted-foreground py-8 text-center">Cargando configuración...</div>;
  }

  return (
    <div className="space-y-4 max-w-2xl mx-auto w-full">
      {saved && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 glass rounded-lg px-4 py-2 text-xs shadow-lg fade-in">
          {saved}
        </div>
      )}

      {/* WhatsApp */}
      <Card className="glass glass-hover p-5 space-y-3">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-lg bg-emerald-500/15 flex items-center justify-center">
            <MessageCircle className="h-4 w-4 text-emerald-500" />
          </div>
          <h3 className="text-sm font-semibold">WhatsApp</h3>
          <Badge variant={waEnabled ? 'default' : 'secondary'} className="text-[10px]">
            {waEnabled ? 'Activo' : 'Inactivo'}
          </Badge>
        </div>

        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">Tipo de conexión</Label>
          <div className="flex gap-2">
            <button
              onClick={() => setWaType('webhook')}
              className={`px-3 py-1.5 text-xs rounded-lg transition-all ${waType === 'webhook' ? 'bg-primary/15 text-foreground' : 'bg-muted/30 text-muted-foreground'}`}
            >
              Webhook (n8n/Zapier)
            </button>
            <button
              onClick={() => setWaType('daemon')}
              className={`px-3 py-1.5 text-xs rounded-lg transition-all ${waType === 'daemon' ? 'bg-primary/15 text-foreground' : 'bg-muted/30 text-muted-foreground'}`}
            >
              Daemon (Baileys)
            </button>
          </div>
        </div>

        {waType === 'webhook' ? (
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">URL del webhook</Label>
            <Input
              placeholder="https://n8n.tu-server.com/webhook/chismoso-whatsapp"
              value={waWebhookUrl}
              onChange={e => setWaWebhookUrl(e.target.value)}
              className="text-sm glass"
            />
            <p className="text-[10px] text-muted-foreground">
              CHISMOSO envía opportunities/alerts a esta URL. Tu n8n las reenvía a WhatsApp.
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">URL del daemon Baileys</Label>
            <Input
              placeholder="http://localhost:3002"
              value={waDaemonUrl}
              onChange={e => setWaDaemonUrl(e.target.value)}
              className="text-sm glass"
            />
            <p className="text-[10px] text-muted-foreground">
              El daemon de AGENTE-GENERAL. Ver docs para setup.
            </p>
          </div>
        )}

        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Número destino (E.164)</Label>
          <Input
            placeholder="+573001234567"
            value={waPhone}
            onChange={e => setWaPhone(e.target.value)}
            className="text-sm glass"
          />
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setWaEnabled(!waEnabled)}
            className={`relative h-5 w-9 rounded-full transition-colors ${waEnabled ? 'bg-emerald-500' : 'bg-muted'}`}
          >
            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${waEnabled ? 'left-4' : 'left-0.5'}`} />
          </button>
          <span className="text-xs text-muted-foreground">Enviar alertas por WhatsApp</span>
        </div>

        <div className="flex gap-2 pt-1">
          <Button
            size="sm"
            onClick={() => saveSettings('whatsapp', [
              { key: 'whatsapp.connection_type', value: waType, category: 'whatsapp', description: 'webhook or daemon' },
              { key: 'whatsapp.webhook_url', value: waWebhookUrl, category: 'whatsapp' },
              { key: 'whatsapp.daemon_url', value: waDaemonUrl, category: 'whatsapp' },
              { key: 'whatsapp.phone_number', value: waPhone, category: 'whatsapp' },
              { key: 'whatsapp.enabled', value: String(waEnabled), category: 'whatsapp' },
            ])}
            disabled={saving === 'whatsapp'}
            className="gradient-btn text-xs"
          >
            {saving === 'whatsapp' ? 'Guardando...' : 'Guardar'}
          </Button>
          <Button size="sm" variant="outline" onClick={testWhatsapp} className="glass text-xs">
            Probar
          </Button>
        </div>
        {whatsappTest && (
          <p className={`text-[10px] ${whatsappTest.status === 'ok' ? 'text-emerald-500' : whatsappTest.status === 'error' ? 'text-red-500' : 'text-muted-foreground'}`}>
            {whatsappTest.message}
          </p>
        )}
      </Card>

      {/* LLM */}
      <Card className="glass glass-hover p-5 space-y-3">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-lg bg-violet-500/15 flex items-center justify-center">
            <Brain className="h-4 w-4 text-violet-500" />
          </div>
          <h3 className="text-sm font-semibold">Modelo LLM</h3>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Modelo</Label>
            <Input value={llmModel} onChange={e => setLlmModel(e.target.value)} placeholder="default" className="text-sm glass" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Temperatura</Label>
            <Input value={llmTemp} onChange={e => setLlmTemp(e.target.value)} placeholder="0.7" className="text-sm glass" />
          </div>
        </div>
        <Button size="sm" onClick={() => saveSettings('llm', [
          { key: 'llm.model', value: llmModel, category: 'llm' },
          { key: 'llm.temperature', value: llmTemp, category: 'llm' },
        ])} disabled={saving === 'llm'} className="gradient-btn text-xs">
          {saving === 'llm' ? 'Guardando...' : 'Guardar'}
        </Button>
      </Card>

      {/* Providers */}
      <Card className="glass glass-hover p-5 space-y-2">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-lg bg-sky-500/15 flex items-center justify-center">
            <Server className="h-4 w-4 text-sky-500" />
          </div>
          <h3 className="text-sm font-semibold">Providers</h3>
        </div>
        <p className="text-[10px] text-muted-foreground">
          Configura los providers con: <code className="glass px-1 rounded">chismoso mcp add/remove</code> en CLI
        </p>
      </Card>

      {/* Mesh */}
      <Card className="glass glass-hover p-5 space-y-2">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-lg bg-fuchsia-500/15 flex items-center justify-center">
            <Network className="h-4 w-4 text-fuchsia-500" />
          </div>
          <h3 className="text-sm font-semibold">Multi-Agent Mesh</h3>
        </div>
        <p className="text-[10px] text-muted-foreground">
          Suscribir agentes: <code className="glass px-1 rounded">chismoso mesh subscribe --agent=AGENTE-LEADS --url=...</code>
        </p>
      </Card>

      {/* Alerts */}
      <Card className="glass glass-hover p-5 space-y-2">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-lg bg-amber-500/15 flex items-center justify-center">
            <Bell className="h-4 w-4 text-amber-500" />
          </div>
          <h3 className="text-sm font-semibold">Alertas</h3>
        </div>
        <p className="text-[10px] text-muted-foreground">
          Umbral de anomalías y cooldown configurables via CLI: <code className="glass px-1 rounded">chismoso anomalies</code>
        </p>
      </Card>

      {/* Auth + Backups */}
      <div className="grid grid-cols-2 gap-3">
        <Card className="glass glass-hover p-4 space-y-1">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-red-500" />
            <h4 className="text-xs font-semibold">Auth</h4>
          </div>
          <p className="text-[10px] text-muted-foreground">
            <code className="glass px-1 rounded">chismoso auth token</code> para generar tokens
          </p>
        </Card>
        <Card className="glass glass-hover p-4 space-y-1">
          <div className="flex items-center gap-2">
            <HardDrive className="h-4 w-4 text-blue-500" />
            <h4 className="text-xs font-semibold">Backups</h4>
          </div>
          <p className="text-[10px] text-muted-foreground">
            <code className="glass px-1 rounded">bash scripts/backup-sqlite.sh</code>
          </p>
        </Card>
      </div>
    </div>
  );
}
