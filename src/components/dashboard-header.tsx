'use client';

import { Radar, MessageSquare, Search, BarChart3, Settings, Sun, Moon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

export type DashboardTab = 'agent' | 'investigator' | 'summary' | 'settings';

interface DashboardHeaderProps {
  version?: string;
  activeTab?: DashboardTab;
  onTabChange?: (tab: DashboardTab) => void;
}

export function DashboardHeader({
  version = 'v1.0',
  activeTab = 'investigator',
  onTabChange,
}: DashboardHeaderProps) {
  const dark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

  const toggleTheme = () => {
    const isDark = document.documentElement.classList.contains('dark');
    if (isDark) {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    } else {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    }
  };

  const tabs: { key: DashboardTab; label: string; icon: typeof Radar }[] = [
    { key: 'agent', label: 'Agente', icon: MessageSquare },
    { key: 'investigator', label: 'Investigar', icon: Search },
    { key: 'summary', label: 'Resumen', icon: BarChart3 },
    { key: 'settings', label: 'Config', icon: Settings },
  ];

  return (
    <header className="sticky top-0 z-30 glass border-b border-border/40">
      <div className="container mx-auto px-4 py-2.5 flex items-center justify-between gap-3">
        {/* Brand */}
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className="h-9 w-9 rounded-xl bg-gradient-to-br from-violet-500 via-fuchsia-500 to-pink-500 flex items-center justify-center text-white shrink-0 shadow-lg shadow-violet-500/20"
            aria-hidden
          >
            <Radar className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h1 className="text-base font-bold tracking-tight leading-none gradient-text">
              CHISMOSO
            </h1>
            <p className="text-[10px] text-muted-foreground leading-none mt-0.5 truncate hidden sm:block">
              Inteligencia de señales
            </p>
          </div>
          <Badge variant="outline" className="text-[10px] ml-1 shrink-0 hidden md:inline-flex glass">
            {version}
          </Badge>
        </div>

        {/* Navigation */}
        {onTabChange && (
          <nav className="flex items-center gap-0.5 glass rounded-xl p-1">
            {tabs.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => onTabChange(key)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-all ${
                  activeTab === key
                    ? 'bg-primary/15 text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/40'
                }`}
              >
                <Icon className={`h-3.5 w-3.5 ${activeTab === key ? 'text-primary' : ''}`} />
                <span className="hidden sm:inline">{label}</span>
              </button>
            ))}
          </nav>
        )}

        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          className="h-8 w-8 rounded-lg glass glass-hover flex items-center justify-center text-muted-foreground hover:text-foreground"
          aria-label="Toggle theme"
        >
          {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
      </div>
    </header>
  );
}
