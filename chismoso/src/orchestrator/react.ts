/**
 * CHISMOSO V1.0 — ReAct Orchestrator (improvement #3)
 *
 * Agentic loop with LLM tool-use. Instead of executing a fixed plan
 * end-to-end, the LLM is invoked at decision points to adapt the
 * investigation based on what has actually been observed so far.
 *
 * Loop:
 *   1. PLAN:      LLM returns an initial plan (topics + first 2 queries)
 *   2. EXECUTE:   run those queries via the ToolRegistry
 *   3. OBSERVE:   read signals + evidence back from the DB
 *   4. EVALUATE:  LLM decides one of:
 *                   - search_more   (evidence is thin — try new queries)
 *                   - deepen        (we have promising URLs — fetch full content)
 *                   - stop          (enough evidence — proceed to analysis)
 *   5. If search_more or deepen, go to step 2. If stop, go to step 6.
 *   6. ANALYZE:   cluster + detectTrend + detectProblem + generateOpportunity + buildReport
 *
 * Same InvestigateResult shape as Orchestrator — drop-in replacement.
 * Every ReAct iteration is recorded in `investigation.errors` as a
 * short human-readable string (`react_iter_N: action — reason — +sig +ev`).
 *
 * Budget enforcement: when ANY of (maxQueries | maxProviderCalls |
 * maxRuntimeMs | maxIterations) is exhausted, the next decision is
 * forced to `stop`.
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
// Re-use the Orchestrator contract (drop-in replacement). TYPE-ONLY import
// so we don't drag the Orchestrator class itself into the runtime graph.
import type { OrchestratorConfig, InvestigateInput, InvestigateResult } from './orchestrator.js';

// ---------------------------------------------------------------------------
// PUBLIC TYPES
// ---------------------------------------------------------------------------

export interface ReActDecision {
  action: 'search_more' | 'deepen' | 'stop';
  reason: string;
  /** For action=search_more. Each query must use web_search | reddit_communities. */
  queries?: Array<{ providerName: string; query: string }>;
  /** For action=deepen. Up to 5 URLs. */
  urls?: string[];
  /** For action=deepen. The topic label the URLs relate to. */
  topic?: string;
}

export interface ReActIteration {
  iteration: number;
  decision: ReActDecision;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toolResults: Array<{ toolName: string; args: any; result: any }>;
  signalsAdded: number;
  evidenceAdded: number;
  totalSignals: number;
  totalEvidence: number;
}

// ---------------------------------------------------------------------------
// SYSTEM PROMPT — drives every EVALUATE step
// ---------------------------------------------------------------------------

const REACT_SYSTEM_PROMPT = `You are CHISMOSO's ReAct loop controller.
You receive: an investigation objective, a summary of evidence collected so far, and the remaining budget.
Your job: decide the next action that maximizes information gain within budget.

You MUST respond with valid JSON ONLY (no markdown fences, no comments, no text outside the JSON object).

The JSON shape:
{
  "action": "search_more" | "deepen" | "stop",
  "reason": "string — concise justification, 1-2 sentences, referencing what was observed",
  "queries": [{"providerName": "web_search" | "reddit_communities", "query": "..."}],
  "urls": ["https://..."],
  "topic": "string — relevant when action=deepen"
}

Decision rules:
  - If evidence is THIN (few signals, no clear topics, no promising URLs), choose "search_more" with 1-2 fresh queries targeting an angle not yet explored. Always include geography context in queries.
  - If you see PROMISING URLS in the evidence summary (articles that look like they confirm a trend or problem), choose "deepen" with up to 3 URLs and a topic label. deepen_content fetches full page content via page_reader.
  - If you already have >=8 signals across multiple distinct topics AND the evidence looks sufficient to derive trends/problems, choose "stop" so the analyzer can cluster and score.
  - If budget is nearly exhausted (queries remaining <2 OR time remaining <30s), you MUST choose "stop".

Available providers for queries:
  - web_search (general web search)
  - reddit_communities (community/forum search via site:reddit.com | site:quora.com)

Hard rules:
  - Do NOT repeat queries that appear in "QUERIES ALREADY EXECUTED".
  - For "search_more", every entry in queries[] must use providerName="web_search" or "reddit_communities".
  - For "deepen", pick URLs from the "sample URLs" surfaced in the evidence summary.
  - For "stop", omit queries/urls/topic.
  - The reason field MUST reference concrete observations (counts, topics, snippets).`;

