/**
 * CHISMOSO V1.3 — MCP Tool Definitions (Task MCP-1)
 *
 * Declares 8 MCP tools that expose CHISMOSO's capabilities to any MCP client
 * (Claude Desktop, Cursor, Continue.dev, Cline, etc.). Each tool is a thin
 * wrapper over the existing CHISMOSO stack (Orchestrator + Repositories +
 * AnomalyDetector + semanticSearch) — no business logic is duplicated.
 *
 * Each tool descriptor is a plain object with:
 *   - name           (dotted chismoso_* identifier, MCP-convention snake_case)
 *   - description    (single paragraph, surfaces to the LLM)
 *   - inputSchema    (JSON Schema draft-07 — required by the MCP spec)
 *   - execute(args)  (handler that returns a JSON-serialisable object)
 *
 * The handler runs against a `ChismosoMCPServerDeps` injected by the server
 * (see server.ts). It owns no global state — every call constructs the
 * collaborator it needs (Orchestrator, AnomalyDetector, etc.) on demand so
 * the server is safe to call concurrently from multiple MCP clients.
 *
 * Return value convention:
 *   - Each `execute` returns an object. `server.ts` serialises it to JSON
 *     and wraps it in an MCP `text` content block.
 *   - For `chismoso_investigate` (long-running, may take minutes) we cap
 *     the budget at `maxRuntimeMs` (default 5 min, MCP-callable override).
 */

import type { ChismosoDB } from '../db.js';
import type { Repositories } from '../repositories.js';
import type { ProviderRegistry } from '../providers/base.js';
import type { ToolRegistry } from '../orchestrator/tools.js';
import { Orchestrator, LLMClient, createDefaultToolRegistry } from '../orchestrator/index.js';
import { AnomalyDetector } from '../anomaly/index.js';
import { semanticSearch } from '../intelligence/semantic-search.js';
import type { EmbeddingClient } from '../intelligence/embeddings.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// DEPS — injected by the MCP server (see server.ts)
// ---------------------------------------------------------------------------

export interface ChismosoMCPServerDeps {
  db: ChismosoDB;
  repositories: Repositories;
  providerRegistry: ProviderRegistry;
  /** Optional pre-built tool registry. If absent, a default one is built per call. */
  toolRegistry?: ToolRegistry;
  /** Optional shared LLM client. If absent, a fresh LLMClient is built per call. */
  llm?: LLMClient;
  /** Optional shared embedding client for semantic search. */
  embeddingClient?: EmbeddingClient;
}

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

// JSON Schema is a plain object — we type it loosely because the MCP SDK
// accepts `Record<string, unknown>` for inputSchema.
export type JSONSchema = Record<string, unknown>;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (args: any, deps: ChismosoMCPServerDeps) => Promise<any>;
}

// ---------------------------------------------------------------------------
// SHARED HELPERS
// ---------------------------------------------------------------------------

interface InvestigationListRow {
  id: string;
  query: string;
  scope: string | null;
  started_at: string;
  completed_at: string | null;
  status: string;
  signals_found: number;
  evidence_found: number;
  trends_found: number;
  problems_found: number;
  opportunities_found: number;
  duration_ms: number | null;
  iterations: number | null;
}

function listInvestigations(db: ChismosoDB, limit: number): InvestigationListRow[] {
  return db
    .prepare(
      'SELECT id, query, scope, started_at, completed_at, status, ' +
      'signals_found, evidence_found, trends_found, problems_found, ' +
      'opportunities_found, duration_ms, iterations ' +
      'FROM investigations ORDER BY started_at DESC LIMIT ?',
    )
    .all(limit) as InvestigationListRow[];
}

function getLatestInvestigationId(db: ChismosoDB): string | null {
  const row = db
    .prepare('SELECT id FROM investigations ORDER BY started_at DESC LIMIT 1')
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}

function listObservedTopics(db: ChismosoDB): string[] {
  const rows = db
    .prepare('SELECT DISTINCT topic FROM topic_observations ORDER BY topic ASC')
    .all() as Array<{ topic: string }>;
  return rows.map((r) => r.topic);
}

function listTrendTopics(db: ChismosoDB): string[] {
  const rows = db
    .prepare('SELECT DISTINCT topic FROM trends ORDER BY topic ASC')
    .all() as Array<{ topic: string }>;
  return rows.map((r) => r.topic);
}

// ---------------------------------------------------------------------------
// TOOL 1: chismoso_investigate
// ---------------------------------------------------------------------------

