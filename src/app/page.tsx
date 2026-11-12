'use client';

/**
 * CHISMOSO dashboard — V2 (Task IMP-DASHBOARD-V2)
 *
 * Thin composition layer. The old monolithic 1300-line `page.tsx` has been
 * split into focused components:
 *
 *   - <DashboardHeader>     — logo, title, theme toggle, settings button
 *   - <InvestigationPanel>  — form, results, dashboard summary, document upload dialog,
 *                              and the Intel dialog trigger
 *   - <ChatToggle> + <ChatAgent> — floating chat sidebar (unchanged)
 *
 * This file owns only the page-level state that spans multiple components:
 *   - chatOpen       — whether the chat sidebar is open (reserves 380px on lg)
 *   - footer stats   — investigation count, provider count, mesh status
 *                      (fetched on mount + refreshed when investigations change)
 *
 * Layout:
 *   - Sticky header at the top.
 *   - Centered main column (max-w-7xl) with the investigation panel.
 *   - Sticky footer at the bottom (mt-auto) showing version + counts.
 *   - Floating chat toggle + chat sidebar overlay.
 *
 * The chat sidebar, when open on lg+ screens, reserves 380px on the right
 * via `lg:pr-[380px]` on the root wrapper so it never overlaps content.
 */

import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { CircleDot } from 'lucide-react';
import { DashboardHeader } from '@/components/dashboard-header';
import { InvestigationPanel } from '@/components/investigation-panel';
import { ChatToggle } from '@/components/chat-toggle';
import { ChatAgent } from '@/components/chat-agent';

// ---------------------------------------------------------------------------
// Footer stats — fetched independently so the footer stays in sync without
// the InvestigationPanel having to push counts up on every change.
// ---------------------------------------------------------------------------

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
  version: 'v1.8',
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

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Home() {
  const [chatOpen, setChatOpen] = React.useState(false);
  const [stats, setStats] = React.useState<FooterStats>(DEFAULT_STATS);
  const [refreshSignal, setRefreshSignal] = React.useState(0);

  // Refresh footer stats on mount and whenever the InvestigationPanel
  // signals that investigations changed (new run, document ingest, etc.).
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
    return () => {
      cancelled = true;
    };
  }, [refreshSignal]);

  return (
    <div
      className={`min-h-screen flex flex-col bg-gradient-to-b from-background to-muted/30 transition-[padding] duration-300 ${
        chatOpen ? 'lg:pr-[380px]' : ''
      }`}
    >
      <DashboardHeader version={stats.version} />

      <main className="container mx-auto px-4 py-6 flex-1 w-full max-w-7xl">
        <InvestigationPanel
          onInvestigationsChanged={() => setRefreshSignal((s) => s + 1)}
          onOpenChat={() => setChatOpen(true)}
        />
      </main>

      <footer className="border-t bg-background mt-auto">
        <div className="container mx-auto px-4 py-3 flex items-center justify-between text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Badge variant="outline" className="text-[10px] py-0 px-1.5">
              {stats.version}
            </Badge>
            <span>·</span>
            <span>{stats.providers} providers</span>
            <span>·</span>
            <span>{stats.investigations} investigaciones</span>
            {stats.meshEnabled && (
              <>
                <span>·</span>
                <span className="text-emerald-600 dark:text-emerald-400">mesh activo</span>
              </>
            )}
          </span>
          <span className="hidden sm:flex items-center gap-1">
            <CircleDot className="h-3 w-3" />
            SQLite · z-ai-web-dev-sdk · ReAct · SSE · Embeddings · Mesh
          </span>
        </div>
      </footer>

      {/* Floating chat toggle + chat sidebar.
          Rendered at the end of the wrapper so the `lg:pr-[380px]` above
          reserves space on large screens and the chat overlays correctly. */}
      <ChatToggle open={chatOpen} onToggle={() => setChatOpen(!chatOpen)} />
      <ChatAgent open={chatOpen} onClose={() => setChatOpen(false)} />
    </div>
  );
}
