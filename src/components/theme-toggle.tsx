'use client';

/**
 * ThemeToggle
 *
 * Compact icon button that flips between light and dark mode. Uses
 * `next-themes`' `useTheme()` so the change persists across reloads
 * (localStorage) and respects the user's OS preference until they
 * pick manually.
 *
 * Why two icons:
 *   - <Sun> shows when the theme IS dark  → "click to go light"
 *   - <Moon> shows when the theme IS light → "click to go dark"
 * We render BOTH and toggle `opacity` based on the resolved theme so the
 * button doesn't pop during SSR / first paint (before next-themes has
 * hydrated). `mounted` gates the click handler so we never call
 * `setTheme` before hydration — that would throw a hydration mismatch.
 */
import * as React from 'react';
import { useTheme } from 'next-themes';
import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ThemeToggleProps {
  className?: string;
}

export function ThemeToggle({ className }: ThemeToggleProps) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  // next-themes reads localStorage in an effect; before that runs the
  // theme is `undefined`. Rendering theme-dependent markup before mount
  // causes a hydration mismatch warning, so we render a neutral
  // placeholder until mounted.
  React.useEffect(() => setMounted(true), []);

  const isDark = mounted ? resolvedTheme === 'dark' : true;

  const toggle = React.useCallback(() => {
    if (!mounted) return;
    setTheme(isDark ? 'light' : 'dark');
  }, [mounted, isDark, setTheme]);

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
      aria-label={isDark ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
      title={isDark ? 'Modo claro' : 'Modo oscuro'}
      className={className}
    >
      {/* Both icons rendered; cross-fade via opacity to avoid layout pop. */}
      <Sun
        className={`h-[1.15rem] w-[1.15rem] transition-all ${
          isDark ? 'scale-100 opacity-100' : 'scale-0 opacity-0'
        }`}
        aria-hidden
      />
      <Moon
        className={`absolute h-[1.15rem] w-[1.15rem] transition-all ${
          isDark ? 'scale-0 opacity-0' : 'scale-100 opacity-100'
        }`}
        aria-hidden
      />
      <span className="sr-only">Cambiar tema</span>
    </Button>
  );
}
