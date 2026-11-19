/**
 * CHISMOSO V1.0 — Lazy z-ai-web-dev-sdk loader (Task FASE-2-DEPS)
 *
 * The motor must work 100% with external providers (Serper / Tavily / Brave
 * for search; Groq / NVIDIA / OpenAI for LLM) WITHOUT requiring the
 * z-ai-web-dev-sdk to be installed. The SDK is only loaded as a fallback
 * when no external provider keys are configured.
 *
 * This module centralises the dynamic `import('z-ai-web-dev-sdk')` so the
 * four consumers (`orchestrator/llm.ts`, `providers/web-search.ts`,
 * `providers/web-content.ts`, `providers/reddit.ts`) share the same
 * resilient behaviour:
 *
 *   - On first call we attempt `await import('z-ai-web-dev-sdk')`.
 *   - If the package is missing (typically because an operator deployed
 *     CHISMOSO with only external keys and skipped the SDK install), we
 *     cache `null` and never retry — the cost of failed `import()` on
 *     every chat() would dominate latency for no benefit.
 *   - If the import succeeds, we cache the resolved `ZAI` factory so
 *     subsequent calls reuse the same SDK instance.
 *
 * The return type is `Promise<ZAISDK | null>` — callers MUST null-check
 * before invoking `.chat` / `.functions.invoke` and fall back to external
 * providers or raise a clear configuration error.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type ZAISDK = any;

let cached: ZAISDK | null | undefined = undefined;

/**
 * Lazily resolve the z-ai-web-dev-sdk default export. Returns `null` if
 * the SDK is not installed or fails to load — callers handle the absence.
 *
 * Resolution is cached per-process: the first call decides the result
 * (either a live SDK or `null`) and every later call returns the same
 * value synchronously.
 */
export async function loadZAI(): Promise<ZAISDK | null> {
  if (cached !== undefined) return cached;
  try {
    const mod = await import('z-ai-web-dev-sdk');
    // The SDK ships a default export; respect both shapes just in case.
    const factory = (mod && (mod.default ?? mod)) as ZAISDK | undefined;
    if (!factory || typeof factory.create !== 'function') {
      cached = null;
      return null;
    }
    cached = factory;
    return cached;
  } catch (err) {
    // MODULE_NOT_FOUND / ERR_MODULE_NOT_FOUND are the expected cases when
    // an operator deploys with only external providers configured. Any
    // other error is logged once but still treated as "SDK unavailable"
    // so the motor fails open with a clean configuration error message
    // surfaced by the caller.
    cached = null;
    if (process.env.CHISMOSO_LOG_LEVEL === 'DEBUG') {
      // eslint-disable-next-line no-console
      console.warn(
        '[chismoso] z-ai-web-dev-sdk not installed (or failed to load); ' +
          'external providers (Serper/Tavily/Brave/Groq/NVIDIA/OpenAI) ' +
          'will be used instead.',
        err instanceof Error ? err.message : String(err),
      );
    }
    return null;
  }
}

/**
 * Helper for callers that need a *ready* ZAI instance (not just the
 * factory). Returns the `ZAI.create()` promise result or `null`.
 */
export async function loadZAIInstance(): Promise<ZAISDK | null> {
  const factory = await loadZAI();
  if (!factory) return null;
  try {
    return await factory.create();
  } catch (err) {
    if (process.env.CHISMOSO_LOG_LEVEL === 'DEBUG') {
      // eslint-disable-next-line no-console
      console.warn(
        '[chismoso] ZAI.create() failed; external providers required.',
        err instanceof Error ? err.message : String(err),
      );
    }
    return null;
  }
}

/**
 * Human-readable hint used by every caller when both the external
 * providers and the SDK are unavailable. Kept in one place so the
 * message stays consistent across LLM / web_search / web_content /
 * reddit providers.
 */
export const MISSING_PROVIDER_HINT =
  'No external provider keys configured and z-ai-web-dev-sdk is not installed. ' +
  'Configure at least ONE of:\n' +
  '  • Search: SERPER_API_KEY, TAVILY_API_KEY, BRAVE_API_KEY\n' +
  '  • LLM:    NVIDIA_API_KEY, GROQ_API_KEY, OPENAI_API_KEY\n' +
  'Or install the SDK:  npm install z-ai-web-dev-sdk';