// Map providerName (LLM-facing) → toolName (ToolRegistry-facing).
const PROVIDER_TO_TOOL: Record<string, string> = {
  web_search: 'search_web',
  reddit_communities: 'search_community',
  google_trends: 'collect_trends',
  web_content: 'deepen_content',
};

// ---------------------------------------------------------------------------
// ReActOrchestrator
// ---------------------------------------------------------------------------

export class ReActOrchestrator {
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

    logger.info('ReAct investigation started', {
      investigationId,
      objective: input.objective,
      geography,
      budget: { maxIterations: budget.maxIterations, maxQueries: budget.maxQueries, maxProviderCalls: budget.maxProviderCalls, maxRuntimeMs: budget.maxRuntimeMs },
    });

    const ctx: ToolContext = {
      investigationId,
      geography,
      repositories: this.cfg.repositories,
      providerRegistry: this.cfg.providerRegistry,
    };

    const startTime = Date.now();
    const reactIterations: ReActIteration[] = [];
    const executedQueries = new Set<string>();

    let totalQueries = 0;
    let totalProviderCalls = 0;

    try {
      // -------------------------------------------------------------------
      // STEP 1: PLAN — LLM proposes topics + first 2 queries
      // -------------------------------------------------------------------
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

      const initialQueries = plan.queries.slice(0, 2);
      investigation.providersUsed = Array.from(new Set(plan.queries.map((q) => q.providerName)));

      const firstDecision: ReActDecision = {
        action: 'search_more',
        reason: `Initial plan from ResearchPlanner — topics: ${plan.topics.slice(0, 3).join(', ') || '(none)'}`,
        queries: initialQueries.map((q) => ({ providerName: q.providerName, query: q.query })),
        topic: plan.topics[0],
      };

      // -------------------------------------------------------------------
      // STEPS 2-5: ReAct loop
      // -------------------------------------------------------------------
      let currentDecision: ReActDecision | null = firstDecision;
      let iteration = 0;

      while (currentDecision && iteration < budget.maxIterations) {
        iteration++;
        investigation.iterations = iteration;

        const beforeSig = this.cfg.repositories.signals.findByInvestigation(investigationId).length;
        const beforeEv = this.cfg.repositories.evidence.findByInvestigation(investigationId).length;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const toolResults: Array<{ toolName: string; args: any; result: any }> = [];

        // ---- STEP 2: EXECUTE the current decision ----------------------
        if (currentDecision.action === 'search_more' && currentDecision.queries?.length) {
          for (const q of currentDecision.queries) {
            const key = `${q.providerName}::${q.query}`;
            if (executedQueries.has(key)) {
              investigation.errors.push(`react_iter_${iteration}: skip_duplicate_query ${q.providerName}: ${q.query}`);
              continue;
            }
            if (budgetExhausted(budget, totalQueries, totalProviderCalls, startTime)) {
              investigation.errors.push(`react_iter_${iteration}: budget_exhausted_forcing_stop`);
              currentDecision = { action: 'stop', reason: 'budget exhausted mid-iteration' };
              break;
            }
            executedQueries.add(key);
            investigation.queriesExecuted.push(`${q.providerName}: ${q.query}`);
            totalQueries++;
            totalProviderCalls++;

            const toolName = PROVIDER_TO_TOOL[q.providerName] ?? q.providerName;
            const tool = this.cfg.toolRegistry.get(toolName);
            if (!tool) {
              investigation.errors.push(`react_iter_${iteration}: unknown_tool ${q.providerName}`);
              continue;
            }
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              let args: any;
              if (toolName === 'search_web') args = { query: q.query, geography, num: 10 };
              else if (toolName === 'search_community') args = { query: q.query, num: 10 };
              else if (toolName === 'collect_trends') args = { topic: q.query, geography };
              else {
                investigation.errors.push(`react_iter_${iteration}: unsupported_tool ${toolName}`);
                continue;
              }
              const res = await tool.execute(args, ctx);
              toolResults.push({ toolName, args, result: res });
            } catch (e: any) {
              investigation.errors.push(
                `react_iter_${iteration}: tool_error ${q.providerName}: ${e?.message ?? String(e)}`,
              );
            }
          }
        } else if (currentDecision.action === 'deepen' && currentDecision.urls?.length) {
          if (budgetExhausted(budget, totalQueries, totalProviderCalls, startTime)) {
            investigation.errors.push(`react_iter_${iteration}: budget_exhausted_forcing_stop`);
            currentDecision = { action: 'stop', reason: 'budget exhausted before deepen' };
          } else {
            const urls = currentDecision.urls.slice(0, 5);
            totalProviderCalls++;
            totalQueries++;
            const topicLabel = currentDecision.topic ?? input.objective;
            investigation.queriesExecuted.push(`web_content: ${topicLabel} (${urls.length} urls)`);
            const tool = this.cfg.toolRegistry.get('deepen_content');
            if (!tool) {
              investigation.errors.push(`react_iter_${iteration}: deepen_tool_not_registered`);
            } else {
              try {
                const res = await tool.execute({ urls, topic: topicLabel }, ctx);
                toolResults.push({ toolName: 'deepen_content', args: { urls, topic: topicLabel }, result: res });
              } catch (e: any) {
                investigation.errors.push(
                  `react_iter_${iteration}: deepen_error: ${e?.message ?? String(e)}`,
                );
              }
            }
          }
        } else if (currentDecision.action !== 'stop') {
          // Malformed decision — log and continue (will fall through to evaluate).
          investigation.errors.push(
            `react_iter_${iteration}: malformed_decision action=${currentDecision.action} (no actionable payload)`,
          );
        }

        // ---- STEP 3: OBSERVE --------------------------------------------
        const signalsAfter = this.cfg.repositories.signals.findByInvestigation(investigationId);
        const evidenceAfter = this.cfg.repositories.evidence.findByInvestigation(investigationId);
        const signalsAdded = signalsAfter.length - beforeSig;
        const evidenceAdded = evidenceAfter.length - beforeEv;

        reactIterations.push({
          iteration,
          decision: currentDecision,
          toolResults,
          signalsAdded,
          evidenceAdded,
          totalSignals: signalsAfter.length,
          totalEvidence: evidenceAfter.length,
        });

        const reasonBrief = currentDecision.reason.replace(/\s+/g, ' ').slice(0, 120);
        investigation.errors.push(
          `react_iter_${iteration}: ${currentDecision.action} — reason: "${reasonBrief}" — +${signalsAdded}sig +${evidenceAdded}ev (total ${signalsAfter.length}/${evidenceAfter.length})`,
        );

        logger.info('ReAct iteration completed', {
          investigationId,
          iteration,
          action: currentDecision.action,
          signalsAdded,
          evidenceAdded,
          totalSignals: signalsAfter.length,
          totalEvidence: evidenceAfter.length,
          queriesUsed: totalQueries,
          providerCallsUsed: totalProviderCalls,
          runtimeMs: Date.now() - startTime,
        });

        // ---- STEP 4: EVALUATE (unless already stopping) ----------------
        if (currentDecision.action === 'stop') break;

        // Force-stop on budget exhaustion after the iteration completed.
        if (budgetExhausted(budget, totalQueries, totalProviderCalls, startTime)) {
          investigation.errors.push(
            `react_iter_${iteration}: budget_exhausted_forcing_stop_after_iteration`,
          );
          break;
        }

        // Optimization + safety: if the next loop check `iteration < maxIterations`
        // will be false, don't bother asking the LLM for another decision — we
        // wouldn't run another iteration anyway. This avoids an extra LLM call
        // AND avoids a known better-sqlite3/SDK interaction crash that seems
        // to happen when too many ZAI calls are made in a single process.
        if (iteration >= budget.maxIterations) {
          investigation.errors.push(
            `react_iter_${iteration}: max_iterations_reached_forcing_stop`,
          );
          break;
        }

        currentDecision = await this.evaluateDecision({
          objective: input.objective,
          geography,
          signals: signalsAfter,
          evidence: evidenceAfter,
          executedQueries: Array.from(executedQueries),
          budget,
          queriesUsed: totalQueries,
          providerCallsUsed: totalProviderCalls,
          runtimeMs: Date.now() - startTime,
        });
      }

