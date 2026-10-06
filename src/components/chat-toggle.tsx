'use client';

import { Button } from '@/components/ui/button';
import { Radar, X } from 'lucide-react';

/**
 * ChatToggle
 *
 * Floating bottom-right button that toggles the CHISMOSO conversational
 * agent panel open/closed.
 *
 * - When `open === false` → wide button "Hablar con CHISMOSO" with radar icon.
 * - When `open === true`  → compact circular button with an X icon
 *   (so the user has a second way to close the chat, besides the header X).
 *
 * The button is `fixed` and `z-50` so it sits on top of every other element
 * (including the chat panel header on mobile). It never overlaps the chat
 * panel itself because when chat is open the button shrinks to a 40px circle
 * tucked into the bottom-right corner.
 *
 * Accessibility: aria-label is set on the icon-only variant so screen readers
 * announce "Cerrar chat" instead of an empty string.
 */
export function ChatToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <Button
      onClick={onToggle}
      aria-label={open ? 'Cerrar chat de CHISMOSO' : 'Abrir chat de CHISMOSO'}
      className={`fixed bottom-4 right-4 z-50 rounded-full shadow-lg transition-all ${
        open ? 'h-10 w-10 p-0' : 'h-12 px-4 gap-2'
      }`}
      size={open ? 'icon' : 'default'}
    >
      {open ? (
        <X className="h-4 w-4" />
      ) : (
        <>
          <Radar className="h-4 w-4" />
          <span className="hidden sm:inline">Hablar con CHISMOSO</span>
          <span className="sm:hidden">CHISMOSO</span>
        </>
      )}
    </Button>
  );
}
