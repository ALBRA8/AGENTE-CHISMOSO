/**
 * CHISMOSO V1.3 — MCP Resources (Task MCP-1)
 *
 * Declares addressable resources that any MCP client can read on-demand.
 * Resources differ from tools in that they are READ-ONLY data addressed by
 * URI, not parameterised functions. MCP clients typically surface them as a
 * "files" or "context" panel that the user can attach to a conversation.
 *
 * The 6 resources:
 *   chismoso://investigations/latest        — most recent investigation summary
 *   chismoso://investigations/{id}          — full investigation by ID (template)
 *   chismoso://product_intel/{product}      — REA investigation of a product (template, IMP-CLONA-2)
 *   chismoso://topics                       — observed topics list
 *   chismoso://anomalies/active             — currently detected anomalies
 *   chismoso://providers                    — providers + health
 *   chismoso://opportunities/top            — top 20 opportunities by score
 *
 * Implementation notes:
 *   - `chismoso://investigations/{id}` and `chismoso://product_intel/{product}`
 *     are URI templates (RFC 6570). The MCP spec exposes them via
 *     `resourceTemplates`, while the other 5 are static and exposed via
 *     `resources`.
 *   - `read(uri)` parses the URI, dispatches to the right handler, and
 *     returns a JSON-serialisable object. `server.ts` wraps it as MCP text.
 *   - Unknown URIs raise an explicit error (no silent fallback) so a client
 *     can surface a clean 404 to the user.
 *   - `chismoso://product_intel/{product}` is SIDE-EFFECT-FREE per the MCP
 *     resource contract — it returns the parsed frameworks but does NOT
 *     persist signals to the DB. Use the `chismoso_product_intel` tool for
 *     persistence (tools are allowed to have side effects).
 */

