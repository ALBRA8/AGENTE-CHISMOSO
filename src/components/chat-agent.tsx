'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Radar, Zap, X } from 'lucide-react';
import { ChatMessage, type ChatMsg } from './chat-message';
import { ChatInput } from './chat-input';
import { ChatQuickActions } from './chat-quick-actions';

interface ChatAgentProps {
  open?: boolean;
  onClose?: () => void;
  mode?: 'sidebar' | 'embedded';
}

/**
 * ChatAgent — CHISMOSO's conversational agent surface.
 *
 * Can render either as:
 *   - 'sidebar' (default): fixed 380px drawer on the right.
 *   - 'embedded': full-width centered card inside the main page view.
 */
export function ChatAgent({ open = true, onClose, mode = 'sidebar' }: ChatAgentProps) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new messages / streaming updates.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamingText]);

  const send = useCallback(
    async (text: string) => {
      if (!text.trim() || busy) return;
      setBusy(true);
      setStreamingText('');

      // Add user message immediately for snappy UX.
      const userMsg: ChatMsg = {
        id: `u_${Date.now()}`,
        role: 'user',
        content: text,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg]);

      try {
        // Open SSE via fetch + ReadableStream (EventSource doesn't support POST).
        const resp = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, sessionId }),
        });

        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        if (!resp.body) throw new Error('No body');

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let collectedText = '';

        // SSE read loop — terminates when server sends the terminal `done` event
        // (we `break` on reader.read() returning done=true after the stream closes).
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Process complete SSE events (separated by blank lines).
          const events = buffer.split('\n\n');
          buffer = events.pop() ?? '';

          for (const evt of events) {
            const eventMatch = evt.match(/^event: (.+)$/m);
            const dataMatch = evt.match(/^data: (.+)$/m);
            if (!eventMatch || !dataMatch) continue;
            const eventType = eventMatch[1].trim();
            let data: Record<string, unknown>;
            try {
              data = JSON.parse(dataMatch[1].trim()) as Record<string, unknown>;
            } catch {
              continue;
            }

            switch (eventType) {
              case 'token': {
                const t = (data.text as string | undefined) ?? '';
                collectedText += t;
                setStreamingText(collectedText);
                break;
              }
              case 'tool_call': {
                setMessages((prev) => [
                  ...prev,
                  {
                    id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
                    role: 'tool',
                    content: '',
                    toolName: data.tool as string | undefined,
                    toolArgs: data.args,
                    timestamp: Date.now(),
                  },
                ]);
                collectedText = '';
                setStreamingText('');
                break;
              }
              case 'tool_result': {
                setMessages((prev) => {
                  const updated = [...prev];
                  // Update the last matching tool message that still has empty content.
                  for (let i = updated.length - 1; i >= 0; i--) {
                    const m = updated[i];
                    if (
                      m.role === 'tool' &&
                      m.toolName === data.tool &&
                      !m.content
                    ) {
                      updated[i] = {
                        ...m,
                        content: (data.summary as string | undefined) ?? '',
                      };
                      break;
                    }
                  }
                  return updated;
                });
                break;
              }
              case 'proactive_anomaly': {
                setMessages((prev) => [
                  ...prev,
                  {
                    id: `a_${Date.now()}`,
                    role: 'tool',
                    content: '',
                    anomaly: data as ChatMsg['anomaly'],
                    timestamp: Date.now(),
                  },
                ]);
                break;
              }
              case 'done': {
                if (collectedText) {
                  setMessages((prev) => [
                    ...prev,
                    {
                      id: `as_${Date.now()}`,
                      role: 'assistant',
                      content: collectedText,
                      timestamp: Date.now(),
                    },
                  ]);
                }
                if (typeof data.sessionId === 'string') {
                  setSessionId(data.sessionId);
                }
                collectedText = '';
                setStreamingText('');
                break;
              }
              case 'error': {
                const m =
                  (data.message as string | undefined) ?? 'error desconocido';
                setMessages((prev) => [
                  ...prev,
                  {
                    id: `e_${Date.now()}`,
                    role: 'assistant',
                    content: `⚠ ${m}`,
                    timestamp: Date.now(),
                  },
                ]);
                break;
              }
              default:
                // Unknown event types are ignored — forward-compat with future backend additions.
                break;
            }
          }
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Error de red';
        setMessages((prev) => [
          ...prev,
          {
            id: `e_${Date.now()}`,
            role: 'assistant',
            content: `⚠ ${msg}`,
            timestamp: Date.now(),
          },
        ]);
      } finally {
        setBusy(false);
        setStreamingText('');
      }
    },
    [busy, sessionId]
  );

  // Light-touch anomaly polling every 60s while the sidebar is open.
  // For V1 we deliberately skip auto-inserting proactive_anomaly messages
  // (the user clicks the "Anomalías" quick action to surface them). Kept here
  // so the hook + cleanup are wired and ready for V2 proactive push.
  useEffect(() => {
    if (!open) return;
    let mounted = true;
    const poll = async () => {
      try {
        const r = await fetch('/api/anomalies');
        if (!r.ok) return;
        await r.json();
        if (!mounted) return;
        // V1: no-op on success. V2: diff against last-seen anomaly IDs and
        // push proactive_anomaly messages for new ones.
      } catch {
        /* ignore — polling is best-effort */
      }
    };
    poll();
    const timer = setInterval(poll, 60_000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [open]);

  if (!open) return null;

  const isEmbedded = mode === 'embedded';

  return (
    <div
      className={
        isEmbedded
          ? "w-full max-w-4xl mx-auto h-[calc(100vh-190px)] min-h-[560px] border rounded-2xl bg-card flex flex-col shadow-sm overflow-hidden"
          : "fixed right-0 top-14 bottom-0 w-[380px] max-w-full border-l bg-background z-40 flex flex-col shadow-xl"
      }
      role={isEmbedded ? 'region' : 'dialog'}
      aria-label="CHISMOSO conversational agent"
      aria-live="polite"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-gradient-to-r from-violet-50 to-fuchsia-50 dark:from-violet-950/30 dark:to-fuchsia-950/30">
        <div className="flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center text-white shadow-sm">
            <Radar className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold leading-none">CHISMOSO · Agente Conversacional</h3>
            <p className="text-[10px] text-muted-foreground leading-none mt-1">
              Inteligencia de señales, detección de anomalías y tendencias en vivo
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {sessionId && (
            <Badge variant="outline" className="text-[10px] py-0 px-2 text-emerald-600 dark:text-emerald-400 border-emerald-500/30">
              ● sesión activa
            </Badge>
          )}
          {!isEmbedded && onClose && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onClose}
              aria-label="Cerrar chat"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3">
        {messages.length === 0 && !streamingText && (
          <div className="text-center py-8 text-xs text-muted-foreground">
            <Zap className="h-6 w-6 mx-auto mb-2 text-violet-500" />
            <p className="font-medium mb-1">Hola, soy CHISMOSO.</p>
            <p>
              Analista de señales. Pregúntame qué vimos hoy, qué anomalías hay,
              o pídeme investigar algo.
            </p>
          </div>
        )}
        {messages.map((m) => (
          <ChatMessage key={m.id} msg={m} streaming={false} />
        ))}
        {streamingText && (
          <ChatMessage
            msg={{
              id: 'streaming',
              role: 'assistant',
              content: streamingText,
              timestamp: Date.now(),
            }}
            streaming
          />
        )}
      </div>

      <ChatQuickActions onAction={send} disabled={busy} />
      <ChatInput onSend={send} disabled={busy} />
    </div>
  );
}
