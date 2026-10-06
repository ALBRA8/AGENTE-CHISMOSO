/**
 * CHISMOSO V1.0 — Orchestrator (sección 47)
 *
 * Punto de entrada del cerebro del agente. Recibe un objetivo de alto nivel
 * y resuelve internamente todo el proceso:
 *
 *   INTERPRETAR OBJETIVO
 *   ↓
 *   PLANIFICAR INVESTIGACIÓN
 *   ↓
 *   SELECCIONAR FUENTES
 *   ↓
 *   RECOPILAR SEÑALES
 *   ↓
 *   NORMALIZAR / DEDUP / CLUSTERING
 *   ↓
 *   ANALIZAR (TREND + PROBLEM DETECTION)
 *   ↓
 *   CROSS-SOURCE CONFIRMATION
 *   ↓
 *   GENERAR OPORTUNIDADES
 *   ↓
 *   PUNTUAR
 *   ↓
 *   GENERAR REPORTE
 *   ↓
 *   ALMACENAR INTELIGENCIA
 *
 * El loop tiene un budget finito (sección 26) y puede terminar con
 * INSUFFICIENT_EVIDENCE en vez de seguir indefinidamente.
 */

import type { LLMClient } from './llm.js';
import { ResearchPlanner, type ResearchPlan } from './planner.js';
import type { ToolRegistry, ToolContext, ToolDefinition } from './tools.js';
import { canCallTool, callWithTimeout, attachQualityTracker } from './tools.js';
import type { ProviderRegistry } from '../providers/base.js';
import type { Repositories } from '../repositories.js';
import type { ChismosoDB } from '../db.js';
import { ProviderQualityTracker } from '../providers/quality.js';
import {
  DEFAULT_BUDGET,
  generateId,
  InvestigationStatus,
  nowISO,
  type Evidence,
  type Investigation,
  type InvestigationBudget,
  type Opportunity,
  type Problem,
  type Signal,
  type Trend,
} from '../models.js';
import { logger } from '../logger.js';
import {
  clusterSignalsAuto,
  MIN_SIGNALS_FOR_SEMANTIC,
} from '../intelligence/clustering.js';
import { detectTrend } from '../intelligence/trends.js';
import { detectProblem } from '../intelligence/problems.js';
import { generateOpportunity } from '../intelligence/opportunities.js';
import { buildReport } from './reporter.js';
import { EmbeddingClient } from '../intelligence/embeddings.js';
import {
  ensureEmbeddingsSchema,
  loadAllEmbeddings,
  storeEmbeddings,
} from '../db-extensions/embeddings.sql.js';
import { MemoryConsolidator, MemoryRepository } from '../memory/index.js';
import { ExecutionTraceRepository } from '../execution-trace/index.js';

export interface OrchestratorConfig {
  db: ChismosoDB;
  repositories: Repositories;
  providerRegistry: ProviderRegistry;
  toolRegistry: ToolRegistry;
  llm: LLMClient;
  budget?: Partial<InvestigationBudget>;
}

export interface InvestigateInput {
  objective: string;
  geography?: string;
  budget?: Partial<InvestigationBudget>;
}

export interface InvestigateResult {
  investigation: Investigation;
  signals: Signal[];
  evidence: Evidence[];
  trends: Trend[];
  problems: Problem[];
  opportunities: Opportunity[];
  report: ReturnType<typeof buildReport>;
}

export class Orchestrator {
  private planner: ResearchPlanner;
  private budget: InvestigationBudget;

  constructor(private cfg: OrchestratorConfig) {
    this.planner = new ResearchPlanner(cfg.llm);
    this.budget = { ...DEFAULT_BUDGET, ...cfg.budget };
  }

