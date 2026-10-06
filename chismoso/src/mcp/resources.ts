/**
 * CHISMOSO V1.3 — MCP Resources (Task MCP-1)
 *
 * Declares 6 addressable resources that any MCP client can read on-demand.
 * Resources differ from tools in that they are READ-ONLY data addressed by
 * URI, not parameterised functions. MCP clients typically surface them as a
 * "files" or "context" panel that the user can attach to a conversation.
 *
 * The 6 resources:
 *   chismoso://investigations/latest        — most recent investigation summary
 *   chismoso://investigations/{id}          — full investigation by ID (template)
 *   chismoso://topics                       — observed topics list
 *   chismoso://anomalies/active             — currently detected anomalies
 *   chismoso://providers                    — providers + health
 *   chismoso://opportunities/top            — top 20 opportunities by score
 *
 * Implementation notes:
 *   - `chismoso://investigations/{id}` is a URI template (RFC 6570). The MCP
 *     spec exposes it via `resourceTemplates`, while the other 5 are static
 *     and exposed via `resources`.
 *   - `read(uri)` parses the URI, dispatches to the right handler, and
 *     returns a JSON-serialisable object. `server.ts` wraps it as MCP text.
 *   - Unknown URIs raise an explicit error (no silent fallback) so a client
 *     can surface a clean 404 to the user.
 */

