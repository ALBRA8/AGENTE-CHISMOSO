/**
 * Unit tests — ReAct Orchestrator (improvement #3)
 *
 * Smoke tests that verify:
 *   - The ReActOrchestrator can be constructed without side effects.
 *   - investigate() returns the same shape as Orchestrator.InvestigateResult
 *     (drop-in replacement contract).
 *   - The LLM's decision-parsing logic is exercised via stubbed LLM responses.
 *
 * No real LLM calls / no network — the LLM is stubbed to return canned JSON
 * plans + decisions, and the ToolRegistry is stubbed to return empty results
 * without invoking any providers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChismosoDB } from '../src/db.js';
import { Repositories } from '../src/repositories.js';
import { ReActOrchestrator, type ReActDecision } from '../src/orchestrator/react.js';
import type {
  OrchestratorConfig,
  InvestigateInput,
} from '../src/orchestrator/orchestrator.js';
import type { ToolRegistry, ToolDefinition, ToolContext } from '../src/orchestrator/tools.js';
import type { ProviderRegistry } from '../src/providers/base.js';
import { LLMClient } from '../src/orchestrator/llm.js';
import type { ChatMessage, LLMResponse } from '../src/orchestrator/llm.js';
import { InvestigationStatus, DEFAULT_BUDGET } from '../src/models.js';
import { logger, LogLevel } from '../src/logger.js';

logger.setLevel(LogLevel.ERROR);

// ---------------------------------------------------------------------------
// STUBS
// ---------------------------------------------------------------------------

/**
 * Stub LLM that picks a canned response based on which system prompt it sees.
 * Extends the real LLMClient so it satisfies the `LLMClient` type without
 * dragging in the ZAI SDK. Overrides `chat()` to return canned JSON without
 * any network calls.
 */
class StubLLM extends LLMClient {
  calls = 0;
  plannerResponse: string;
  decisionQueue: string[];

  constructor(plannerResponse: string, decisions: string[]) {
    super();
    this.plannerResponse = plannerResponse;
    this.decisionQueue = [...decisions];
  }

  override async chat(messages: ChatMessage[], _opts?: { thinking?: boolean }): Promise<LLMResponse> {
    this.calls++;
    const sys = (messages[0]?.content ?? '') as string;
    if (sys.includes('Research Planner')) {
      return { content: this.plannerResponse, raw: null, durationMs: 1 };
    }
    const next = this.decisionQueue.shift();
    if (next === undefined) {
      return { content: '{"action":"stop","reason":"no more stub decisions"}', raw: null, durationMs: 1 };
    }
    return { content: next, raw: null, durationMs: 1 };
  }
}

/** A stub tool that records the args it was called with and returns empty results. */
function mkStubTool(name: string): ToolDefinition<any, any> {
  return {
    id: `chismoso.tool.${name}.stub.v1`,
    name,
    description: `stub tool ${name}`,
    purpose: `Stub for ${name} in tests.`,
    category: ['READ', 'EXTERNAL'],
    permissions: {
      categories: ['READ', 'EXTERNAL'],
      allowedInModes: ['sync', 'react', 'autonomous'],
    },
    risk: 'low',
    side_effects: 'persist',
    timeout_ms: 10_000,
    retry_policy: {
      maxRetries: 0,
      baseDelayMs: 0,
      backoffMultiplier: 1,
      retryableErrors: [],
    },
    evidence_behavior: 'produces',
    audit_behavior: 'logged',
    provider: name,
    async execute(_args: any, _ctx: ToolContext) {
      return {
        providerName: name,
        itemCount: 0,
        signalsStored: 0,
        evidenceStored: 0,
        durationMs: 1,
      };
    },
  };
}

