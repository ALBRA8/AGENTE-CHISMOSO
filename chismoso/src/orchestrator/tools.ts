/**
 * CHISMOSO V1.0 — Tool Registry (sección 42 · §23 spec compliance)
 *
 * Las herramientas son las "manos" del agente. Cada tool es una capacidad
 * concreta que el orchestrator puede invocar. El LLM NO llama providers
 * directamente — llama a tools, y los tools encapsulan providers, engines
 * y repositorios.
 *
 * Esto permite que el LLM se enfoque en interpretación y planificación
 * mientras las tools garantizan persistencia, dedup, normalización y
 * observabilidad.
 *
 * === §23 spec compliance ===
 *
 * Each ToolDefinition now declares the full spec-required metadata:
 *   - id                    stable identifier (e.g. 'chismoso.tool.search_web.v1')
 *   - purpose               human-readable intent
 *   - category              READ | WRITE | EXTERNAL | SENSITIVE
 *   - permissions           allowedInModes + requiresApproval gate
 *   - risk                  low | medium | high
 *   - side_effects          none | persist | external_call | persist+external_call
 *   - timeout_ms            per-call hard cap (enforced by callWithTimeout)
 *   - retry_policy          maxRetries + backoff + retryable error codes
 *   - evidence_behavior     produces | consumes | both | none
 *   - audit_behavior        logged | silent | critical
 *   - inputSchema           JSON Schema (LLM-facing)
 *   - outputSchema          JSON Schema (LLM-facing)
 *   - provider              which provider this tool wraps
 *
 * The orchestrator consults these fields via `canCallTool()` and
 * `callWithTimeout()` helpers (see orchestrator.ts / react.ts).
 */

import type { ProviderRegistry, ProviderQuery } from '../providers/base.js';
import type { Repositories } from '../repositories.js';
import type { Signal, Evidence, Investigation, ProviderRun } from '../models.js';
import { generateId, nowISO, SignalType, SourceType, TruthLevel } from '../models.js';
import {
  normalizeRawItem,
  dedupSignals,
  dedupEvidence,
  type NormalizeContext,
} from '../intelligence/normalizer.js';
import { logger } from '../logger.js';
import { ErrorCode } from '../errors.js';

// ---------------------------------------------------------------------------
// §23 SPEC TYPES — permissions, risk, side-effects, retry policy
// ---------------------------------------------------------------------------

export type ToolCategory = 'READ' | 'WRITE' | 'EXTERNAL' | 'SENSITIVE';
export type ToolRisk = 'low' | 'medium' | 'high';
export type ToolSideEffects = 'none' | 'persist' | 'external_call' | 'persist+external_call';
export type ToolMode = 'sync' | 'react' | 'mcp_client' | 'autonomous';

export interface ToolPermissions {
  /** Which categories this tool belongs to (a tool can be READ+EXTERNAL). */
  categories: ToolCategory[];
  /** Orchestrator modes allowed to invoke this tool. */
  allowedInModes: ToolMode[];
  /** If true, the LLM may NOT call this tool without explicit operator approval
   *  (V1: skipped + logged — no approval UI yet). */
  requiresApproval?: boolean;
}

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  backoffMultiplier: number;
  /** ErrorCode string values that this tool considers retryable. */
  retryableErrors: string[];
}

// ---------------------------------------------------------------------------
// TOOL INTERFACES
// ---------------------------------------------------------------------------

export interface ToolContext {
  investigationId: string;
  geography: string;
  repositories: Repositories;
  providerRegistry: ProviderRegistry;
}

export interface ToolDefinition<Args = any, Resp = any> {
  // --- Identity & intent ---
  name: string;
  description: string;
  /** Stable identifier (e.g. 'chismoso.tool.search_web.v1'). */
  id: string;
  /** One-line purpose — what this tool is for. */
  purpose: string;

  // --- §23 spec fields ---
  category: ToolCategory[];
  permissions: ToolPermissions;
  risk: ToolRisk;
  side_effects: ToolSideEffects;
  timeout_ms: number;
  retry_policy: RetryPolicy;
  evidence_behavior: 'produces' | 'consumes' | 'both' | 'none';
  audit_behavior: 'logged' | 'silent' | 'critical';

