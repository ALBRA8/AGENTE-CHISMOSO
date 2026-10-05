/**
 * CHISMOSO V1.0 — Tool Registry (sección 42)
 *
 * Las herramientas son las "manos" del agente. Cada tool es una capacidad
 * concreta que el orchestrator puede invocar. El LLM NO llama providers
 * directamente — llama a tools, y los tools encapsulan providers, engines
 * y repositorios.
 *
 * Esto permite que el LLM se enfoque en interpretación y planificación
 * mientras las tools garantizan persistencia, dedup, normalización y
 * observabilidad.
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
// TOOL: search_web
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

// ---------------------------------------------------------------------------
// TOOL: collect_trends (placeholder — Google Trends is UNAVAILABLE in V1)
// ---------------------------------------------------------------------------

export interface CollectTrendsArgs {
  topic: string;
  geography?: string;
}

export interface CollectTrendsResponse {
  available: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// TOOL: search_community
// ---------------------------------------------------------------------------

export interface SearchCommunityArgs {
  query: string;
  num?: number;
  recencyDays?: number;
}

export interface SearchCommunityResponse extends SearchWebResponse {}

// ---------------------------------------------------------------------------
// TOOL: deepen_content (WebContent)
// ---------------------------------------------------------------------------

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
// TOOL REGISTRY
// ---------------------------------------------------------------------------

export interface ToolContext {
  investigationId: string;
  geography: string;
  repositories: Repositories;
  providerRegistry: ProviderRegistry;
}

export interface ToolDefinition<Args, Resp> {
  name: string;
  description: string;
  execute: (args: Args, ctx: ToolContext) => Promise<Resp>;
}

// ---------------------------------------------------------------------------
// TOOL IMPLEMENTATIONS
// ---------------------------------------------------------------------------

export const searchWebTool: ToolDefinition<SearchWebArgs, SearchWebResponse> = {
  name: 'search_web',
  description: 'Searches the open web via the web_search provider and persists signals + evidence.',
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
    signals = dedupSignals(signals);
    evidence = dedupEvidence(evidence);
    ctx.repositories.signals.insertMany(signals, ctx.investigationId);
    for (const e of evidence) ctx.repositories.evidence.insert(e, ctx.investigationId);

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
  name: 'search_community',
  description: 'Searches community sources (reddit.com, quora.com) via reddit_communities provider.',
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
    signals = dedupSignals(signals);
    evidence = dedupEvidence(evidence);
    ctx.repositories.signals.insertMany(signals, ctx.investigationId);
    for (const e of evidence) ctx.repositories.evidence.insert(e, ctx.investigationId);

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
  name: 'collect_trends',
  description: 'Attempts to collect Google Trends data. Currently UNAVAILABLE — returns availability flag without simulating data.',
  async execute(_args, _ctx) {
    logger.debug('collect_trends called — provider is UNAVAILABLE, returning empty');
    return { available: false, reason: 'GoogleTrendsProvider UNAVAILABLE in V1' };
  },
};

export const deepenContentTool: ToolDefinition<DeepenContentArgs, DeepenContentResponse> = {
  name: 'deepen_content',
  description: 'Deepens investigation by extracting full content from up to 5 URLs. Use to confirm signals across sources.',
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
    signals = dedupSignals(signals);
    evidence = dedupEvidence(evidence);
    ctx.repositories.signals.insertMany(signals, ctx.investigationId);
    for (const e of evidence) ctx.repositories.evidence.insert(e, ctx.investigationId);

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
   * Devuelve un esquema simplificado para el LLM (solo name + description).
   */
  describe(): Array<{ name: string; description: string }> {
    return this.list().map((t) => ({ name: t.name, description: t.description }));
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
