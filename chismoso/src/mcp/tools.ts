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
import { investigateProduct } from '../intelligence/product-intel.js';
import type { EmbeddingClient } from '../intelligence/embeddings.js';
import { logger } from '../logger.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// Directory where the orchestrator persists rendered FICHA markdown
// files. Mirrors the constant in `../ficha/renderer.ts`. When this path
// changes, update both.
const FICHAS_DIR = '/home/z/my-project/download/chismoso/fichas';

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
// TOOL 9: chismoso_product_intel  (Task IMP-CLONA-2 — REA integration)
// ---------------------------------------------------------------------------

const productIntelTool: McpTool = {
  name: 'chismoso_product_intel',
  description:
    'Investigate a product/app using REA (Reverse-engineer Anything). Returns the product\'s ' +
    'tech stack, frameworks, capabilities — WITHOUT accessing its source code. Use this when a ' +
    'trend mentions a specific product/competitor and you want to understand how it\'s built. ' +
    'Requires REA MCP server to be configured (see docs/CLONAKIT-INTEGRATION.md). Output is ' +
    'OBSERVED truth level (REA observes the binary, not source).',
  inputSchema: {
    type: 'object',
    properties: {
      product: {
        type: 'string',
        description:
          'Product name, file path, or URL to investigate. Examples: "Notion", ' +
          '"/Applications/Slack.app", "https://linear.app".',
      },
      depth: {
        type: 'string',
        enum: ['quick', 'standard', 'deep'],
        description: 'Investigation depth. quick=30s, standard=2min, deep=6min.',
        default: 'standard',
      },
    },
    required: ['product'],
    additionalProperties: false,
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async execute(args: any, deps: ChismosoMCPServerDeps) {
    const product = String(args?.product ?? '').trim();
    if (!product) throw new Error('product is required');
    const depth = ['quick', 'standard', 'deep'].includes(args?.depth)
      ? (args.depth as 'quick' | 'standard' | 'deep')
      : 'standard';

    logger.info('MCP chismoso_product_intel start', { product, depth });
    const result = await investigateProduct(product, depth);

    if (!result.available) {
      return {
        product,
        available: false,
        reason: result.reason,
        signals: 0,
        evidence: 0,
      };
    }

    // Persist the produced signals + evidence to the latest investigation
    // (best-effort — if there's no investigation yet, we still return the
    // raw intel to the caller without persisting).
    let persistedSignals = 0;
    let persistedEvidence = 0;
    const investigationId = getLatestInvestigationId(deps.db);
    if (investigationId) {
      if (result.signals.length > 0) {
        try {
          persistedSignals = deps.repositories.signals.insertMany(
            result.signals,
            investigationId,
          );
        } catch (e: any) {
          logger.warn('chismoso_product_intel: signal persistence failed', {
            err: e?.message ?? String(e),
          });
        }
      }
      for (const ev of result.evidence) {
        try {
          deps.repositories.evidence.insert(ev, investigationId);
          persistedEvidence++;
        } catch (e: any) {
          logger.warn('chismoso_product_intel: evidence persistence failed', {
            err: e?.message ?? String(e),
            evId: ev.id,
          });
        }
      }
    } else {
      logger.info(
        'chismoso_product_intel: no investigation in DB — returning intel without persisting',
        { product, signals: result.signals.length },
      );
    }

    return {
      product,
      available: true,
      rea_tool: result.rea_tool,
      signals: result.signals.length,
      evidence: result.evidence.length,
      persistedSignals,
      persistedEvidence,
      investigationId: investigationId ?? null,
      frameworks: result.signals.map((s) => ({
        name: s.keyword,
        purpose: (s.metadata as { purpose?: string }).purpose,
        web_equivalent: (s.metadata as { web_equivalent?: string }).web_equivalent,
      })),
      raw_summary: result.raw_summary?.slice(0, 1000),
    };
  },
};

// ---------------------------------------------------------------------------
// TOOL 10: chismoso_get_ficha (Task IMP-CLONA-1)
// ---------------------------------------------------------------------------

const getFichaTool: McpTool = {
  name: 'chismoso_get_ficha',
  description:
    'Get a FICHA.md structured specification for an opportunity. The FICHA follows the ClonaKit pattern: ' +
    'it describes WHAT to build, not HOW. Suitable for handoff to a builder agent or human developer. ' +
    'A FICHA is generated automatically at the end of every investigation (one per Opportunity). ' +
    'Use this tool to retrieve the rendered markdown + a parsed view (title, one-liner, evidence ' +
    'block, truth_level). Returns found:false if no FICHA has been generated for the given opportunity_id.',
  inputSchema: {
    type: 'object',
    properties: {
      opportunity_id: {
        type: 'string',
        description:
          'Opportunity ID (e.g. "opp_abc123def456"). The FICHA file is looked up by this ID at ' +
          '<FICHAS_DIR>/ficha-<opportunity_id>.md.',
      },
    },
    required: ['opportunity_id'],
    additionalProperties: false,
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async execute(args: any, _deps: ChismosoMCPServerDeps) {
    const rawId = String(args?.opportunity_id ?? '').trim();
    if (!rawId) throw new Error('opportunity_id is required');
    if (!/^[\w-]+$/.test(rawId)) {
      return { found: false, opportunity_id: rawId, error: 'Invalid opportunity_id (allowed: [A-Za-z0-9_-]+)' };
    }
    const safeId = path.basename(rawId);
    const fichaPath = path.join(FICHAS_DIR, `ficha-${safeId}.md`);
    const resolved = path.resolve(fichaPath);
    if (!resolved.startsWith(path.resolve(FICHAS_DIR) + path.sep)) {
      return { found: false, opportunity_id: rawId, error: 'Path traversal detected' };
    }
    let markdown: string;
    let st;
    try {
      markdown = readFileSync(fichaPath, 'utf8');
      st = statSync(fichaPath);
    } catch {
      return {
        found: false,
        opportunity_id: rawId,
        fichaPath,
        message:
          'No FICHA has been generated for this opportunity_id yet. ' +
          'Run `chismoso fichas regenerate <opportunity_id>` or re-run an investigation.',
      };
    }
    const parsed = parseFichaMarkdown(markdown);
    return {
      found: true,
      opportunity_id: safeId,
      fichaPath,
      markdown,
      parsed,
      sizeBytes: st.size,
      generatedAt: st.mtime.toISOString(),
    };
  },
};

// ---------------------------------------------------------------------------
// FICHA MARKDOWN PARSER — tolerant, regex-driven. Matches the format
// produced by `renderFichaMarkdown` in chismoso/src/ficha/renderer.ts.
// Mirrors the parser in src/app/api/fichas/[id]/route.ts — kept in sync
// so MCP clients and REST API clients see the same shape.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseFichaMarkdown(md: string): any {
  try {
    const title = matchLine(md, /^#\s+Ficha:\s*(.+?)\s*$/m);
    const oneLiner = extractSectionBody(md, '## 1. En una frase');
    const targetAudience = extractSectionBody(md, '## 2. Para quién y para qué');

    const evidenceSection = extractRawSection(md, '## 7. Evidencia');
    // The renderer formats the bullets as `- **Opportunity ID:** \`value\``
    // — the bold `**` markers sit between the label and the backtick. Use
    // `.*?` instead of `\s*` so the regex tolerates the bold markers
    // (and any other formatting a human editor might add).
    const opportunityId = matchBullet(evidenceSection, /Opportunity ID:.*?`([^`]+)`/);
    const investigationId = matchBullet(evidenceSection, /Investigation ID:.*?`([^`]+)`/);
    const trendTopic = matchBullet(evidenceSection, /Trend topic:\s*(.+)$/m);
    // Tolerate the bold markers between the label and the number
    // (renderer formats as `- **Signals count:** 5`).
    const signalCountStr = matchBullet(evidenceSection, /Signals count:.*?(\d+)/);
    const signalCount = signalCountStr ? parseInt(signalCountStr, 10) : null;
    const topEvidenceUrls = extractUrlBullets(evidenceSection);

    const truthLevel = matchHeader(md, /Veracidad:\s*(\w+)/);
    const generatedAt = matchHeader(md, /Fecha:\s*(.+?)\s*$/m);

    return {
      title: title ?? null,
      oneLiner: oneLiner ?? null,
      target_audience: targetAudience ?? null,
      evidence: {
        opportunity_id: opportunityId ?? null,
        investigation_id: investigationId ?? null,
        trend_topic: trendTopic ?? null,
        signal_count: Number.isFinite(signalCount) ? signalCount : null,
        top_evidence_urls: topEvidenceUrls,
      },
      truth_level: truthLevel ?? null,
      generated_at: generatedAt ?? null,
    };
  } catch {
    return null;
  }
}

function matchLine(md: string, re: RegExp): string | null {
  const m = md.match(re);
  return m ? m[1] : null;
}

function matchHeader(md: string, re: RegExp): string | null {
  // The header block (`# Ficha:` + `>` quoted lines) sits at the top of
  // the document but is separated by blank lines from the body. Instead
  // of slicing to the first `\n\n` (which would chop off the `>` lines
  // that follow `# Ficha:`), we just search the whole markdown — these
  // header labels are unique enough that they will not appear elsewhere.
  const m = md.match(re);
  return m ? m[1] : null;
}

function extractRawSection(md: string, headingPrefix: string): string {
  const re = new RegExp(`^${escapeRegex(headingPrefix)}.*$`, 'm');
  const m = md.match(re);
  if (!m) return '';
  const start = (m.index ?? 0) + m[0].length;
  const tailMatch = md.slice(start).match(/\n## /);
  const end = tailMatch && tailMatch.index !== undefined ? start + tailMatch.index : md.length;
  return md.slice(start, end);
}

function extractSectionBody(md: string, heading: string): string | null {
  const raw = extractRawSection(md, heading);
  const lines = raw.split('\n');
  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) return null;
    return trimmed;
  }
  return null;
}

function matchBullet(section: string, re: RegExp): string | null {
  const m = section.match(re);
  return m ? m[1] : null;
}

function extractUrlBullets(section: string): string[] {
  const urls: string[] = [];
  const re = /^\s+-\s+(https?:\/\/\S+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(section)) !== null) {
    urls.push(m[1]);
  }
  return urls;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// FICHA DISK HELPERS — shared with the `chismoso://fichas/*` resources.
// ---------------------------------------------------------------------------

interface FichaListItem {
  id: string;
  title: string;
  oneLiner: string;
  generatedAt: string;
  sizeBytes: number;
  fichaPath: string;
}

/**
 * List every persisted FICHA file on disk, newest-first by mtime.
 * Returns [] when the fichas directory does not exist yet.
 */
function listFichasOnDisk(): FichaListItem[] {
  let files: string[];
  try {
    files = readdirSync(FICHAS_DIR);
  } catch {
    return [];
  }
  const fichaFiles = files.filter((f) => f.startsWith('ficha-') && f.endsWith('.md'));
  const items: FichaListItem[] = [];
  for (const f of fichaFiles) {
    try {
      const fichaPath = path.join(FICHAS_DIR, f);
      const st = statSync(fichaPath);
      const md = readFileSync(fichaPath, 'utf8');
      const id = f.replace(/^ficha-/, '').replace(/\.md$/, '');
      items.push({
        id,
        title: matchLine(md, /^#\s+Ficha:\s*(.+?)\s*$/m) ?? id,
        oneLiner: extractSectionBody(md, '## 1. En una frase') ?? '',
        generatedAt: st.mtime.toISOString(),
        sizeBytes: st.size,
        fichaPath,
      });
    } catch {
      /* skip unreadable */
    }
  }
  items.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  return items;
}

/**
 * Returns the newest FichaListItem (by mtime), or null when no fichas
 * exist on disk yet.
 */
function getLatestFichaOnDisk(): FichaListItem | null {
  const items = listFichasOnDisk();
  return items[0] ?? null;
}

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
  productIntelTool,
  getFichaTool,
];

export function getToolByName(name: string): McpTool | undefined {
  return CHISMOSO_MCP_TOOLS.find((t) => t.name === name);
}

// Re-export helpers for tests / programmatic use.
export { getLatestInvestigationId, listInvestigations };
// Re-export the ficha disk helpers so resources.ts can read the same
// data without re-implementing the directory walk.
export {
  listFichasOnDisk,
  getLatestFichaOnDisk,
  parseFichaMarkdown,
  type FichaListItem,
};
