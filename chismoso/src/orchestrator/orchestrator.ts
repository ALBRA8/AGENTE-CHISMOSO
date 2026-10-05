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
import type { ToolRegistry, ToolContext } from './tools.js';
import type { ProviderRegistry } from '../providers/base.js';
import type { Repositories } from '../repositories.js';
import type { ChismosoDB } from '../db.js';
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
import { clusterSignals } from '../intelligence/clustering.js';
import { detectTrend } from '../intelligence/trends.js';
import { detectProblem } from '../intelligence/problems.js';
import { generateOpportunity } from '../intelligence/opportunities.js';
import { buildReport } from './reporter.js';

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
    };

    logger.info('Investigation started', { investigationId, objective: input.objective, geography });

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
        throw e;
      }

      investigation.providersUsed = Array.from(new Set(plan.queries.map((q) => q.providerName)));

      const ctx: ToolContext = {
        investigationId,
        geography,
        repositories: this.cfg.repositories,
        providerRegistry: this.cfg.providerRegistry,
      };

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
          try {
            if (toolName === 'search_web') {
              await tool.execute({ query: q.query, geography, num: 10 }, ctx);
            } else if (toolName === 'search_community') {
              await tool.execute({ query: q.query, num: 10 }, ctx);
            } else if (toolName === 'collect_trends') {
              await tool.execute({ topic: q.query, geography }, ctx);
            } else if (toolName === 'deepen_content') {
              // deepen_content necesita URLs; no se invoca desde el plan
              // porque el plan solo contiene queries textuales.
              investigation.errors.push('deepen_content_skipped_in_plan_phase');
            } else {
              investigation.errors.push(`unsupported_tool: ${toolName}`);
            }
          } catch (e: any) {
            investigation.errors.push(`tool_error[${q.providerName}]: ${e?.message ?? String(e)}`);
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

      const { clusters, signalToCluster } = clusterSignals(signals);
      logger.info('Clustering complete', { clusters: clusters.length, signals: signals.length });

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

      logger.info('Investigation completed', {
        investigationId,
        status: investigation.status,
        signals: signals.length,
        evidence: evidence.length,
        trends: trends.length,
        problems: problems.length,
        opportunities: opportunities.length,
        durationMs: investigation.durationMs,
      });

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
      logger.error('Investigation failed', { investigationId, err: e?.message ?? String(e) });
      throw e;
    }
  }
}