  // --- Schemas (LLM-facing, runtime) ---
  inputSchema?: any;     // JSON Schema for the Args
  outputSchema?: any;    // JSON Schema for the Resp

  // --- Provider linkage ---
  /** Which provider this tool wraps (when applicable). */
  provider?: string;

  // --- Execution ---
  execute: (args: Args, ctx: ToolContext) => Promise<Resp>;
}

// ---------------------------------------------------------------------------
// TOOL ARG/RESP TYPES
// ---------------------------------------------------------------------------

export interface SearchWebArgs {
  query: string;
  num?: number;
  geography?: string;
  recencyDays?: number;
}

export interface SearchWebResponse {
  providerName: string;
  itemCount: number;
  signalsStored: number;
  evidenceStored: number;
  durationMs: number;
  error?: string;
  errorCode?: string;
}

export interface CollectTrendsArgs {
  topic: string;
  geography?: string;
}

export interface CollectTrendsResponse {
  available: boolean;
  reason?: string;
}

export interface SearchCommunityArgs {
  query: string;
  num?: number;
  recencyDays?: number;
}

export interface SearchCommunityResponse extends SearchWebResponse {}

export interface DeepenContentArgs {
  urls: string[];
  topic: string;
}

export interface DeepenContentResponse {
  itemCount: number;
  signalsStored: number;
  evidenceStored: number;
  durationMs: number;
  error?: string;
  errorCode?: string;
}

// ---------------------------------------------------------------------------
// §23 ENFORCEMENT HELPERS — used by orchestrator + react loop
// ---------------------------------------------------------------------------

/**
 * Decides whether a given orchestrator mode is allowed to invoke a tool.
 *
 * V1 behaviour:
 *   - If `requiresApproval` is set, the tool is skipped (no UI yet).
 *   - If `allowedInModes` does not include the current mode, skip.
 *
 * Returns `{ ok: true }` when the call is permitted, or `{ ok: false, reason }`
 * with a short reason string the caller can push into `investigation.errors[]`.
 */
export function canCallTool(
  tool: ToolDefinition,
  mode: 'sync' | 'react',
): { ok: true } | { ok: false; reason: string } {
  if (!tool.permissions.allowedInModes.includes(mode)) {
    logger.warn('Tool not allowed in this mode', { tool: tool.name, mode });
    return { ok: false, reason: `tool_not_allowed_in_mode:${mode}` };
  }
  if (tool.permissions.requiresApproval) {
    // V1: log + skip (no UI for approval yet).
    logger.warn('Tool requires approval — skipping', { tool: tool.name });
    return { ok: false, reason: 'tool_requires_approval' };
  }
  return { ok: true };
}

/**
 * Wraps `tool.execute(args, ctx)` with a hard timeout (Promise.race).
 *
 * If the tool does not complete within `tool.timeout_ms`, rejects with an
 * Error whose message starts with `tool_timeout:`. The orchestrator catches
 * this and records a `tool_timeout` audit entry without crashing the loop.
 *
 * The timeout is intentionally implemented with a dangling setTimeout that
 * we do NOT cancel after success — Node's timer will still fire but its
 * rejection callback will find the promise already settled and no-op.
 * (We `unref()` the timer so it doesn't keep the event loop alive.)
 */
