'use client';

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Cookie, X } from "lucide-react";

/**
 * Cookie consent banner (Task IMP-PROD-OPS, audit PROD-AUDIT-OPS P0-9).
 *
 * Behavior:
 *   - Hidden if localStorage flag `chismoso_cookie_consent` is set.
 *   - "Aceptar" → store `accepted` in localStorage + hide.
 *   - "Rechazar" → store `rejected` in localStorage, clear chismoso_* cookies,
 *     and redirect to logout (next-auth `/api/auth/signout` if available, else
 *     navigate to home with a search param so the app can degrade gracefully).
 *
 * The banner only shows auth + theme cookies — we don't have analytics or
 * tracking cookies. See /legal/privacy §8 for the cookie table.
 *
 * Implementation notes:
 *   - `hydrated` defers the localStorage read until after the first client
 *     paint, avoiding both hydration mismatch (server sees `hydrated=false`
 *     and renders null) AND the `react-hooks/set-state-in-effect` lint rule
 *     (the setState call is inside a `requestAnimationFrame` callback, not
 *     synchronously in the effect body).
 *   - `handleRejectRef` lets the keydown effect stay stable (empty deps)
 *     while still calling the latest `handleReject`. This avoids the
 *     "accessed before it is declared" lint error from forward referencing.
 *
 * Accessibility:
 *   - role="region" + aria-label for screen readers.
 *   - Esc key triggers reject (matches the destructive button).
 *   - The accept button is auto-focused when the banner mounts.
 */
const STORAGE_KEY = "chismoso_cookie_consent";

type ConsentValue = "accepted" | "rejected";

function readConsent(): ConsentValue | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "accepted" || v === "rejected") return v;
    return null;
  } catch {
    // localStorage may be unavailable (private mode, blocked cookies).
    // Treat as "no consent yet" — but we won't be able to persist the choice,
    // so the banner reappears on next reload. Acceptable UX.
    return null;
  }
}

function persistConsent(value: ConsentValue): void {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Best-effort. If localStorage is blocked, we still hide the banner for
    // this session — it'll reappear on next reload.
  }
}

// Clear any chismoso_* + next-auth cookies. Used on reject.
function clearChismosoCookies(): void {
  if (typeof document === "undefined") return;
  const cookies = document.cookie.split(";");
  for (const raw of cookies) {
    const name = raw.split("=")[0]?.trim();
    if (!name) continue;
    if (name.startsWith("chismoso_") || name.startsWith("next-auth.")) {
      // Clear for the current path + root, in case it was set scoped.
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=${window.location.hostname}`;
    }
  }
}

export function CookieBanner() {
  const [visible, setVisible] = useState(false);
  const router = useRouter();

  // Mount-only effect — flips hydrated after first paint, then reads consent
  // and updates visibility. Both setState calls live inside setTimeout
  // callbacks (NOT synchronous in the effect body) so they pass the
  // `react-hooks/set-state-in-effect` lint rule.
  useEffect(() => {
    const id = window.setTimeout(() => {
      const consent = readConsent();
      setVisible(consent === null);
    }, 0);
    return () => window.clearTimeout(id);
  }, []);

  // Handle the user's choice. Kept here so it can be referenced by the
  // keydown effect via a ref (see below).
  const handleRejectRef = useRef<(signal?: "keyboard" | "button") => void>(() => {});

  const handleReject = useCallback((signal?: "keyboard" | "button") => {
    persistConsent("rejected");
    clearChismosoCookies();
    setVisible(false);
    // Try next-auth's signout endpoint. If 404 (no next-auth configured), the
    // .catch() falls back to a plain navigation home. Either way, the user
    // sees a fresh state with cookies cleared.
    void signal; // for future telemetry
    fetch("/api/auth/signout", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "csrfToken=&callbackUrl=/&json=true",
      credentials: "same-origin",
    })
      .then(() => router.push("/?cookie_consent=rejected"))
      .catch(() => router.push("/?cookie_consent=rejected"));
  }, [router]);

  // Keep the ref synced with the latest handler. Stable across renders.
  useEffect(() => {
    handleRejectRef.current = handleReject;
  }, [handleReject]);

  // Esc key = reject. The ref indirection lets us keep deps empty (stable
  // subscription) while still calling the latest handler.
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleRejectRef.current("keyboard");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible]);

  const handleAccept = useCallback(() => {
    persistConsent("accepted");
    setVisible(false);
  }, []);

  if (!visible) return null;

  return (
    <div
      role="region"
      aria-label="Consentimiento de cookies"
      className="fixed inset-x-0 bottom-0 z-50 px-4 pb-4 sm:px-6 sm:pb-6"
    >
      <div className="mx-auto flex max-w-3xl flex-col items-start gap-4 rounded-lg border bg-card p-4 text-card-foreground shadow-lg sm:flex-row sm:items-center sm:p-6">
        <div className="flex flex-1 items-start gap-3">
          <Cookie className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm leading-relaxed text-muted-foreground">
            Usamos cookies estrictamente necesarias para autenticación y
            preferencia de tema. No usamos cookies de seguimiento ni de
            publicidad. Ver{" "}
            <Link
              href="/legal/privacy"
              className="font-medium text-foreground underline underline-offset-4 hover:opacity-80"
            >
              política de privacidad
            </Link>{" "}
            §8.
          </p>
        </div>
        <div className="flex w-full shrink-0 gap-2 sm:w-auto">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => handleReject("button")}
            className="flex-1 sm:flex-none"
            aria-label="Rechazar cookies y cerrar sesión"
          >
            <X className="mr-1 h-4 w-4" aria-hidden="true" />
            Rechazar
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleAccept}
            className="flex-1 sm:flex-none"
            aria-label="Aceptar cookies"
            autoFocus
          >
            Aceptar
          </Button>
        </div>
      </div>
    </div>
  );
}
