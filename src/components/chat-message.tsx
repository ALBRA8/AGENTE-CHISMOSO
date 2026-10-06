'use client';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { User, Bot, Wrench, AlertTriangle } from 'lucide-react';

export type ChatRole = 'user' | 'assistant' | 'tool' | 'system';

export interface ChatMsg {
  id: string;
  role: ChatRole;
  content: string;
  toolName?: string;
  toolArgs?: unknown;
  anomaly?: {
    type?: string;
    severity?: string;
    description?: string;
    zscore?: number;
    topic?: string;
  };
  timestamp: number;
}

/**
 * ChatMessage — renders a single message bubble inside the CHISMOSO chat sidebar.
 *
 * - User messages: violet bubble aligned right.
 * - Assistant messages: muted bubble aligned left (supports streaming caret).
 * - Tool messages: monospace chip (tool_call / tool_result).
 * - Anomaly messages (proactive_anomaly): amber callout with severity + zscore.
 * - System messages are hidden (render null).
 */
export function ChatMessage({ msg, streaming }: { msg: ChatMsg; streaming?: boolean }) {
  if (msg.role === 'system') return null; // hide system messages

  const isUser = msg.role === 'user';
  const isTool = msg.role === 'tool';
  const isAnomaly = msg.anomaly !== undefined;

  return (
    <div className={cn('flex gap-2 mb-3', isUser ? 'flex-row-reverse' : 'flex-row')}>
      <div
        className={cn(
          'h-6 w-6 rounded-full flex items-center justify-center shrink-0 mt-0.5',
          isUser
            ? 'bg-violet-100 text-violet-700'
            : isTool
              ? 'bg-amber-100 text-amber-700'
              : 'bg-emerald-100 text-emerald-700'
        )}
      >
        {isUser ? (
          <User className="h-3 w-3" />
        ) : isTool ? (
          <Wrench className="h-3 w-3" />
        ) : (
          <Bot className="h-3 w-3" />
        )}
      </div>
      <div className={cn('flex-1 min-w-0', isUser && 'flex justify-end')}>
        {isAnomaly ? (
          <div className="rounded-lg border-l-2 border-amber-500 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-xs">
            <div className="flex items-center gap-1.5 mb-1">
              <AlertTriangle className="h-3 w-3 text-amber-600" />
              <span className="font-semibold text-amber-900 dark:text-amber-100">
                Anomalía: {(msg.anomaly?.type ?? '').replace(/_/g, ' ')}
              </span>
              {msg.anomaly?.severity && (
                <Badge variant="outline" className="text-[9px] py-0 px-1">
                  {msg.anomaly.severity}
                </Badge>
              )}
            </div>
            {msg.anomaly?.description && (
              <p className="text-amber-900 dark:text-amber-100">{msg.anomaly.description}</p>
            )}
            {(typeof msg.anomaly?.zscore === 'number' || msg.anomaly?.topic) && (
              <p className="text-[10px] text-amber-700 dark:text-amber-300 mt-1">
                {typeof msg.anomaly?.zscore === 'number' && `z=${msg.anomaly.zscore.toFixed(2)}`}
                {typeof msg.anomaly?.zscore === 'number' && msg.anomaly?.topic ? ' · ' : ''}
                {msg.anomaly?.topic}
              </p>
            )}
          </div>
        ) : isTool ? (
          <div className="rounded-md border bg-muted/30 px-2.5 py-1.5 text-[10px] font-mono">
            <span className="text-muted-foreground">→ {msg.toolName}</span>
            {msg.content && (
              <div className="mt-0.5 text-foreground whitespace-pre-wrap">{msg.content}</div>
            )}
          </div>
        ) : (
          <div
            className={cn(
              'rounded-lg px-3 py-2 text-sm inline-block max-w-full',
              isUser ? 'bg-violet-500 text-white' : 'bg-muted text-foreground'
            )}
          >
            <p className="whitespace-pre-wrap break-words">
              {msg.content}
              {streaming && <span className="animate-pulse">▌</span>}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