function mkStubToolRegistry(): ToolRegistry {
  const map = new Map<string, ToolDefinition<any, any>>([
    ['search_web', mkStubTool('web_search')],
    ['search_community', mkStubTool('reddit_communities')],
    ['deepen_content', mkStubTool('web_content')],
    ['collect_trends', mkStubTool('google_trends')],
  ]);
  return {
    get: (name: string) => map.get(name),
    list: () => Array.from(map.values()),
    describe: () => [],
    register: () => {},
  } as unknown as ToolRegistry;
}

// ---------------------------------------------------------------------------
// FIXTURES
// ---------------------------------------------------------------------------

const PLAN_JSON = JSON.stringify({
  scope: 'test investigation',
  geography: 'Colombia',
  topics: ['restaurant-automation', 'whatsapp-reservations'],
  queries: [
    { providerName: 'web_search', query: 'restaurant automation Colombia', rationale: 'r1' },
    { providerName: 'reddit_communities', query: 'restaurantes automatización whatsapp site:reddit.com', rationale: 'r2' },
  ],
  iterations: 1,
});

const STOP_DECISION = JSON.stringify({
  action: 'stop',
  reason: 'enough evidence for testing',
});

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

describe('ReActOrchestrator', () => {
  let db: ChismosoDB;
  let repos: Repositories;

  beforeEach(() => {
    db = new ChismosoDB({ path: ':memory:' });
    repos = new Repositories(db);
  });

  afterEach(() => {
    db.close();
  });

  function mkOrchestrator(
    decisions: string[] = [STOP_DECISION],
    budgetOverride?: Partial<{ maxIterations: number; maxQueries: number; maxRuntimeMs: number; maxProviderCalls: number }>,
  ): {
    orchestrator: ReActOrchestrator;
    llm: StubLLM;
  } {
    const llm = new StubLLM(PLAN_JSON, decisions);
    const cfg: OrchestratorConfig = {
      db,
      repositories: repos,
      providerRegistry: {} as unknown as ProviderRegistry,
      toolRegistry: mkStubToolRegistry(),
      llm,
      budget: {
        maxIterations: 2,
        maxQueries: 4,
        maxSources: 3,
        maxResults: 30,
        maxRuntimeMs: 60_000,
        maxProviderCalls: 5,
        ...budgetOverride,
      },
    };
    return { orchestrator: new ReActOrchestrator(cfg), llm };
  }

  it('constructs without throwing', () => {
    const { orchestrator } = mkOrchestrator();
    expect(orchestrator).toBeDefined();
    expect(typeof orchestrator.investigate).toBe('function');
  });

  it('investigate() returns the same shape as Orchestrator.InvestigateResult', async () => {
    const { orchestrator } = mkOrchestrator();
    const input: InvestigateInput = {
      objective: 'test objective',
      geography: 'Colombia',
    };
    const result = await orchestrator.investigate(input);

    // InvestigateResult contract — all keys must be present.
    expect(result).toHaveProperty('investigation');
    expect(result).toHaveProperty('signals');
    expect(result).toHaveProperty('evidence');
    expect(result).toHaveProperty('trends');
    expect(result).toHaveProperty('problems');
    expect(result).toHaveProperty('opportunities');
    expect(result).toHaveProperty('report');

    expect(Array.isArray(result.signals)).toBe(true);
    expect(Array.isArray(result.evidence)).toBe(true);
    expect(Array.isArray(result.trends)).toBe(true);
    expect(Array.isArray(result.problems)).toBe(true);
    expect(Array.isArray(result.opportunities)).toBe(true);

    // Investigation object sanity.
    expect(result.investigation.id).toMatch(/^inv_/);
    expect(result.investigation.query).toBe('test objective');
    expect(result.investigation.scope).toBe('Colombia');
    expect(result.investigation.iterations).toBeGreaterThanOrEqual(1);
    expect(result.investigation.budget).toBeDefined();
    expect(result.investigation.startedAt).toBeTruthy();

    // The ReAct loop appends an `errors` entry per iteration that records the
    // decision + reason. So even on a stop-only run, errors has at least 1 entry.
    expect(Array.isArray(result.investigation.errors)).toBe(true);
    expect(result.investigation.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.investigation.errors.some((e) => e.includes('react_iter_'))).toBe(true);

    // Report shape.
    expect(result.report).toBeDefined();
    expect(result.report.markdown).toBeDefined();
    expect(result.report.machine).toBeDefined();
  });

  it('stops immediately when the LLM returns {"action":"stop"} on the first evaluate', async () => {
    const { orchestrator, llm } = mkOrchestrator([STOP_DECISION]);
    await orchestrator.investigate({ objective: 'x', geography: 'g' });
    // 1 planner call + 1 evaluator call (the stop decision).
    expect(llm.calls).toBe(2);
  });

  it('forces stop if the LLM returns invalid JSON for evaluate', async () => {
    const { orchestrator, llm } = mkOrchestrator(['not valid json {']);
    const result = await orchestrator.investigate({ objective: 'x', geography: 'g' });
    // 1 planner + 1 evaluator (which returns invalid → forced stop).
    expect(llm.calls).toBe(2);
    expect(result.investigation.errors.some((e) => e.includes('react_iter_'))).toBe(true);
  });

  it('respects the budget (maxIterations=1 forces stop after 1 iteration)', async () => {
    // Provide an aggressive search_more decision — orchestrator should NOT
    // execute a second iteration because maxIterations=1.
    const searchMore: ReActDecision = {
      action: 'search_more',
      reason: 'need more',
      queries: [{ providerName: 'web_search', query: 'fresh query' }],
    };
    const { orchestrator, llm } = mkOrchestrator(
      [JSON.stringify(searchMore)],
      { maxIterations: 1 },
    );
    const result = await orchestrator.investigate({ objective: 'x', geography: 'g' });
    // Only 1 iteration ran; the loop broke due to maxIterations before
    // evaluateDecision was called.
    expect(result.investigation.iterations).toBe(1);
    expect(llm.calls).toBe(1);
    expect(result.investigation.errors.some((e) => e.includes('max_iterations_reached'))).toBe(true);
  });

  it('records failed investigation status when the planner throws', async () => {
    // Stub LLM that throws on the planner call.
    const failingLlm = new StubLLM(PLAN_JSON, [STOP_DECISION]);
    failingLlm.chat = async () => {
      throw new Error('LLM down');
    };
    const cfg: OrchestratorConfig = {
      db,
      repositories: repos,
      providerRegistry: {} as unknown as ProviderRegistry,
      toolRegistry: mkStubToolRegistry(),
      llm: failingLlm,
      budget: { ...DEFAULT_BUDGET, maxIterations: 1, maxQueries: 2 },
    };
    const orchestrator = new ReActOrchestrator(cfg);
    await expect(orchestrator.investigate({ objective: 'x' })).rejects.toThrow(/LLM/);
    // The failed investigation is still persisted.
    const investigations = db.prepare('SELECT id, status, errors_json FROM investigations').all() as any[];
    expect(investigations.length).toBe(1);
    expect(investigations[0].status).toBe(InvestigationStatus.FAILED);
  });

  it('uses default budget when cfg.budget is omitted', () => {
    const llm = new StubLLM(PLAN_JSON, [STOP_DECISION]);
    const cfg: OrchestratorConfig = {
      db,
      repositories: repos,
      providerRegistry: {} as unknown as ProviderRegistry,
      toolRegistry: mkStubToolRegistry(),
      llm,
      // No budget override.
    };
    const orchestrator = new ReActOrchestrator(cfg);
    expect(orchestrator).toBeDefined();
    // Smoke: budget defaults exist on DEFAULT_BUDGET.
    expect(DEFAULT_BUDGET.maxIterations).toBeGreaterThan(0);
    expect(DEFAULT_BUDGET.maxQueries).toBeGreaterThan(0);
    expect(DEFAULT_BUDGET.maxRuntimeMs).toBeGreaterThan(0);
  });
});