export async function callWithTimeout<Args, Resp>(
  tool: ToolDefinition<Args, Resp>,
  args: Args,
  ctx: ToolContext,
): Promise<Resp> {
  const timeoutMs = tool.timeout_ms > 0 ? tool.timeout_ms : 30_000;
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race<Resp>([
      tool.execute(args, ctx),
      new Promise<Resp>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`tool_timeout:${tool.name}:${timeoutMs}ms`)),
          timeoutMs,
        );
        // Don't keep the event loop alive solely for this timer.
        timer.unref?.();
      }),
    ]);
    return result;
  } finally {
    if (timer) {
      try { clearTimeout(timer); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// TOOL IMPLEMENTATIONS
// ---------------------------------------------------------------------------

export const searchWebTool: ToolDefinition<SearchWebArgs, SearchWebResponse> = {
  id: 'chismoso.tool.search_web.v1',
  name: 'search_web',
  description: 'Searches the open web via the web_search provider and persists signals + evidence.',
  purpose: 'Acquire fresh web signals for the investigation topic.',
  category: ['READ', 'EXTERNAL'],
  permissions: {
    categories: ['READ', 'EXTERNAL'],
    allowedInModes: ['sync', 'react', 'autonomous'],
  },
  risk: 'low',
  side_effects: 'persist',
  timeout_ms: 10_000,
  retry_policy: {
    maxRetries: 2,
    baseDelayMs: 800,
    backoffMultiplier: 1.5,
    retryableErrors: [ErrorCode.RATE_LIMIT, ErrorCode.TEMPORARY_FAILURE, ErrorCode.TIMEOUT],
  },
  evidence_behavior: 'produces',
  audit_behavior: 'logged',
  provider: 'web_search',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      num: { type: 'integer', minimum: 1, maximum: 30, default: 10 },
      geography: { type: 'string', default: 'global' },
      recencyDays: { type: 'integer', minimum: 1, maximum: 365 },
    },
    required: ['query'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      providerName: { type: 'string' },
      itemCount: { type: 'integer' },
      signalsStored: { type: 'integer' },
      evidenceStored: { type: 'integer' },
      durationMs: { type: 'integer' },
      error: { type: 'string' },
      errorCode: { type: 'string' },
    },
    required: ['providerName', 'itemCount', 'signalsStored', 'evidenceStored', 'durationMs'],
  },
  async execute(args, ctx) {
    const provider = ctx.providerRegistry.get('web_search');
    if (!provider) {
      return { providerName: 'web_search', itemCount: 0, signalsStored: 0, evidenceStored: 0, durationMs: 0, error: 'provider not registered', errorCode: ErrorCode.PROVIDER_UNAVAILABLE };
    }
    const run: ProviderRun = {
      providerName: 'web_search',
      startedAt: nowISO(),
      query: args.query,
      resultsCount: 0,
    };
    const t0 = Date.now();
    const res = await provider.search({
      query: args.query,
      num: args.num,
      geography: args.geography ?? ctx.geography,
      recencyDays: args.recencyDays,
    });
    run.completedAt = nowISO();
    run.durationMs = Date.now() - t0;
    run.resultsCount = res.items.length;
    run.error = res.error;
    run.errorCode = res.errorCode;
    ctx.repositories.investigations.recordProviderRun(ctx.investigationId, run);

    if (res.items.length === 0) {
      return { providerName: 'web_search', itemCount: 0, signalsStored: 0, evidenceStored: 0, durationMs: res.durationMs, error: res.error, errorCode: res.errorCode };
    }

    const normCtx: NormalizeContext = {
      topic: args.query,
      geography: args.geography ?? ctx.geography,
      investigationId: ctx.investigationId,
    };
    const normalized = res.items.map((it) => normalizeRawItem(it, normCtx));
    let signals = normalized.map((n) => n.signal);
    let evidence = normalized.map((n) => n.evidence);
    const beforeDedup = signals.length;
    signals = dedupSignals(signals);
    evidence = dedupEvidence(evidence);
    const duplicates = beforeDedup - signals.length;
    ctx.repositories.signals.insertMany(signals, ctx.investigationId);
    for (const e of evidence) ctx.repositories.evidence.insert(e, ctx.investigationId);

    // §10 Provider Quality — record this call's outcome.
    try {
      const tracker = getQualityTracker(ctx);
      tracker?.recordCall('web_search', {
        success: !res.errorCode,
        latencyMs: res.durationMs,
        signalsReturned: res.items.length,
        duplicateSignals: duplicates,
        error: res.error,
      });
    } catch (e: any) {
      logger.warn('ProviderQuality recordCall failed (web_search)', { err: e?.message ?? String(e) });
    }

    return {
      providerName: 'web_search',
      itemCount: res.items.length,
      signalsStored: signals.length,
      evidenceStored: evidence.length,
      durationMs: res.durationMs,
      error: res.error,
      errorCode: res.errorCode,
    };
  },
};

export const searchCommunityTool: ToolDefinition<SearchCommunityArgs, SearchCommunityResponse> = {
  id: 'chismoso.tool.search_community.v1',
  name: 'search_community',
  description: 'Searches community sources (reddit.com, quora.com) via reddit_communities provider.',
  purpose: 'Acquire community-sourced signals (Reddit/Quora) for the investigation topic.',
  category: ['READ', 'EXTERNAL'],
  permissions: {
    categories: ['READ', 'EXTERNAL'],
    allowedInModes: ['sync', 'react', 'autonomous'],
  },
  risk: 'low',
  side_effects: 'persist',
  timeout_ms: 10_000,
  retry_policy: {
    maxRetries: 2,
    baseDelayMs: 800,
    backoffMultiplier: 1.5,
    retryableErrors: [ErrorCode.RATE_LIMIT, ErrorCode.TEMPORARY_FAILURE, ErrorCode.TIMEOUT],
  },
  evidence_behavior: 'produces',
  audit_behavior: 'logged',
  provider: 'reddit_communities',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      num: { type: 'integer', minimum: 1, maximum: 30, default: 10 },
      recencyDays: { type: 'integer', minimum: 1, maximum: 365 },
    },
    required: ['query'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      providerName: { type: 'string' },
      itemCount: { type: 'integer' },
      signalsStored: { type: 'integer' },
      evidenceStored: { type: 'integer' },
      durationMs: { type: 'integer' },
      error: { type: 'string' },
      errorCode: { type: 'string' },
    },
    required: ['providerName', 'itemCount', 'signalsStored', 'evidenceStored', 'durationMs'],
  },
  async execute(args, ctx) {
    const provider = ctx.providerRegistry.get('reddit_communities');
    if (!provider) {
      return { providerName: 'reddit_communities', itemCount: 0, signalsStored: 0, evidenceStored: 0, durationMs: 0, error: 'provider not registered', errorCode: ErrorCode.PROVIDER_UNAVAILABLE };
    }
    const run: ProviderRun = {
      providerName: 'reddit_communities',
      startedAt: nowISO(),
      query: args.query,
      resultsCount: 0,
    };
    const t0 = Date.now();
    const res = await provider.search({
      query: args.query,
      num: args.num,
      geography: ctx.geography,
      recencyDays: args.recencyDays,
    });
    run.completedAt = nowISO();
    run.durationMs = Date.now() - t0;
    run.resultsCount = res.items.length;
    run.error = res.error;
    run.errorCode = res.errorCode;
    ctx.repositories.investigations.recordProviderRun(ctx.investigationId, run);

    if (res.items.length === 0) {
      return { providerName: 'reddit_communities', itemCount: 0, signalsStored: 0, evidenceStored: 0, durationMs: res.durationMs, error: res.error, errorCode: res.errorCode };
    }

    const normCtx: NormalizeContext = {
      topic: args.query,
      geography: ctx.geography,
      investigationId: ctx.investigationId,
    };
    const normalized = res.items.map((it) => normalizeRawItem(it, normCtx));
    let signals = normalized.map((n) => n.signal);
    let evidence = normalized.map((n) => n.evidence);
    const beforeDedup = signals.length;
    signals = dedupSignals(signals);
    evidence = dedupEvidence(evidence);
    const duplicates = beforeDedup - signals.length;
    ctx.repositories.signals.insertMany(signals, ctx.investigationId);
    for (const e of evidence) ctx.repositories.evidence.insert(e, ctx.investigationId);

    try {
      const tracker = getQualityTracker(ctx);
      tracker?.recordCall('reddit_communities', {
        success: !res.errorCode,
        latencyMs: res.durationMs,
        signalsReturned: res.items.length,
        duplicateSignals: duplicates,
        error: res.error,
      });
    } catch (e: any) {
      logger.warn('ProviderQuality recordCall failed (reddit_communities)', { err: e?.message ?? String(e) });
    }

    return {
      providerName: 'reddit_communities',
      itemCount: res.items.length,
      signalsStored: signals.length,
      evidenceStored: evidence.length,
      durationMs: res.durationMs,
      error: res.error,
      errorCode: res.errorCode,
    };
  },
};

