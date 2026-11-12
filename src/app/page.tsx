'use client';

import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { CircleDot } from 'lucide-react';
import { DashboardHeader, type DashboardTab } from '@/components/dashboard-header';
import { InvestigationPanel } from '@/components/investigation-panel';
import { DashboardSummary } from '@/components/dashboard-summary';
import { ChatToggle } from '@/components/chat-toggle';
import { ChatAgent } from '@/components/chat-agent';
import { SettingsView } from '@/components/settings-view';

interface FooterStats {
  investigations: number;
  providers: number;
  meshEnabled: boolean;
  version: string;
}

const DEFAULT_STATS: FooterStats = {
  investigations: 0,
  providers: 0,
  meshEnabled: false,
  version: 'v1.9',
};

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export default function Home() {
  const [activeTab, setActiveTab] = React.useState<DashboardTab>('investigator');
  const [chatOpen, setChatOpen] = React.useState(false);
  const [stats, setStats] = React.useState<FooterStats>(DEFAULT_STATS);
  const [refreshSignal, setRefreshSignal] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [invRes, provRes, meshRes, verRes] = await Promise.all([
        fetchJson<{ investigations: unknown[] }>('/api/investigations'),
        fetchJson<{ providers: unknown[] }>('/api/providers'),
        fetchJson<{ enabled?: boolean }>('/api/mesh/config'),
        fetchJson<{ version?: string }>('/api/version'),
      ]);
      if (cancelled) return;
      setStats({
        investigations: invRes?.investigations?.length ?? 0,
        providers: provRes?.providers?.length ?? 0,
        meshEnabled: Boolean(meshRes?.enabled),
        version: verRes?.version ? `v${verRes.version}` : DEFAULT_STATS.version,
      });
    })();
    return () => { cancelled = true; };
  }, [refreshSignal]);

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <DashboardHeader
        version={stats.version}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />

      <main className="container mx-auto px-4 py-6 flex-1 w-full max-w-5xl flex flex-col fade-in">
        {activeTab === 'agent' && (
          <div className="flex-1 w-full flex flex-col items-center">
            <ChatAgent mode="embedded" />
          </div>
        )}

        {activeTab === 'investigator' && (
          <InvestigationPanel
            onInvestigationsChanged={() => setRefreshSignal((s) => s + 1)}
            onOpenChat={() => setActiveTab('agent')}
          />
        )}

        {activeTab === 'summary' && (
          <div className="space-y-6">
            <DashboardSummary />
          </div>
        )}

        {activeTab === 'settings' && (
          <SettingsView />
        )}
      </main>

      <footer className="border-t border-border/40 bg-background/50 backdrop-blur mt-auto">
        <div className="container mx-auto px-4 py-2.5 flex items-center justify-between text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Badge variant="outline" className="text-[10px] py-0 px-1.5 glass">
              {stats.version}
            </Badge>
            <span>·</span>
            <span>{stats.providers} providers</span>
            <span>·</span>
            <span>{stats.investigations} investigaciones</span>
            {stats.meshEnabled && (
              <>
                <span>·</span>
                <span className="text-emerald-500">mesh activo</span>
              </>
            )}
          </span>
          <span className="hidden sm:flex items-center gap-1">
            <CircleDot className="h-3 w-3" />
            SQLite · z-ai · ReAct · MCP · Mesh
          </span>
        </div>
      </footer>

      {activeTab !== 'agent' && (
        <>
          <ChatToggle open={chatOpen} onToggle={() => setChatOpen(!chatOpen)} />
          <ChatAgent mode="sidebar" open={chatOpen} onClose={() => setChatOpen(false)} />
        </>
      )}
    </div>
  );
}