import type { ChismosoMCPServerDeps } from './tools.js';
import { getLatestInvestigationId, listInvestigations } from './tools.js';
import { AnomalyDetector } from '../anomaly/index.js';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface McpResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface McpResourceTemplate {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface McpResourceBundle {
  resources: McpResource[];
  resourceTemplates: McpResourceTemplate[];
}

// ---------------------------------------------------------------------------
// STATIC RESOURCE LIST
// ---------------------------------------------------------------------------

const STATIC_RESOURCES: McpResource[] = [
  {
    uri: 'chismoso://investigations/latest',
    name: 'Latest Investigation',
    description: 'The most recently started investigation, with summary counts.',
    mimeType: 'application/json',
  },
  {
    uri: 'chismoso://topics',
    name: 'Observed Topics',
    description: 'Distinct topics CHISMOSO has tracked (union of topic_observations and trends).',
    mimeType: 'application/json',
  },
  {
    uri: 'chismoso://anomalies/active',
    name: 'Active Anomalies',
    description: 'All currently detected anomalies across every topic.',
    mimeType: 'application/json',
  },
  {
    uri: 'chismoso://providers',
    name: 'Providers + Health',
    description: 'All registered providers with their capabilities and current health.',
    mimeType: 'application/json',
  },
  {
    uri: 'chismoso://opportunities/top',
    name: 'Top Opportunities',
    description: 'Top 20 opportunities by score across every investigation.',
    mimeType: 'application/json',
  },
];

const RESOURCE_TEMPLATES: McpResourceTemplate[] = [
  {
    uriTemplate: 'chismoso://investigations/{id}',
    name: 'Investigation by ID',
    description: 'Full investigation detail (trends, problems, opportunities, signals, evidence).',
    mimeType: 'application/json',
  },
];

export const CHISMOSO_MCP_RESOURCES: McpResourceBundle = {
  resources: STATIC_RESOURCES,
  resourceTemplates: RESOURCE_TEMPLATES,
};

// ---------------------------------------------------------------------------
// READ DISPATCHER
// ---------------------------------------------------------------------------

/**
 * Read a resource by URI. Returns a JSON-serialisable object that
 * `server.ts` wraps as MCP `text` content.
 *
 * Supported URIs:
 *   - chismoso://investigations/latest
 *   - chismoso://investigations/{id}
 *   - chismoso://topics
 *   - chismoso://anomalies/active
 *   - chismoso://providers
 *   - chismoso://opportunities/top
 *
 * @throws Error if the URI does not match any known resource.
 */
export async function readChismosoResource(
  uri: string,
  deps: ChismosoMCPServerDeps,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  if (uri === 'chismoso://investigations/latest') {
    return readLatestInvestigation(deps);
  }
  // chismoso://investigations/{id} — parse the path segment after the last '/'
  if (uri.startsWith('chismoso://investigations/')) {
    const id = decodeURIComponent(uri.slice('chismoso://investigations/'.length));
    if (!id || id === 'latest') {
      return readLatestInvestigation(deps);
    }
    return readInvestigationById(deps, id);
  }
  if (uri === 'chismoso://topics') {
    return readTopics(deps);
  }
  if (uri === 'chismoso://anomalies/active') {
    return readAnomalies(deps);
  }
  if (uri === 'chismoso://providers') {
    return readProviders(deps);
  }
  if (uri === 'chismoso://opportunities/top') {
    return readTopOpportunities(deps);
  }
  throw new Error(`Unknown CHISMOSO resource URI: ${uri}`);
}

// ---------------------------------------------------------------------------
// HANDLERS
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readLatestInvestigation(deps: ChismosoMCPServerDeps): Promise<any> {
  const id = getLatestInvestigationId(deps.db);
  if (!id) {
    return { found: false, message: 'No investigations stored yet.' };
  }
  return readInvestigationById(deps, id);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readInvestigationById(deps: ChismosoMCPServerDeps, id: string): Promise<any> {
  const inv = deps.repositories.investigations.get(id);
  if (!inv) {
    return { found: false, id, message: `Investigation ${id} not found` };
  }
  const trends = deps.repositories.trends.findByInvestigation(id);
  const problems = deps.repositories.problems.findByInvestigation(id);
  const opportunities = deps.repositories.opportunities.findByInvestigation(id);
  const signals = deps.repositories.signals.findByInvestigation(id);
  const evidence = deps.repositories.evidence.findByInvestigation(id);
  const providerRuns = deps.repositories.investigations.listProviderRuns(id);
  return {
    found: true,
    investigation: inv,
    trends,
    problems,
    opportunities,
    signalsCount: signals.length,
    evidenceCount: evidence.length,
    providerRuns,
    // Don't dump full signals/evidence arrays — they can be huge. Surface
    // counts + a small sample of recent signals so the LLM has enough
    // context without burning the entire token budget.
    recentSignals: signals.slice(0, 10).map((s) => ({
      id: s.id,
      topic: s.topic,
      source: s.source,
      signalType: s.signalType,
      timestamp: s.timestamp,
      url: s.url,
      snippet: s.rawSnippet.slice(0, 200),
    })),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readTopics(deps: ChismosoMCPServerDeps): Promise<any> {
  const observedRows = deps.db
    .prepare('SELECT DISTINCT topic FROM topic_observations ORDER BY topic ASC')
    .all() as Array<{ topic: string }>;
  const trendRows = deps.db
    .prepare('SELECT DISTINCT topic FROM trends ORDER BY topic ASC')
    .all() as Array<{ topic: string }>;
  const observed = observedRows.map((r) => r.topic);
  const trendTopics = trendRows.map((r) => r.topic);
  const union = Array.from(new Set([...observed, ...trendTopics])).sort();
  return {
    count: union.length,
    topics: union,
    observedInObservations: observed,
    observedInTrends: trendTopics,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readAnomalies(deps: ChismosoMCPServerDeps): Promise<any> {
  const detector = new AnomalyDetector(deps.repositories);
  const anomalies = detector.detectAll();
  return {
    ranAt: new Date().toISOString(),
    count: anomalies.length,
    anomalies,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readProviders(deps: ChismosoMCPServerDeps): Promise<any> {
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
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readTopOpportunities(deps: ChismosoMCPServerDeps): Promise<any> {
  const opportunities = deps.repositories.opportunities.findTop(20);
  return {
    count: opportunities.length,
    opportunities,
  };
}

// ---------------------------------------------------------------------------
// SMALL HELPER — for `chismoso://investigations/latest` we may want the
// 5 most recent investigations as a context summary. Kept for completeness;
// the current handler only returns the single newest.
// ---------------------------------------------------------------------------

export function listRecentInvestigationSummaries(
  deps: ChismosoMCPServerDeps,
  limit = 5,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any[] {
  return listInvestigations(deps.db, limit).map((r) => ({
    id: r.id,
    query: r.query,
    scope: r.scope,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    status: r.status,
    signalsFound: r.signals_found,
    trendsFound: r.trends_found,
    problemsFound: r.problems_found,
    opportunitiesFound: r.opportunities_found,
    durationMs: r.duration_ms,
  }));
}