export const collectTrendsTool: ToolDefinition<CollectTrendsArgs, CollectTrendsResponse> = {
  id: 'chismoso.tool.collect_trends.v1',
  name: 'collect_trends',
  description: 'Attempts to collect Google Trends data. Currently UNAVAILABLE — returns availability flag without simulating data.',
  purpose: 'Acquire trend-volume time-series for the topic (UNAVAILABLE in V1).',
  category: ['READ', 'EXTERNAL'],
  permissions: {
    categories: ['READ', 'EXTERNAL'],
    allowedInModes: ['sync', 'react', 'autonomous'],
  },
  risk: 'low',
  side_effects: 'none',
  timeout_ms: 5_000,
  retry_policy: {
    maxRetries: 0,
    baseDelayMs: 0,
    backoffMultiplier: 1,
    retryableErrors: [],
  },
  evidence_behavior: 'none',
  audit_behavior: 'silent',
  provider: 'google_trends',
  inputSchema: {
    type: 'object',
    properties: {
      topic: { type: 'string' },
      geography: { type: 'string' },
    },
    required: ['topic'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      available: { type: 'boolean' },
      reason: { type: 'string' },
    },
    required: ['available'],
  },
  async execute(_args, _ctx) {
    logger.debug('collect_trends called — provider is UNAVAILABLE, returning empty');
    return { available: false, reason: 'GoogleTrendsProvider UNAVAILABLE in V1' };
  },
};