const investigateTool: McpTool = {
  name: 'chismoso_investigate',
  description:
    'Run a full CHISMOSO intelligence investigation for the given objective. ' +
    'Executes the entire pipeline: PLAN (LLM) → COLLECT (real web/community providers) → ' +
    'NORMALIZE/DEDUP/CLUSTER → TREND DETECTION → PROBLEM DETECTION → CROSS-SOURCE → ' +
    'OPPORTUNITY ENGINE → SCORING → REPORT. Persists results to SQLite and returns ' +
    'trends, problems, and opportunities as JSON. May take 30s–5min depending on budget. ' +
    'NOT idempotent — each call creates new investigation records.',
  inputSchema: {
    type: 'object',
    properties: {
      objective: {
        type: 'string',
        description:
          'High-level research question, e.g. "emerging trends and business opportunities ' +
          'for restaurant automation in Colombia".',
      },
      geography: {
        type: 'string',
        description: 'Geographic scope (default: "global"). Example: "Colombia", "ES", "US-CA".',
      },
      maxQueries: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'Maximum number of provider queries to execute (default: 12).',
      },
      maxRuntimeMs: {
        type: 'integer',
        minimum: 5_000,
        maximum: 600_000,
        description: 'Maximum wall-clock runtime in milliseconds (default: 300000 = 5 min).',
      },
    },
    required: ['objective'],
    additionalProperties: false,
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async execute(args: any, deps: ChismosoMCPServerDeps) {
    const objective = String(args?.objective ?? '').trim();
    if (!objective) throw new Error('objective is required');
    const geography = args?.geography ? String(args.geography) : 'global';
    const maxQueries = Number.isFinite(args?.maxQueries) ? Number(args.maxQueries) : undefined;
    const maxRuntimeMs = Number.isFinite(args?.maxRuntimeMs) ? Number(args.maxRuntimeMs) : undefined;

    const toolRegistry = deps.toolRegistry ?? createDefaultToolRegistry();
    const llm = deps.llm ?? new LLMClient();
    const orchestrator = new Orchestrator({
      db: deps.db,
      repositories: deps.repositories,
      providerRegistry: deps.providerRegistry,
      toolRegistry,
      llm,
      budget: { maxQueries, maxRuntimeMs },
    });

    const t0 = Date.now();
    logger.info('MCP chismoso_investigate start', { objective, geography, maxQueries, maxRuntimeMs });
    const result = await orchestrator.investigate({ objective, geography });
    const elapsedMs = Date.now() - t0;
    logger.info('MCP chismoso_investigate done', {
      investigationId: result.investigation.id,
      elapsedMs,
      status: result.investigation.status,
    });

    return {
      investigationId: result.investigation.id,
      status: result.investigation.status,
      scope: result.investigation.scope,
      signalsFound: result.signals.length,
      evidenceFound: result.evidence.length,
      trendsCount: result.trends.length,
      problemsCount: result.problems.length,
      opportunitiesCount: result.opportunities.length,
      durationMs: elapsedMs,
      trends: result.trends.map(summariseTrend),
      problems: result.problems.map(summariseProblem),
      opportunities: result.opportunities.map(summariseOpportunity),
      executiveSummary: result.report.machine.executiveSummary,
      limitations: result.report.machine.limitations,
      recommendedNextAction: result.report.machine.recommendedNextAction,
      overallConfidence: result.report.machine.overallConfidence,
    };
  },
};

// ---------------------------------------------------------------------------
// TOOL 2: chismoso_semantic_search
// ---------------------------------------------------------------------------

const semanticSearchTool: McpTool = {
  name: 'chismoso_semantic_search',
  description:
    'TF-IDF cosine-similarity semantic search over all stored signals. ' +
    'Returns the top-K signals whose raw_snippet best matches the query. ' +
    'Read-only — safe to call any number of times.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Free-text query (English or Spanish).',
      },
      topK: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'Max results (default: 10).',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async execute(args: any, deps: ChismosoMCPServerDeps) {
    const query = String(args?.query ?? '').trim();
    if (!query) throw new Error('query is required');
    const topK = Number.isFinite(args?.topK) ? Number(args.topK) : 10;
    const results = await semanticSearch(query, {
      db: deps.db.raw,
      topK,
      embeddingClient: deps.embeddingClient,
    });
    return {
      query,
      topK,
      count: results.length,
      results,
    };
  },
};

// ---------------------------------------------------------------------------
// TOOL 3: chismoso_list_investigations
// ---------------------------------------------------------------------------