import type { ChismosoMCPServerDeps } from './tools.js';
import {
  getLatestInvestigationId,
  listInvestigations,
  listFichasOnDisk,
  getLatestFichaOnDisk,
  parseFichaMarkdown,
  type FichaListItem,
} from './tools.js';
import { AnomalyDetector } from '../anomaly/index.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { investigateProduct } from '../intelligence/product-intel.js';

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
  {
    uri: 'chismoso://fichas/latest',
    name: 'Latest FICHA',
    description:
      'The most recently generated FICHA.md structured specification for an opportunity ' +
      '(ClonaKit pattern: describes WHAT to build, not HOW). Suitable for handoff to a ' +
      'builder agent or human developer.',
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
  {
    uriTemplate: 'chismoso://product_intel/{product}',
    name: 'Product intelligence report',
    description:
      'REA investigation of a specific product, normalized to CHISMOSO signals. ' +
      'Requires REA MCP server to be configured (see docs/CLONAKIT-INTEGRATION.md).',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'chismoso://fichas/{id}',
    name: 'FICHA by opportunity ID',
    description:
      'A single FICHA.md structured specification for the given opportunity ID. ' +
      'The FICHA follows the ClonaKit pattern: it describes WHAT to build, not HOW. ' +
      'Returns found:false if no FICHA has been generated for the given ID.',
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
 *   - chismoso://product_intel/{product}        (Task IMP-CLONA-2 — REA)
 *   - chismoso://topics
 *   - chismoso://anomalies/active
 *   - chismoso://providers
 *   - chismoso://opportunities/top
 *   - chismoso://fichas/latest                  (Task IMP-CLONA-1)
 *   - chismoso://fichas/{id}                    (Task IMP-CLONA-1)
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
  // chismoso://fichas/latest + chismoso://fichas/{id} — Task IMP-CLONA-1.
  // FICHA files live on disk under /home/z/my-project/download/chismoso/fichas/
  // and are produced by the orchestrator at the end of every investigation
  // (one FICHA per persisted Opportunity). The "latest" alias returns the
  // file with the newest mtime.
  if (uri === 'chismoso://fichas/latest') {
    return readLatestFicha(deps);
  }
  if (uri.startsWith('chismoso://fichas/')) {
    const id = decodeURIComponent(uri.slice('chismoso://fichas/'.length));
    if (!id || id === 'latest') {
      return readLatestFicha(deps);
    }
    return readFichaById(deps, id);
  }
  // chismoso://product_intel/{product} — Task IMP-CLONA-2 (REA integration).
  // The {product} segment is URL-encoded; we decode it then pass it to
  // `investigateProduct()`, which calls REA via MCP. The result is the
  // full ProductIntelResult — including the produced signals/evidence
  // (NOT persisted by this read handler — reads are side-effect-free per
  // the MCP spec; callers who want to persist must invoke the
  // `chismoso_product_intel` tool instead).
  if (uri.startsWith('chismoso://product_intel/')) {
    const product = decodeURIComponent(uri.slice('chismoso://product_intel/'.length));
    if (!product) {
      return { found: false, message: 'Product name is required in the URI path.' };
    }
    return readProductIntel(deps, product);
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

// ---------------------------------------------------------------------------
// PRODUCT INTEL RESOURCE — chismoso://product_intel/{product} (Task IMP-CLONA-2)
// ---------------------------------------------------------------------------
//
// Read handler is SIDE-EFFECT-FREE per the MCP resource contract: the
// signals/evidence in the returned JSON are NOT persisted to the DB by
// this handler. Callers who want the signals persisted should invoke the
// `chismoso_product_intel` tool instead — tools are allowed to have side
// effects, resources are not.
//
// This separation matters because MCP clients (Claude Desktop, Cursor)
// periodically poll `resources/list` and might accidentally trigger an
// expensive REA investigation if reads had side effects. Keeping reads
// pure means the client can attach the resource URI to a conversation
// for context without paying REA's cost on every poll.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readProductIntel(deps: ChismosoMCPServerDeps, product: string): Promise<any> {
  // Reads use the default depth ('standard') — no query param exists on a
  // URI template read, so operators wanting 'deep' should call the tool
  // explicitly.
  const result = await investigateProduct(product, 'standard');
  return {
    product: result.product,
    available: result.available,
    reason: result.reason,
    rea_tool: result.rea_tool,
    signalsCount: result.signals.length,
    evidenceCount: result.evidence.length,
    // Surface the parsed frameworks (name + purpose + web equivalent) so
    // a client doesn't need to re-parse the raw_summary text.
    frameworks: result.signals.map((s) => ({
      name: s.keyword,
      purpose: (s.metadata as { purpose?: string }).purpose,
      web_equivalent: (s.metadata as { web_equivalent?: string }).web_equivalent,
    })),
    // Truncated raw report — useful for debugging parser misses.
    raw_summary: result.raw_summary?.slice(0, 4000) ?? null,
    note: result.available
      ? undefined
      : 'REA MCP server not configured. To persist signals, install rea-agents + call chismoso_product_intel tool. See docs/CLONAKIT-INTEGRATION.md.',
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
// FICHA HANDLERS (Task IMP-CLONA-1)
//
// FICHA files live on disk under /home/z/my-project/download/chismoso/fichas/
// (see FICHAS_DIR in tools.ts). They are produced by the orchestrator at the
// end of every investigation — one FICHA per persisted Opportunity. The
// `chismoso_get_ficha` MCP tool is the authoritative way to retrieve one;
// the resources here are a convenience for MCP clients that prefer to
// read by URI rather than call a tool.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readLatestFicha(_deps: ChismosoMCPServerDeps): Promise<any> {
  const latest = getLatestFichaOnDisk();
  if (!latest) {
    return {
      found: false,
      message: 'No FICHA files have been generated yet. Run an investigation first.',
    };
  }
  return readFichaFromDisk(latest);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readFichaById(_deps: ChismosoMCPServerDeps, id: string): Promise<any> {
  // Path traversal protection — same belt-and-braces approach as the API.
  if (!id || !/^[\w-]+$/.test(id)) {
    return { found: false, id, error: 'Invalid opportunity_id (allowed: [A-Za-z0-9_-]+)' };
  }
  const safeId = path.basename(id);
  const fichasDir = '/home/z/my-project/download/chismoso/fichas';
  const fichaPath = path.join(fichasDir, `ficha-${safeId}.md`);
  const resolved = path.resolve(fichaPath);
  if (!resolved.startsWith(path.resolve(fichasDir) + path.sep)) {
    return { found: false, id, error: 'Path traversal detected' };
  }
  try {
    const markdown = readFileSync(fichaPath, 'utf8');
    const parsed = parseFichaMarkdown(markdown);
    return {
      found: true,
      id: safeId,
      fichaPath,
      markdown,
      parsed,
    };
  } catch {
    return {
      found: false,
      id,
      fichaPath,
      message:
        'No FICHA has been generated for this opportunity_id. ' +
        'Run `chismoso fichas regenerate <opportunity_id>` or re-run an investigation.',
    };
  }
}

/**
 * Build the JSON-serialisable response for a FichaListItem already
 * discovered by `listFichasOnDisk`. Re-reads the markdown so the
 * returned object carries both the verbatim text and a parsed view
 * (title, one-liner, evidence block, truth_level).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readFichaFromDisk(item: FichaListItem): any {
  const markdown = readFileSync(item.fichaPath, 'utf8');
  const parsed = parseFichaMarkdown(markdown);
  return {
    found: true,
    id: item.id,
    title: item.title,
    oneLiner: item.oneLiner,
    fichaPath: item.fichaPath,
    markdown,
    parsed,
    generatedAt: item.generatedAt,
    sizeBytes: item.sizeBytes,
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