  async investigate(input: InvestigateInput): Promise<InvestigateResult> {
    const startedAt = nowISO();
    const investigationId = generateId('inv');
    const budget: InvestigationBudget = { ...this.budget, ...(input.budget ?? {}) };
    const geography = input.geography ?? 'global';

    // §30 — open an ExecutionTrace BEFORE doing any work, so a crash mid-run
    // still leaves a 'running' row in execution_traces that the next `chismoso
    // trace list` will surface (allowing operators to spot hung runs).
    const traceRepo = new ExecutionTraceRepository(this.cfg.db);
    const trace = traceRepo.start(
      'investigate',
      {
        objective: input.objective,
        geography,
        budget: { maxIterations: budget.maxIterations, maxQueries: budget.maxQueries },
      },
      { related_investigation_id: investigationId },
    );
    const executionId = trace.id;

    const investigation: Investigation = {
      id: investigationId,
      query: input.objective,
      scope: geography,
      startedAt,
      status: InvestigationStatus.RUNNING,
      providersUsed: [],
      queriesExecuted: [],
      signalsFound: 0,
      evidenceFound: 0,
      trendsFound: 0,
      problemsFound: 0,
      opportunitiesFound: 0,
      errors: [],
      iterations: 0,
      budget,
      providerRuns: [],
      executionId,
    };

    logger.info('Investigation started', { investigationId, executionId, objective: input.objective, geography });

    try {
      // ----------------------------------------------------------------------
      // STEP 1: PLAN
      // ----------------------------------------------------------------------
      let plan: ResearchPlan;
      try {
        plan = await this.planner.plan({
          objective: input.objective,
          geography,
          maxIterations: budget.maxIterations,
        });
      } catch (e: any) {
        investigation.errors.push(`planner_failed: ${e?.message ?? String(e)}`);
        investigation.status = InvestigationStatus.FAILED;
        investigation.completedAt = nowISO();
        investigation.durationMs = Date.now() - new Date(startedAt).getTime();
        this.cfg.repositories.investigations.insert(investigation);
        traceRepo.complete(executionId, 'failure', undefined, [
          `planner_failed: ${e?.message ?? String(e)}`,
        ]);
        throw e;
      }

      investigation.providersUsed = Array.from(new Set(plan.queries.map((q) => q.providerName)));

      const ctx: ToolContext = {
        investigationId,
        geography,
        repositories: this.cfg.repositories,
        providerRegistry: this.cfg.providerRegistry,
      };
      // Attach the provider quality tracker so built-in tools can record
      // their call outcomes (spec §10).
      const qualityTracker = new ProviderQualityTracker(this.cfg.db);
      attachQualityTracker(ctx, qualityTracker);

      // ----------------------------------------------------------------------
      // STEP 2-4: COLLECT (loop controlado por budget)
      // ----------------------------------------------------------------------
      let totalQueries = 0;
      let totalProviderCalls = 0;
      const startTime = Date.now();

      // Map providerName (lo que el planner retorna) → toolName (lo que el
      // toolRegistry conoce). Esto preserva la separación providers vs tools.
      const PROVIDER_TO_TOOL: Record<string, string> = {
        web_search: 'search_web',
        reddit_communities: 'search_community',
        google_trends: 'collect_trends',
        web_content: 'deepen_content',
      };

      for (let iter = 0; iter < plan.iterations && iter < budget.maxIterations; iter++) {
        investigation.iterations = iter + 1;
        for (const q of plan.queries) {
          if (totalQueries >= budget.maxQueries) {
            investigation.errors.push('budget_max_queries_reached');
            break;
          }
          if (totalProviderCalls >= budget.maxProviderCalls) {
            investigation.errors.push('budget_max_provider_calls_reached');
            break;
          }
          if (Date.now() - startTime > budget.maxRuntimeMs) {
            investigation.errors.push('budget_max_runtime_reached');
            break;
          }
          investigation.queriesExecuted.push(`${q.providerName}: ${q.query}`);
          totalQueries++;
          totalProviderCalls++;

          const toolName = PROVIDER_TO_TOOL[q.providerName] ?? q.providerName;
          const tool = this.cfg.toolRegistry.get(toolName);
          if (!tool) {
            investigation.errors.push(`unknown_tool: ${q.providerName} (looked up as ${toolName})`);
            continue;
          }
          // §23 enforcement: check whether this tool may be invoked in 'sync' mode.
          const permit = canCallTool(tool as ToolDefinition, 'sync');
          if (!permit.ok) {
            investigation.errors.push(`tool_not_allowed: ${toolName} — ${permit.reason}`);
            continue;
          }
          // §30 — record tool invocation on the execution trace (persisted
          // immediately so a crash mid-run still leaves an accurate record).
          traceRepo.addTool(executionId, toolName);
          try {
            if (toolName === 'search_web') {
              await callWithTimeout(tool as ToolDefinition, { query: q.query, geography, num: 10 }, ctx);
            } else if (toolName === 'search_community') {
              await callWithTimeout(tool as ToolDefinition, { query: q.query, num: 10 }, ctx);
            } else if (toolName === 'collect_trends') {
              await callWithTimeout(tool as ToolDefinition, { topic: q.query, geography }, ctx);
            } else if (toolName === 'deepen_content') {
              // deepen_content necesita URLs; no se invoca desde el plan
              // porque el plan solo contiene queries textuales.
              investigation.errors.push('deepen_content_skipped_in_plan_phase');
            } else {
              investigation.errors.push(`unsupported_tool: ${toolName}`);
            }
          } catch (e: any) {
            const msg = e?.message ?? String(e);
            if (msg.startsWith('tool_timeout:')) {
              investigation.errors.push(`tool_timeout[${q.providerName}]: ${msg}`);
              traceRepo.addError(executionId, `tool_timeout[${q.providerName}]: ${msg}`);
            } else {
              investigation.errors.push(`tool_error[${q.providerName}]: ${msg}`);
              traceRepo.addError(executionId, `tool_error[${q.providerName}]: ${msg}`);
            }
          }
        }
        if (totalQueries >= budget.maxQueries || totalProviderCalls >= budget.maxProviderCalls) break;
      }

      // ----------------------------------------------------------------------
      // STEP 5: ANALYZE (cluster + trend + problem + opportunity)
      // ----------------------------------------------------------------------
      const signals = this.cfg.repositories.signals.findByInvestigation(investigationId);
      const evidence = this.cfg.repositories.evidence.findByInvestigation(investigationId);
      investigation.signalsFound = signals.length;
      investigation.evidenceFound = evidence.length;

      // Embed signals for semantic search (idempotent — only embeds signals
      // without an embedding yet). V1.1 fix: previously this was only done
      // by a one-shot seed script, so /api/semantic-search went stale the
      // moment a new investigation ran.
      //
      // We create ONE EmbeddingClient and reuse it for clusterSignalsAuto
      // below. The cache on that client means clusterSignalsSemantic (called
      // inside clusterSignalsAuto) hits the cache instead of re-doing the
      // TF-IDF-hash CPU work, which avoids triggering a major GC during the
      // better-sqlite3 Statement lifecycle (see vitest.config.ts for the
      // codebase's own acknowledgement of this Node+sqlite3 teardown issue).
      //
      // Note: clusterSignalsAuto will ALSO ensure embeddings on its semantic
      // path, but we keep this explicit pre-step so that when we fall back
      // to token-based clustering (e.g. < 8 signals), the embeddings are
      // STILL persisted — semantic search needs them regardless of which
      // clustering strategy was chosen.
      const embeddingClient = new EmbeddingClient();
      try {
        const db = this.cfg.db.raw;
        ensureEmbeddingsSchema(db);
        const existing = new Set(
          loadAllEmbeddings(db).map((e) => e.signalId),
        );
        const toEmbed = signals.filter((s) => !existing.has(s.id));
        if (toEmbed.length > 0) {
          // Mirror clusterSignalsSemantic's text format (keyword + topic +
          // first 200 chars of snippet) so the EmbeddingClient cache hits
          // when clusterSignalsSemantic re-embeds for in-memory clustering.
          const texts = toEmbed.map(
            (s) => `${s.keyword} ${s.topic} ${s.rawSnippet.slice(0, 200)}`,
          );
          const vectors = await embeddingClient.embedBatch(texts);
          storeEmbeddings(
            db,
            toEmbed.map((s, i) => ({ signalId: s.id, embedding: vectors[i] })),
          );
          logger.info('Embeddings generated', {
            count: toEmbed.length,
            investigationId,
          });
        }
      } catch (e: any) {
        logger.warn('Embedding generation failed', {
          err: e?.message ?? String(e),
        });
        // Don't fail the investigation — embeddings are nice-to-have.
      }

      const { clusters, signalToCluster, strategy, reason } =
        await clusterSignalsAuto(signals, {
          db: this.cfg.db.raw,
          embeddingClient,
        });
      logger.info('Clustering complete', {
        clusters: clusters.length,
        signals: signals.length,
        strategy,
        reason,
        semanticEligible: signals.length >= MIN_SIGNALS_FOR_SEMANTIC,
      });

      const trends: Trend[] = [];
      const problems: Problem[] = [];

      for (const c of clusters) {
        const clusterSignals = c.signalIds
          .map((sid) => signals.find((s) => s.id === sid))
          .filter(Boolean) as Signal[];
        const clusterEvidence = evidence.filter((e) => clusterSignals.some((s) => s.url === e.url));
        const historical = this.cfg.repositories.signals.findByTopic(c.canonical);

        const { trend } = detectTrend({
          topic: c.canonical,
          canonical: c.canonical,
          signals: clusterSignals,
          evidence: clusterEvidence,
          historicalSignals: historical,
        });
        trends.push(trend);
        this.cfg.repositories.trends.insert(trend, investigationId);

        const { problem } = detectProblem({
          topic: c.canonical,
          canonical: c.canonical,
          signals: clusterSignals,
          evidence: clusterEvidence,
        });
        if (problem) {
          problems.push(problem);
          this.cfg.repositories.problems.insert(problem, investigationId);
        }

        // Record topic observation for memory / temporal evolution
        this.cfg.repositories.topics.recordObservation(
          c.canonical,
          c.sourcesCount,
          c.signalIds.length,
          clusterEvidence.length,
          trend.confidence,
          trend.state,
        );

        const existingTopic = this.cfg.repositories.topics.findByCanonical(c.canonical);
        if (existingTopic) {
          existingTopic.observationCount += 1;
          existingTopic.lastSeen = nowISO();
          existingTopic.sourcesCount = Math.max(existingTopic.sourcesCount, c.sourcesCount);
          this.cfg.repositories.topics.upsert(existingTopic);
        } else {
          this.cfg.repositories.topics.upsert({
            id: c.id,
            canonical: c.canonical,
            keywords: Array.from(new Set(c.keywords)),
            signalIds: c.signalIds,
            evidenceIds: [],
            sourcesCount: c.sourcesCount,
            firstSeen: c.firstSeen,
            lastSeen: c.lastSeen,
            observationCount: 1,
          });
        }
      }

      // ----------------------------------------------------------------------
      // STEP 6: OPPORTUNITY ENGINE
      // ----------------------------------------------------------------------
      const opportunities: Opportunity[] = [];
      for (const trend of trends) {
        const matchingProblem = problems.find((p) => p.topic === trend.topic);
        // Usamos las señales/evidencia ya agrupadas en el trend (vienen del
        // mismo cluster), en vez de filtrar por topic exacto que no matchea
        // porque signal.topic es la query y trend.topic es el canonical.
        const oppSignals = trend.signals.length > 0 ? trend.signals : signals.filter((s) => s.topic === trend.topic);
        const oppEvidence = trend.evidence.length > 0 ? trend.evidence : evidence.filter((e) => e.topic === trend.topic);
        // Solo generamos oportunidad si hay problema detectado, o si el trend es fuerte
        if (!matchingProblem && trend.state !== 'STRONG_TREND' && trend.state !== 'ESTABLISHED_TREND') {
          continue;
        }
        const { opportunity, weak } = generateOpportunity({
          trend,
          problem: matchingProblem,
          signals: oppSignals,
          evidence: oppEvidence,
          geography,
        });
        if (!weak) {
          opportunities.push(opportunity);
          this.cfg.repositories.opportunities.insert(opportunity, investigationId);
        } else {
          logger.info('Skipping weak opportunity', { title: opportunity.title, score: opportunity.score });
        }
      }

      // ----------------------------------------------------------------------
      // STEP 7: REPORT
      // ----------------------------------------------------------------------
      // Cargar los providerRuns desde DB (los tools los persisten individualmente
      // durante el loop, así que el array in-memory está vacío).
      investigation.providerRuns = this.cfg.repositories.investigations.listProviderRuns(investigationId);

      // Setear counts y status ANTES de buildReport para que el executiveSummary
      // muestre el estado final correcto (no RUNNING).
      investigation.trendsFound = trends.length;
      investigation.problemsFound = problems.length;
      investigation.opportunitiesFound = opportunities.length;

      if (signals.length === 0) {
        investigation.status = InvestigationStatus.INSUFFICIENT_EVIDENCE;
      } else if (investigation.errors.length > 0 && opportunities.length === 0) {
        investigation.status = InvestigationStatus.PARTIAL;
      } else {
        investigation.status = InvestigationStatus.COMPLETED;
      }
      investigation.completedAt = nowISO();
      investigation.durationMs = Date.now() - new Date(startedAt).getTime();

      const report = buildReport({
        investigation,
        signals,
        evidence,
        trends,
        problems,
        opportunities,
      });

      this.cfg.repositories.investigations.insert(investigation);

      // ----------------------------------------------------------------------
      // STEP 8: MEMORYDV CONSOLIDATION (spec §12-§15)
      // ----------------------------------------------------------------------
      // After an Investigation persists trends/problems/opportunities, ingest
      // them into the memory subsystem: novel observations become new
      // MemoryRecord rows; corroborated ones get their existing memory
      // promoted to VERIFIED (refreshing last_verified + updated_at so the
      // decay clock resets).
      //
      // Memory is best-effort — any failure here MUST NOT fail the
      // investigation. We also run applyDecay() so old memories get
      // re-ranked on each investigation tick (cheap: only writes back rows
      // whose status or relevance actually changed).
      try {
        const memoryRepo = new MemoryRepository(this.cfg.db);
        const consolidator = new MemoryConsolidator(memoryRepo, this.cfg.repositories);
        await consolidator.ingestInvestigation(investigation, trends, problems, opportunities);
      } catch (e: any) {
        logger.warn('Memory consolidation failed', {
          investigationId,
          err: e?.message ?? String(e),
        });
      }

      try {
        const memoryRepo = new MemoryRepository(this.cfg.db);
        memoryRepo.applyDecay();
      } catch (e: any) {
        logger.warn('Memory decay failed', {
          investigationId,
          err: e?.message ?? String(e),
        });
      }

      logger.info('Investigation completed', {
        investigationId,
        executionId,
        status: investigation.status,
        signals: signals.length,
        evidence: evidence.length,
        trends: trends.length,
        problems: problems.length,
        opportunities: opportunities.length,
        durationMs: investigation.durationMs,
      });

      // §30 — close out the execution trace with summary counts. We always
      // reach this point with a non-FAILED status (FAILED is set in the
      // catch block below). INSUFFICIENT_EVIDENCE counts as success (the
      // agent did its job; the world just didn't have enough signal).
      traceRepo.complete(
        executionId,
        'success',
        {
          signalsCount: signals.length,
          evidenceCount: evidence.length,
          trendsCount: trends.length,
          problemsCount: problems.length,
          opportunitiesCount: opportunities.length,
          investigationStatus: investigation.status,
        },
        // errors[]: investigation.errors already includes the per-tool errors
        // that addError() persisted during the loop. Passing the full array
        // here gives the trace the same complete error log the investigation
        // has — both views stay in sync.
        investigation.errors,
        {
          // tools_used is intentionally omitted — addTool() already persisted
          // the canonical list to the DB during the loop. Passing
          // trace.tools_used here would override the DB state with the
          // stale in-memory array (we no longer mutate trace.tools_used in
          // memory — we go straight through traceRepo.addTool).
          evidence_ids: evidence.map((e) => e.id),
        },
      );

      return {
        investigation,
        signals,
        evidence,
        trends,
        problems,
        opportunities,
        report,
      };
    } catch (e: any) {
      investigation.status = InvestigationStatus.FAILED;
      investigation.errors.push(`orchestrator_exception: ${e?.message ?? String(e)}`);
      investigation.completedAt = nowISO();
      investigation.durationMs = Date.now() - new Date(startedAt).getTime();
      try {
        this.cfg.repositories.investigations.insert(investigation);
      } catch {
        /* ignore persistence errors during error path */
      }
      // §30 — close out the trace as 'failure' so the operator can find it
      // via `chismoso trace list --status=failure`.
      try {
        traceRepo.complete(
          executionId,
          'failure',
          undefined,
          investigation.errors,
          // tools_used intentionally omitted — see comment in the success
          // path. The DB has the canonical list via addTool().
        );
      } catch {
        /* best-effort — trace persistence must never mask the real error */
      }
      logger.error('Investigation failed', { investigationId, executionId, err: e?.message ?? String(e) });
      throw e;
    }
  }
}
