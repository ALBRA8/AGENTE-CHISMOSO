'use client';

import { Button } from '@/components/ui/button';
import { Activity, Target, TrendingUp, Search } from 'lucide-react';

const QUICK_ACTIONS = [
  { label: 'Qué viste hoy', icon: Activity, prompt: 'qué viste hoy' },
  { label: 'Anomalías', icon: TrendingUp, prompt: 'muéstrame las anomalías activas' },
  { label: 'Topics', icon: Search, prompt: 'qué topics estás vigilando' },
  { label: 'Top oportunidades', icon: Target, prompt: 'cuáles son las top 3 oportunidades' },
] as const;

/**
 * ChatQuickActions — compact row of prompt chips above the chat input.
 *
 * Each chip fires `onAction(prompt)` with a pre-written telegram-style
 * instruction. Disabled while a request is in flight to avoid stacking
 * concurrent SSE streams.
 */
export function ChatQuickActions({ onAction, disabled }: {
  onAction: (prompt: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1 px-2 py-1.5 border-t bg-muted/30">
      {QUICK_ACTIONS.map((qa) => (
        <Button
          key={qa.label}
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => onAction(qa.prompt)}
          className="h-7 text-[10px] px-2 gap-1"
        >
          <qa.icon className="h-3 w-3" />
          {qa.label}
        </Button>
      ))}
    </div>
  );
}
