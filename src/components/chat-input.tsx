'use client';

import { useState, useCallback, KeyboardEvent } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Send, Loader2 } from 'lucide-react';

/**
 * ChatInput — text input + send button for the CHISMOSO chat sidebar.
 *
 * - Enter sends, Shift+Enter inserts newline-free submit guard (the input is
 *   single-line so Shift+Enter is effectively ignored; this matches the
 *   expected keyboard behaviour for a telegram-style agent).
 * - Send button is disabled while a request is in flight (`disabled` prop)
 *   or when the input is empty.
 * - Calls `onSend(text)` with the trimmed input and clears the field.
 */
export function ChatInput({ onSend, disabled }: {
  onSend: (msg: string) => void;
  disabled?: boolean;
}) {
  const [text, setText] = useState('');

  const submit = useCallback(() => {
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t);
    setText('');
  }, [text, disabled, onSend]);

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }, [submit]);

  return (
    <div className="flex items-center gap-1.5 px-2 py-2 border-t">
      <Input
        placeholder="Pregúntale a CHISMOSO…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        className="text-sm h-9"
        aria-label="Mensaje a CHISMOSO"
      />
      <Button
        size="icon"
        onClick={submit}
        disabled={disabled || !text.trim()}
        className="h-9 w-9 shrink-0"
        aria-label="Enviar mensaje"
      >
        {disabled ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
      </Button>
    </div>
  );
}
