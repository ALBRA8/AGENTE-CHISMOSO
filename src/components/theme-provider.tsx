'use client';

/**
 * ThemeProvider
 *
 * Thin wrapper around `next-themes` so the rest of the app can stay
 * server-component-friendly and we centralise the next-themes config
 * (attribute, default theme, system preference toggle) in ONE place.
 *
 * Mounted once in `src/app/layout.tsx`, wrapping the body's children.
 *
 * Config:
 *   attribute="class"    → next-themes toggles the `.dark` class on <html>.
 *                          The shadcn/ui CSS vars in `globals.css` are
 *                          scoped under `.dark`, so this is what makes
 *                          `dark:` Tailwind variants actually flip.
 *   defaultTheme="dark"  → first-time visitors see the dark dashboard
 *                          (preserves the previous V1 look).
 *   enableSystem         → if the visitor's OS is set to light/dark and
 *                          they haven't picked manually, honour it. Once
 *                          they click the toggle, their choice is
 *                          persisted to localStorage and wins.
 *   disableTransitionOnChange → stops the "white flash" during the
 *                          class swap on first paint.
 */
import * as React from 'react';
import { ThemeProvider as NextThemesProvider } from 'next-themes';

type ThemeProviderProps = React.ComponentProps<typeof NextThemesProvider>;

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