const listInvestigationsTool: McpTool = {
  name: 'chismoso_list_investigations',
  description:
    'List past investigations, newest first. Each entry includes id, query, scope, ' +
    'status, signal/trend/opportunity counts, duration, and iterations.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 200,
        description: 'Max results (default: 20).',
      },
    },
    additionalProperties: false,
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async execute(args: any, deps: ChismosoMCPServerDeps) {
    const limit = Number.isFinite(args?.limit) ? Number(args.limit) : 20;
    const rows = listInvestigations(deps.db, limit);
    return {
      count: rows.length,
      investigations: rows.map((r) => ({
        id: r.id,
        query: r.query,
        scope: r.scope,
        startedAt: r.started_at,
        completedAt: r.completed_at,
        status: r.status,
        signalsFound: r.signals_found,
        evidenceFound: r.evidence_found,
        trendsFound: r.trends_found,
        problemsFound: r.problems_found,
        opportunitiesFound: r.opportunities_found,
        durationMs: r.duration_ms,
        iterations: r.iterations,
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// TOOL 4: chismoso_get_investigation
// ---------------------------------------------------------------------------

const getInvestigationTool: McpTool = {
  name: 'chismoso_get_investigation',
  description:
    'Get the full investigation report by ID: trends, problems, opportunities, ' +
    'signal counts, evidence counts, providers used, and errors. Use IDs from ' +
    'chismoso_list_investigations or chismoso://investigations/latest.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Investigation ID (e.g. "inv_abc123def456").',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async execute(args: any, deps: ChismosoMCPServerDeps) {
    const id = String(args?.id ?? '').trim();
    if (!id) throw new Error('id is required');
    const inv = deps.repositories.investigations.get(id);
    if (!inv) {
      return { found: false, id, error: 'Investigation not found' };
    }
    const trends = deps.repositories.trends.findByInvestigation(id);
    const opportunities = deps.repositories.opportunities.findByInvestigation(id);
    const problems = deps.repositories.problems.findByInvestigation(id);
    const signals = deps.repositories.signals.findByInvestigation(id);
    const evidence = deps.repositories.evidence.findByInvestigation(id);
    const providerRuns = deps.repositories.investigations.listProviderRuns(id);
    return {
      found: true,
      investigation: inv,
      trends: trends.map(summariseTrend),
      problems: problems.map(summariseProblem),
      opportunities: opportunities.map(summariseOpportunity),
      signalsCount: signals.length,
      evidenceCount: evidence.length,
      providerRuns,
      signals: signals.slice(0, 50).map((s) => ({
        id: s.id,
        topic: s.topic,
        keyword: s.keyword,
        source: s.source,
        sourceType: s.sourceType,
        signalType: s.signalType,
        timestamp: s.timestamp,
        confidence: s.confidence,
        url: s.url,
        snippet: s.rawSnippet.slice(0, 200),
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// TOOL 5: chismoso_list_anomalies
// ---------------------------------------------------------------------------

const listAnomaliesTool: McpTool = {
  name: 'chismoso_list_anomalies',
  description:
    'List active statistical anomalies detected over the topic_observations history. ' +
    'Covers volume spikes/drops, velocity changes, source diversification, and ' +
    'confidence drift. Optionally filter by topic.',
  inputSchema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: 'Filter to a single topic (default: all topics).',
      },
    },
    additionalProperties: false,
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async execute(args: any, deps: ChismosoMCPServerDeps) {
    const detector = new AnomalyDetector(deps.repositories);
    const topic = args?.topic ? String(args.topic) : undefined;
    const anomalies = topic ? detector.detectForTopic(topic) : detector.detectAll();
    return {
      ranAt: new Date().toISOString(),
      topic: topic ?? null,
      count: anomalies.length,
      anomalies,
    };
  },
};

// ---------------------------------------------------------------------------
// TOOL 6: chismoso_list_topics
// ---------------------------------------------------------------------------

const listTopicsTool: McpTool = {
  name: 'chismoso_list_topics',
  description:
    'List distinct topics observed by CHISMOSO (union of topic_observations and trends ' +
    'tables). Useful for discovering what CHISMOSO has been tracking.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async execute(_args: any, deps: ChismosoMCPServerDeps) {
    const observed = listObservedTopics(deps.db);
    const trendTopics = listTrendTopics(deps.db);
    const union = Array.from(new Set([...observed, ...trendTopics])).sort();
    return {
      count: union.length,
      topics: union,
      observedInObservations: observed,
      observedInTrends: trendTopics,
    };
  },
};

// ---------------------------------------------------------------------------
// TOOL 7: chismoso_get_topic_history
// ---------------------------------------------------------------------------

const getTopicHistoryTool: McpTool = {
  name: 'chismoso_get_topic_history',
  description:
    'Temporal evolution of a single topic — the observation rows that the AnomalyDetector ' +
    'consumes. Returns observedAt, sourcesCount, signalsCount, confidence per observation ' +
    '(newest first by default).',
  inputSchema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: 'Exact topic string (e.g. "restaurant automation").',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 200,
        description: 'Max observations to return (default: 20).',
      },
    },
    required: ['topic'],
    additionalProperties: false,
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async execute(args: any, deps: ChismosoMCPServerDeps) {
    const topic = String(args?.topic ?? '').trim();
    if (!topic) throw new Error('topic is required');
    const limit = Number.isFinite(args?.limit) ? Number(args.limit) : 20;
    const history = deps.repositories.topics.getHistory(topic, limit);
    return {
      topic,
      count: history.length,
      history: history.map((h) => ({
        observedAt: h.observed_at,
        sourcesCount: h.sources_count,
        signalsCount: h.signals_count,
        confidence: h.confidence,
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// TOOL 8: chismoso_list_providers
// ---------------------------------------------------------------------------

const listProvidersTool: McpTool = {
  name: 'chismoso_list_providers',
  description:
    'List all registered CHISMOSO providers and their current health. Includes ' +
    'capabilities, source types, rate limits, and authentication requirements. ' +
    'Useful to verify which providers are REAL vs UNAVAILABLE before launching ' +
    'an investigation.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async execute(_args: any, deps: ChismosoMCPServerDeps) {
    const providers = deps.providerRegistry.list();
    const healths = await deps.providerRegistry.allHealth();
    return {
      count: providers.length,
      providers: providers.map((p) => {
        const caps = p.capabilities();
        return {
          name: caps.name,
          type: caps.type,
          status: caps.status,
          capabilities: caps.capabilities,
          authentication: caps.authentication,
          limits: caps.limits,
          health: healths[caps.name] ?? caps.status,
        };
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// SUMMARISERS — trim verbose nested objects to keep tool output LLM-digestible
// ---------------------------------------------------------------------------

interface TrendSummary {
  id: string;
  topic: string;
  description: string;
  state: string;
  confidence: number;
  score: number;
  sourcesCount: number;
  signalsCount: number;
  growth: number;
  velocity: number;
  persistence: number;
  crossSourceConfirmation: number;
  firstSeen: string;
  lastSeen: string;
}

interface ProblemSummary {
  id: string;
  topic: string;
  description: string;
  severity: number;
  frequency: number;
  confidence: number;
  segmentsAffected: string[];
  observationCount: number;
  firstSeen: string;
  lastSeen: string;
}

interface OpportunitySummary {
  id: string;
  title: string;
  description: string;
  problem: string;
  targetSegment: string;
  geography: string;
  score: number;
  confidence: number;
  demand: number;
  growth: number;
  problemSeverity: number;
  monetization: number;
  timing: number;
  marketFit: number;
  competition: number;
  uncertainty: number;
  scoreBreakdown: Record<string, number>;
  suggestedNextAgent: string;
  createdAt: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function summariseTrend(t: any): TrendSummary {
  return {
    id: t.id,
    topic: t.topic,
    description: t.description,
    state: t.state,
    confidence: t.confidence,
    score: t.score,
    sourcesCount: t.sourcesCount,
    signalsCount: t.signalsCount,
    growth: t.growth,
    velocity: t.velocity,
    persistence: t.persistence,
    crossSourceConfirmation: t.crossSourceConfirmation,
    firstSeen: t.firstSeen,
    lastSeen: t.lastSeen,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function summariseProblem(p: any): ProblemSummary {
  return {
    id: p.id,
    topic: p.topic,
    description: p.description,
    severity: p.severity,
    frequency: p.frequency,
    confidence: p.confidence,
    segmentsAffected: p.segmentsAffected ?? [],
    observationCount: p.observationCount,
    firstSeen: p.firstSeen,
    lastSeen: p.lastSeen,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function summariseOpportunity(o: any): OpportunitySummary {
  return {
    id: o.id,
    title: o.title,
    description: o.description,
    problem: o.problem,
    targetSegment: o.targetSegment,
    geography: o.geography,
    score: o.score,
    confidence: o.confidence,
    demand: o.demand,
    growth: o.growth,
    problemSeverity: o.problemSeverity,
    monetization: o.monetization,
    timing: o.timing,
    marketFit: o.marketFit,
    competition: o.competition,
    uncertainty: o.uncertainty,
    scoreBreakdown: o.scoreBreakdown ?? {},
    suggestedNextAgent: o.suggestedNextAgent,
    createdAt: o.createdAt,
  };
}

// ---------------------------------------------------------------------------
// REGISTRY EXPORT
// ---------------------------------------------------------------------------

export const CHISMOSO_MCP_TOOLS: McpTool[] = [
  investigateTool,
  semanticSearchTool,
  listInvestigationsTool,
  getInvestigationTool,
  listAnomaliesTool,
  listTopicsTool,
  getTopicHistoryTool,
  listProvidersTool,
];

export function getToolByName(name: string): McpTool | undefined {
  return CHISMOSO_MCP_TOOLS.find((t) => t.name === name);
}

// Re-export helpers for tests / programmatic use.
export { getLatestInvestigationId, listInvestigations };
