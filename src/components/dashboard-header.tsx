'use client';

/**
 * DashboardHeader
 *
 * Sticky top bar extracted from the old monolithic `page.tsx`. Renders:
 *   - Logo (violet→fuchsia gradient square with the Radar icon)
 *   - Title + tagline
 *   - Right toolbar: theme toggle + settings button
 *
 * The header stays sticky at the top of the viewport (`sticky top-0 z-30`)
 * with a translucent backdrop blur so content scrolls cleanly underneath.
 *
 * Why extracted:
 *   - The old `page.tsx` inlined ~30 lines of header JSX plus its imports.
 *     Pulling it into its own component lets `page.tsx` focus on layout
 *     composition and keeps the header's dependencies (theme-toggle,
 *     settings-panel) local.
 */
import { Radar } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { ThemeToggle } from '@/components/theme-toggle';
import { SettingsPanel } from '@/components/settings-panel';

interface DashboardHeaderProps {
  /** Optional version badge text (e.g. "v1.8"). Defaults to "v1.0". */
  version?: string;
}

export function DashboardHeader({ version = 'v1.0' }: DashboardHeaderProps) {
  return (
    <header className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 sticky top-0 z-30">
      <div className="container mx-auto px-4 py-3 flex items-center justify-between gap-3">
        {/* Brand */}
        <div className="flex items-center gap-2 min-w-0">
          <div
            className="h-8 w-8 rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center text-white shrink-0"
            aria-hidden
          >
            <Radar className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h1 className="text-base font-semibold tracking-tight leading-none truncate">
              CHISMOSO
            </h1>
            <p className="text-[10px] text-muted-foreground leading-none mt-0.5 truncate">
              Inteligencia de señales · tendencias · oportunidades
            </p>
          </div>
          <Badge variant="outline" className="text-[10px] ml-1 shrink-0 hidden sm:inline-flex">
            {version}
          </Badge>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-1 shrink-0">
          <ThemeToggle />
          <SettingsPanel />
        </div>
      </div>
    </header>
  );
}