export const deepenContentTool: ToolDefinition<DeepenContentArgs, DeepenContentResponse> = {
  id: 'chismoso.tool.deepen_content.v1',
  name: 'deepen_content',
  description: 'Deepens investigation by extracting full content from up to 5 URLs. Use to confirm signals across sources.',
  purpose: 'Fetch full-page content from promising URLs to deepen evidence.',
  category: ['READ', 'EXTERNAL'],
  permissions: {
    categories: ['READ', 'EXTERNAL'],
    allowedInModes: ['react', 'autonomous'],
  },
  risk: 'medium',
  side_effects: 'persist+external_call',
  timeout_ms: 20_000,
  retry_policy: {
    maxRetries: 1,
    baseDelayMs: 1000,
    backoffMultiplier: 2,
    retryableErrors: [ErrorCode.TEMPORARY_FAILURE, ErrorCode.TIMEOUT],
  },
  evidence_behavior: 'produces',
  audit_behavior: 'logged',
  provider: 'web_content',
  inputSchema: {
    type: 'object',
    properties: {
      urls: {
        type: 'array',
        items: { type: 'string', format: 'uri' },
        minItems: 1,
        maxItems: 5,
      },
      topic: { type: 'string' },
    },
    required: ['urls', 'topic'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      itemCount: { type: 'integer' },
      signalsStored: { type: 'integer' },
      evidenceStored: { type: 'integer' },
      durationMs: { type: 'integer' },
      error: { type: 'string' },
      errorCode: { type: 'string' },
    },
    required: ['itemCount', 'signalsStored', 'evidenceStored', 'durationMs'],
  },
  async execute(args, ctx) {
    const provider = ctx.providerRegistry.get('web_content');
    if (!provider) {
      return { itemCount: 0, signalsStored: 0, evidenceStored: 0, durationMs: 0, error: 'provider not registered', errorCode: ErrorCode.PROVIDER_UNAVAILABLE };
    }
    if (args.urls.length === 0) {
      return { itemCount: 0, signalsStored: 0, evidenceStored: 0, durationMs: 0 };
    }
    const run: ProviderRun = {
      providerName: 'web_content',
      startedAt: nowISO(),
      query: args.topic,
      resultsCount: 0,
    };
    const t0 = Date.now();
    const res = await provider.search({
      query: args.topic,
      urls: args.urls,
      geography: ctx.geography,
    } as ProviderQuery);
    run.completedAt = nowISO();
    run.durationMs = Date.now() - t0;
    run.resultsCount = res.items.length;
    run.error = res.error;
    run.errorCode = res.errorCode;
    ctx.repositories.investigations.recordProviderRun(ctx.investigationId, run);

    if (res.items.length === 0) {
      return { itemCount: 0, signalsStored: 0, evidenceStored: 0, durationMs: res.durationMs, error: res.error, errorCode: res.errorCode };
    }

    const normCtx: NormalizeContext = {
      topic: args.topic,
      geography: ctx.geography,
      investigationId: ctx.investigationId,
    };
    const normalized = res.items.map((it) => normalizeRawItem(it, normCtx));
    let signals = normalized.map((n) => n.signal);
    let evidence = normalized.map((n) => n.evidence);
    const beforeDedup = signals.length;
    signals = dedupSignals(signals);
    evidence = dedupEvidence(evidence);
    const duplicates = beforeDedup - signals.length;
    ctx.repositories.signals.insertMany(signals, ctx.investigationId);
    for (const e of evidence) ctx.repositories.evidence.insert(e, ctx.investigationId);

    try {
      const tracker = getQualityTracker(ctx);
      tracker?.recordCall('web_content', {
        success: !res.errorCode,
        latencyMs: res.durationMs,
        signalsReturned: res.items.length,
        duplicateSignals: duplicates,
        error: res.error,
      });
    } catch (e: any) {
      logger.warn('ProviderQuality recordCall failed (web_content)', { err: e?.message ?? String(e) });
    }

    return {
      itemCount: res.items.length,
      signalsStored: signals.length,
      evidenceStored: evidence.length,
      durationMs: res.durationMs,
      error: res.error,
      errorCode: res.errorCode,
    };
  },
};