      // -------------------------------------------------------------------
      // STEP 6: ANALYZE — cluster + trend + problem + opportunity + report
      // (Same as Orchestrator.investigate — drop-in replacement contract.)
      // -------------------------------------------------------------------
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
          logger.info('ReAct embeddings generated', {
            count: toEmbed.length,
            investigationId,
          });
        }
      } catch (e: any) {
        logger.warn('ReAct embedding generation failed', {
          err: e?.message ?? String(e),
        });
        // Don't fail the investigation — embeddings are nice-to-have.
      }

      const { clusters, strategy, reason } = await clusterSignalsAuto(signals, {
        db: this.cfg.db.raw,
        embeddingClient,
      });
      logger.info('ReAct clustering complete', {
        clusters: clusters.length,
        signals: signals.length,
        strategy,
        reason,
        semanticEligible: signals.length >= MIN_SIGNALS_FOR_SEMANTIC,
      });

      const trends: Trend[] = [];
      const problems: Problem[] = [];

      for (const c of clusters) {
        const clusterSigs = c.signalIds
          .map((sid) => signals.find((s) => s.id === sid))
          .filter(Boolean) as Signal[];
        const clusterEvidence = evidence.filter((e) => clusterSigs.some((s) => s.url === e.url));
        const historical = this.cfg.repositories.signals.findByTopic(c.canonical);

        const { trend } = detectTrend({
          topic: c.canonical,
          canonical: c.canonical,
          signals: clusterSigs,
          evidence: clusterEvidence,
          historicalSignals: historical,
        });
        trends.push(trend);
        this.cfg.repositories.trends.insert(trend, investigationId);

        const { problem } = detectProblem({
          topic: c.canonical,
          canonical: c.canonical,
          signals: clusterSigs,
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

      // OPPORTUNITY ENGINE
      const opportunities: Opportunity[] = [];
      for (const trend of trends) {
        const matchingProblem = problems.find((p) => p.topic === trend.topic);
        const oppSignals = trend.signals.length > 0 ? trend.signals : signals.filter((s) => s.topic === trend.topic);
        const oppEvidence = trend.evidence.length > 0 ? trend.evidence : evidence.filter((e) => e.topic === trend.topic);
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
          logger.info('ReAct: skipping weak opportunity', {
            title: opportunity.title,
            score: opportunity.score,
          });
        }
      }

      // REPORT
      investigation.providerRuns = this.cfg.repositories.investigations.listProviderRuns(investigationId);
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

      logger.info('ReAct investigation completed', {
        investigationId,
        status: investigation.status,
        signals: signals.length,
        evidence: evidence.length,
        trends: trends.length,
        problems: problems.length,
        opportunities: opportunities.length,
        reactIterations: reactIterations.length,
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
      investigation.errors.push(`react_orchestrator_exception: ${e?.message ?? String(e)}`);
      investigation.completedAt = nowISO();
      investigation.durationMs = Date.now() - new Date(startedAt).getTime();
      try {
        this.cfg.repositories.investigations.insert(investigation);
      } catch {
        /* ignore persistence errors during error path */
      }
      logger.error('ReAct investigation failed', {
        investigationId,
        err: e?.message ?? String(e),
      });
      throw e;
    }
  }

  /**
   * Ask the LLM for the next decision based on the current state of evidence.
   * Falls back to `{action:'stop'}` if the LLM call fails or returns invalid
   * JSON — never throws.
   */
  private async evaluateDecision(input: {
    objective: string;
    geography: string;
    signals: Signal[];
    evidence: Evidence[];
    executedQueries: string[];
    budget: InvestigationBudget;
    queriesUsed: number;
    providerCallsUsed: number;
    runtimeMs: number;
  }): Promise<ReActDecision> {
    const { signals, evidence, budget } = input;

    // Build the evidence summary for the LLM
    const sampleSignals = signals.slice(-3); // most recent 3
    const distinctTopics = Array.from(new Set(signals.map((s) => s.topic))).slice(0, 8);
    const sampleUrls = Array.from(new Set(evidence.map((e) => e.url).filter(Boolean))).slice(0, 8);
    const sourcesUsed = Array.from(new Set(evidence.map((e) => e.source)));

    const queriesRemaining = Math.max(0, budget.maxQueries - input.queriesUsed);
    const providerCallsRemaining = Math.max(0, budget.maxProviderCalls - input.providerCallsUsed);
    const runtimeRemainingMs = Math.max(0, budget.maxRuntimeMs - input.runtimeMs);
    const runtimeRemainingS = Math.round(runtimeRemainingMs / 1000);

    const userPrompt = `OBJECTIVE:
${input.objective}

GEOGRAPHY: ${input.geography}

BUDGET STATUS:
  queries used: ${input.queriesUsed} / ${budget.maxQueries} (remaining: ${queriesRemaining})
  provider calls used: ${input.providerCallsUsed} / ${budget.maxProviderCalls} (remaining: ${providerCallsRemaining})
  runtime used: ${Math.round(input.runtimeMs / 1000)}s / ${Math.round(budget.maxRuntimeMs / 1000)}s (remaining: ${runtimeRemainingS}s)

EVIDENCE SUMMARY:
  total signals: ${signals.length}
  total evidence: ${evidence.length}
  sources used: ${sourcesUsed.join(', ') || '(none yet)'}
  distinct topics seen (${distinctTopics.length}):
${distinctTopics.map((t) => `    - ${t}`).join('\n') || '    (none yet)'}
  sample URLs (top ${sampleUrls.length}):
${sampleUrls.map((u) => `    - ${u}`).join('\n') || '    (none yet)'}

SAMPLE SNIPPETS (most recent ${sampleSignals.length}):
${sampleSignals
  .map(
    (s, i) =>
      `  [${i + 1}] [${s.signalType}] topic="${s.topic}" source="${s.source}"\n      snippet: ${s.rawSnippet.slice(0, 200)}`,
  )
  .join('\n') || '  (none yet)'}

QUERIES ALREADY EXECUTED (do NOT repeat — most recent 10):
${input.executedQueries.slice(-10).map((q) => `  - ${q}`).join('\n') || '  (none yet)'}

Decide the next action. Respond with JSON ONLY.`;

    let resp;
    try {
      resp = await this.cfg.llm.chat([
        { role: 'system', content: REACT_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ]);
    } catch (e: any) {
      logger.warn('ReAct: LLM eval failed — forcing stop', {
        err: e?.message ?? String(e),
      });
      return { action: 'stop', reason: `LLM eval failed: ${e?.message ?? String(e)}` };
    }

    const decision = safeParseDecision(resp.content);
    if (!decision) {
      logger.warn('ReAct: LLM returned invalid JSON — forcing stop', {
        contentLen: resp.content.length,
        preview: resp.content.slice(0, 200),
      });
      return { action: 'stop', reason: 'LLM returned invalid JSON decision' };
    }

    // Sanitize queries: only known providers, non-empty strings.
    if (decision.action === 'search_more' && Array.isArray(decision.queries)) {
      decision.queries = decision.queries.filter(
        (q) =>
          q &&
          (q.providerName === 'web_search' || q.providerName === 'reddit_communities') &&
          typeof q.query === 'string' &&
          q.query.length > 0,
      );
      if (decision.queries.length === 0) {
        return {
          action: 'stop',
          reason: 'LLM did not provide valid queries for search_more — stopping to avoid wasting budget',
        };
      }
    }

    // Sanitize urls: must be http(s) URLs.
    if (decision.action === 'deepen' && Array.isArray(decision.urls)) {
      decision.urls = decision.urls.filter(
        (u) => typeof u === 'string' && /^https?:\/\//.test(u),
      );
      if (decision.urls.length === 0) {
        return {
          action: 'stop',
          reason: 'LLM did not provide valid URLs for deepen — stopping',
        };
      }
    }

    // Force-stop if budget is nearly exhausted (defensive — the prompt also asks).
    if (queriesRemaining < 2 || providerCallsRemaining < 2 || runtimeRemainingMs < 30_000) {
      return {
        action: 'stop',
        reason: `Budget nearly exhausted (q=${queriesRemaining}, pc=${providerCallsRemaining}, rt=${runtimeRemainingS}s) — stopping`,
      };
    }

    return decision;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function budgetExhausted(
  budget: InvestigationBudget,
  queriesUsed: number,
  providerCallsUsed: number,
  startTime: number,
): boolean {
  return (
    queriesUsed >= budget.maxQueries ||
    providerCallsUsed >= budget.maxProviderCalls ||
    Date.now() - startTime > budget.maxRuntimeMs
  );
}

function safeParseDecision(content: string): ReActDecision | null {
  try {
    const jsonStr = extractJson(content);
    if (!jsonStr) return null;
    const obj = JSON.parse(jsonStr);
    if (typeof obj.action !== 'string') return null;
    if (!['search_more', 'deepen', 'stop'].includes(obj.action)) return null;
    if (typeof obj.reason !== 'string') obj.reason = '(no reason provided)';
    return obj as ReActDecision;
  } catch {
    return null;
  }
}

function extractJson(s: string): string | null {
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) return null;
  return s.slice(start, end + 1);
}