// ---------------------------------------------------------------------------
// §10 PROVIDER QUALITY TRACKER — lazily attached to ToolContext
// ---------------------------------------------------------------------------

import type { ProviderQualityTracker } from '../providers/quality.js';

/**
 * Stash slot key on ToolContext — we attach the tracker the first time a tool
 * needs it (the orchestrator sets `ctx.qualityTracker` if available). Tools
 * that emit provider calls can then record results without taking the
 * tracker as an explicit dependency.
 */
const QUALITY_TRACKER_KEY = '__qualityTracker';

export function attachQualityTracker(ctx: ToolContext, tracker: ProviderQualityTracker): ToolContext {
  (ctx as any)[QUALITY_TRACKER_KEY] = tracker;
  return ctx;
}

export function getQualityTracker(ctx: ToolContext): ProviderQualityTracker | undefined {
  return (ctx as any)[QUALITY_TRACKER_KEY] as ProviderQualityTracker | undefined;
}

// ---------------------------------------------------------------------------
// TOOL REGISTRY
// ---------------------------------------------------------------------------

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition<any, any>>();

  register<Args, Resp>(tool: ToolDefinition<Args, Resp>): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition<any, any> | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition<any, any>[] {
    return Array.from(this.tools.values());
  }

  /**
   * Devuelve un esquema simplificado para el LLM (name + description +
   * §23 metadata). Operators and MCP clients can introspect tool
   * permissions, risk, and side-effects without invoking the tool.
   */
  describe(): Array<{
    name: string;
    description: string;
    id: string;
    purpose: string;
    category: ToolCategory[];
    risk: ToolRisk;
    side_effects: ToolSideEffects;
    requiresApproval: boolean;
    timeout_ms: number;
  }> {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      id: t.id,
      purpose: t.purpose,
      category: t.category,
      risk: t.risk,
      side_effects: t.side_effects,
      requiresApproval: Boolean(t.permissions.requiresApproval),
      timeout_ms: t.timeout_ms,
    }));
  }
}

export function createDefaultToolRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(searchWebTool);
  reg.register(searchCommunityTool);
  reg.register(collectTrendsTool);
  reg.register(deepenContentTool);
  return reg;
}

// Re-export individual tools for testing.
export { normalizeRawItem };
