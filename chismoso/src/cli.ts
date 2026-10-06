#!/usr/bin/env node
/**
 * CHISMOSO V1.0 — CLI interface (sección 40)
 *
 * La interfaz NO es el cerebro. Separa INTERFACE → ORCHESTRATOR → CAPABILITIES.
 *
 * Commands:
 *   chismoso investigate "<objective>" [--geography=...] [--max-queries=N]
 *   chismoso history [--topic=...]
 *   chismoso providers
 *   chismoso show <investigationId>
 *   chismoso watch [--init] [--interval=Ms] [--topic="..."]
 *   chismoso mesh <subcommand> [--agent=...] [--url=...] [--secret=...] [...]
 *   chismoso anomalies [--topic=...] [--watch] [--interval=Ms]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ChismosoDB } from './db.js';
import { Repositories } from './repositories.js';
import { createDefaultProviderRegistry } from './providers/index.js';
import { createDefaultToolRegistry, LLMClient, Orchestrator, ReActOrchestrator } from './orchestrator/index.js';
import { logger, setLogLevel, LogLevel } from './logger.js';
import { resolveConfig, resolveOutputPath } from './config/index.js';
import { generateId } from './models.js';
import {
  TopicScheduler,
  loadWatchConfig,
  saveDefaultWatchConfig,
  fileAppendedLogger,
  DEFAULT_WATCH_PATH,
} from './scheduler/index.js';
import { AgentMesh } from './mesh/index.js';
import { autoPublishOpportunities } from './mesh/auto-publish.js';
import { AnomalyDetector } from './anomaly/index.js';
import {
  loadMCPConfig,
  saveMCPConfig,
  addServer as mcpAddServer,
  removeServer as mcpRemoveServer,
  writeDefaultConfig as writeDefaultMCPConfig,
  type MCPServerConfig,
  type MCPConfig,
} from './mesh/mcp-config.js';
import { mcpRegistry } from './mcp/registry.js';
import { registerMCPTools } from './mcp/bridge.js';
import {
  createChismosoMCPServer,
  startStdioServer,
  redirectConsoleToStderr,
} from './mcp/server.js';

const SCHEDULER_LOG_PATH = '/home/z/my-project/chismoso/data/scheduler.log';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? 'help';

  const cfg = resolveConfig();
  setLogLevel(LogLevel[cfg.logLevel as keyof typeof LogLevel] ?? LogLevel.INFO);

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }

  if (cmd === 'providers') {
    const reg = createDefaultProviderRegistry();
    const healths = await reg.allHealth();
    console.log(JSON.stringify({ providers: reg.list().map((p) => ({ ...p.capabilities(), health: healths[p.capabilities().name] })) }, null, 2));
    return;
  }

  if (cmd === 'history') {
    const topicArg = argValue(args, '--topic');
    const db = new ChismosoDB({ path: cfg.dbPath });
    const repos = new Repositories(db);
    if (topicArg) {
      const history = repos.topics.getHistory(topicArg, 50);
      console.log(JSON.stringify({ topic: topicArg, history }, null, 2));
    } else {
      const trends = repos.trends.latest(20);
      console.log(JSON.stringify({ latestTrends: trends.map((t) => ({ id: t.id, topic: t.topic, state: t.state, score: t.score, lastSeen: t.lastSeen })) }, null, 2));
    }
    db.close();
    return;
  }

  if (cmd === 'show') {
    const id = args[1];
    if (!id) {
      console.error('Missing investigation id');
      process.exit(2);
    }
    const db = new ChismosoDB({ path: cfg.dbPath });
    const repos = new Repositories(db);
    const inv = repos.investigations.get(id);
    if (!inv) {
      console.error(`Investigation ${id} not found`);
      process.exit(3);
    }
    const trends = repos.trends.findByInvestigation(id);
    const opportunities = repos.opportunities.findByInvestigation(id);
    const problems = repos.problems.findByInvestigation(id);
    const signals = repos.signals.findByInvestigation(id);
    const evidence = repos.evidence.findByInvestigation(id);
    console.log(JSON.stringify({ investigation: inv, trends, problems, opportunities, signalsCount: signals.length, evidenceCount: evidence.length }, null, 2));
    db.close();
    return;
  }

  if (cmd === 'investigate-react') {
    const objective = args[1];
    if (!objective) {
      console.error('Missing objective. Usage: chismoso investigate-react "<objective>"');
      process.exit(2);
    }
    const geography = argValue(args, '--geography') ?? cfg.defaultGeography;
    const maxQueries = argInt(args, '--max-queries');
    const maxRuntimeMs = argInt(args, '--max-runtime-ms');
    const saveReports = args.includes('--save');
    const skipMCP = args.includes('--no-mcp');

    const db = new ChismosoDB({ path: cfg.dbPath });
    const repos = new Repositories(db);
    const providerRegistry = createDefaultProviderRegistry();
    const toolRegistry = createDefaultToolRegistry();
    if (!skipMCP) {
      await autoConnectMCP(toolRegistry);
    }
    const llm = new LLMClient();
    const orchestrator = new ReActOrchestrator({
      db,
      repositories: repos,
      providerRegistry,
      toolRegistry,
      llm,
      budget: { maxQueries, maxRuntimeMs },
    });

    console.error(`[chismoso] Starting ReAct investigation: "${objective}" (geography: ${geography})`);
    const t0 = Date.now();
    let result;
    try {
      result = await orchestrator.investigate({ objective, geography });
    } catch (e: any) {
      console.error(`[chismoso] FATAL during ReAct investigation: ${e?.message ?? e}`);
      db.close();
      process.exit(1);
    }
    console.error(`[chismoso] ReAct completed in ${Date.now() - t0}ms — status: ${result.investigation.status}`);
    console.error(`[chismoso] iterations: ${result.investigation.iterations}  signals: ${result.signals.length}  trends: ${result.trends.length}  problems: ${result.problems.length}  opportunities: ${result.opportunities.length}`);
    // Surface the react iteration log entries (they live in investigation.errors).
    const reactLog = result.investigation.errors.filter((e) => e.startsWith('react_iter_'));
    if (reactLog.length > 0) {
      console.error(`[chismoso] ReAct iterations (${reactLog.length}):`);
      for (const line of reactLog) console.error(`  ${line}`);
    }

    if (saveReports) {
      mkdirSync(cfg.outputDir, { recursive: true });
      const id = result.investigation.id;
      writeFileSync(resolveOutputPath(cfg, `report-${id}.md`), result.report.markdown);
      writeFileSync(resolveOutputPath(cfg, `report-${id}.json`), JSON.stringify(result.report.machine, null, 2));
      console.error(`[chismoso] Reports saved to ${cfg.outputDir}/report-${id}.{md,json}`);
    }

    console.log(result.report.markdown);
    db.close();
    // Exit explicitly to avoid better-sqlite3 native destructor crash at exit.
    process.exit(0);
    return;
  }

  if (cmd === 'investigate') {
    const objective = args[1];
    if (!objective) {
      console.error('Missing objective. Usage: chismoso investigate "<objective>"');
      process.exit(2);
    }
    const geography = argValue(args, '--geography') ?? cfg.defaultGeography;
    const maxQueries = argInt(args, '--max-queries');
    const maxRuntimeMs = argInt(args, '--max-runtime-ms');
    const saveReports = args.includes('--save');
    const skipMCP = args.includes('--no-mcp');

    const db = new ChismosoDB({ path: cfg.dbPath });
    const repos = new Repositories(db);
    const providerRegistry = createDefaultProviderRegistry();
    const toolRegistry = createDefaultToolRegistry();
    if (!skipMCP) {
      await autoConnectMCP(toolRegistry);
    }
    const llm = new LLMClient();
    const orchestrator = new Orchestrator({
      db,
      repositories: repos,
      providerRegistry,
      toolRegistry,
      llm,
      budget: { maxQueries, maxRuntimeMs },
    });

    console.error(`[chismoso] Starting investigation: "${objective}" (geography: ${geography})`);
    const t0 = Date.now();
    let result;
    try {
      result = await orchestrator.investigate({ objective, geography });
    } catch (e: any) {
      console.error(`[chismoso] FATAL during investigation: ${e?.message ?? e}`);
      db.close();
      process.exit(1);
    }
    console.error(`[chismoso] Completed in ${Date.now() - t0}ms — status: ${result.investigation.status}`);
    console.error(`[chismoso] signals: ${result.signals.length}  trends: ${result.trends.length}  problems: ${result.problems.length}  opportunities: ${result.opportunities.length}`);

    // Auto-publish opportunities to the agent mesh (if enabled).
    let mesh: AgentMesh | null = null;
    try {
      mesh = new AgentMesh(cfg.dbPath);
      const published = await autoPublishOpportunities(repos, mesh, result.investigation.id);
      if (published > 0) {
        console.error(`[chismoso] Published ${published} opportunities to mesh outbox`);
      }
    } catch (e: any) {
      console.error(`[chismoso] Mesh auto-publish failed: ${e?.message ?? e}`);
    } finally {
      if (mesh) mesh.close();
    }

    if (saveReports) {
      mkdirSync(cfg.outputDir, { recursive: true });
      const id = result.investigation.id;
      writeFileSync(resolveOutputPath(cfg, `report-${id}.md`), result.report.markdown);
      writeFileSync(resolveOutputPath(cfg, `report-${id}.json`), JSON.stringify(result.report.machine, null, 2));
      console.error(`[chismoso] Reports saved to ${cfg.outputDir}/report-${id}.{md,json}`);
    }

    console.log(result.report.markdown);
    db.close();
    // Exit explicitly to avoid better-sqlite3 native destructor crash at exit.
    process.exit(0);
    return;
  }

  if (cmd === 'demo') {
    // Mini self-check: crea una investigation de prueba usando el objetivo
    // canónico de la especificación (sección 58).
    const objective = 'Investiga qué tendencias y problemas emergentes podrían generar oportunidades de negocio para automatización de pequeños restaurantes en Colombia.';
    const db = new ChismosoDB({ path: cfg.dbPath });
    const repos = new Repositories(db);
    const providerRegistry = createDefaultProviderRegistry();
    const toolRegistry = createDefaultToolRegistry();
    // Demo always skips MCP auto-connect — keep the canonical demo deterministic.
    const llm = new LLMClient();
    const orchestrator = new Orchestrator({
      db,
      repositories: repos,
      providerRegistry,
      toolRegistry,
      llm,
      budget: { maxQueries: 4, maxProviderCalls: 4 },
    });
    console.error(`[chismoso] DEMO investigation: "${objective}"`);
    const t0 = Date.now();
    const result = await orchestrator.investigate({ objective, geography: 'Colombia' });
    console.error(`[chismoso] Demo completed in ${Date.now() - t0}ms — status: ${result.investigation.status}`);
    mkdirSync(cfg.outputDir, { recursive: true });
    const id = result.investigation.id;
    writeFileSync(resolveOutputPath(cfg, `demo-report-${id}.md`), result.report.markdown);
    writeFileSync(resolveOutputPath(cfg, `demo-report-${id}.json`), JSON.stringify(result.report.machine, null, 2));
    console.log(result.report.markdown);
    db.close();
    process.exit(0);
    return;
  }

  if (cmd === 'watch') {
    return runWatchCommand(args, cfg);
  }

  if (cmd === 'mesh') {
    return runMeshCommand(args, cfg);
  }

  if (cmd === 'anomalies') {
    return runAnomaliesCommand(args, cfg);
  }

  if (cmd === 'mcp') {
    return runMCPCommand(args, cfg);
  }

  console.error(`Unknown command: ${cmd}`);
  printHelp();
  process.exit(2);
}

function argValue(args: string[], flag: string): string | undefined {
  // Soporta --flag=value y --flag value
  for (const a of args) {
    if (a === flag) {
      const idx = args.indexOf(a);
      return args[idx + 1];
    }
    if (a.startsWith(`${flag}=`)) {
      return a.slice(flag.length + 1);
    }
  }
  return undefined;
}

function argInt(args: string[], flag: string): number | undefined {
  const v = argValue(args, flag);
  if (!v) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Connects to every enabled MCP server in the chismoso mesh config and
 * registers their tools with the given tool registry.
 *
 * Best-effort: failures are logged to stderr but never thrown — a broken
 * remote MCP server must not abort the parent investigation. The same
 * registry is shared across the process, so calling this repeatedly (e.g.
 * from the scheduler tick) only re-connects to servers that have actually
 * been added since the last call.
 */
async function autoConnectMCP(toolRegistry: { register: (t: any) => void }): Promise<void> {
  try {
    const result = await mcpRegistry.connectAll();
    if (result.connected.length > 0) {
      const count = registerMCPTools(toolRegistry);
      console.error(
        `[chismoso] Connected to MCP servers: ${result.connected.join(', ')}` +
        ` (${count} tools registered)`,
      );
    }
    if (result.failed.length > 0) {
      console.error(
        `[chismoso] MCP auto-connect failures: ` +
        result.failed.map((f) => `${f.name}=${f.error}`).join('; '),
      );
    }
  } catch (e: any) {
    console.error(`[chismoso] MCP auto-connect failed: ${e?.message ?? e}`);
  }
}

function printHelp(): void {
  console.log(`
CHISMOSO V1.0 — Agente de inteligencia de señales, tendencias, problemas y oportunidades

Usage:
  chismoso investigate "<objective>" [--geography=...] [--max-queries=N] [--save]
                                                  Run with the fixed-plan Orchestrator
  chismoso investigate-react "<objective>" [--geography=...] [--max-queries=N] [--save]
                                                  Run with the ReAct agentic loop (LLM-driven)
  chismoso demo                                   Run the canonical demo objective
  chismoso providers                              List providers and their health
  chismoso history [--topic=<topic>]              Show trend history
  chismoso show <investigationId>                 Show a stored investigation
  chismoso watch [--init] [--interval=Ms] [--topic="..."]  Continuously re-investigate a watch list
  chismoso mesh <subcommand>                      Multi-agent mesh operations
  chismoso anomalies [--topic=...] [--watch] [--interval=Ms]  Detect statistical anomalies
  chismoso mcp <subcommand>                       MCP server operations (serve, ...)

Anomaly subcommands:
  chismoso anomalies                       Detect across all topics, print JSON, exit
  chismoso anomalies --topic=<name>        Detect for a single topic only
  chismoso anomalies --watch                Poll continuously, print only NEW anomalies
  chismoso anomalies --watch --interval=300000  Poll every 5 minutes (ms)

Mesh subcommands:
  chismoso mesh status                                   Show outbox/external_signals counts
  chismoso mesh publish --opportunity-id=<id>            Manually publish an opportunity
  chismoso mesh deliver                                  Deliver pending events to subscribers
  chismoso mesh subscribe --agent=NAME --url=URL [--secret=XXX]
                                                         Register/update a webhook subscriber
  chismoso mesh list --pending --agent=NAME [--limit=N]  List pending events for an agent
  chismoso mesh signals [--limit=N]                      List recent external signals
  chismoso mesh config                                   Show current mesh config (JSON)
  chismoso mesh enable                                   Enable the mesh (auto-publish on investigate)
  chismoso mesh disable                                  Disable the mesh

MCP subcommands:
  chismoso mcp serve                        Start the CHISMOSO MCP server (stdio)
                                            (Claude Desktop / Cursor / Continue.dev / Cline)
  chismoso mcp serve --transport=stdio     Explicit stdio transport (default)
  chismoso mcp serve --inspect             Print tools/resources/prompts to stderr
                                            before starting the JSON-RPC loop
  chismoso mcp list-servers                List configured external MCP servers
  chismoso mcp add <name> --command=... --args=... [--env=K:V,...] [--enabled]
                                            Add an external MCP server to the config
  chismoso mcp remove <name>              Remove a server from the config
  chismoso mcp connect <name>             Connect now to a configured server
  chismoso mcp disconnect <name>          Disconnect and mark disabled
  chismoso mcp tools                       List tools from all connected servers
  chismoso mcp call <server.tool> <json>  Call a tool on a connected server

Environment:
  CHISMOSO_DB_PATH          SQLite path (default: data/chismoso.db)
  CHISMOSO_LOG_LEVEL        DEBUG | INFO | WARN | ERROR
  CHISMOSO_GEOGRAPHY        Default geography (default: global)
  CHISMOSO_OUTPUT_DIR       Where to save reports (default: /home/z/my-project/download/chismoso)
  CHISMOSO_WATCH_CONFIG     Watch config JSON path (default: data/watch.json)
`);
}

/**
 * `chismoso watch` — starts the continuous scheduler.
 *
 * Flags:
 *   --init                 Create data/watch.json with defaults if missing (then exits)
 *   --interval=Ms          Override intervalMs (milliseconds)
 *   --topic="..."          Add an ad-hoc topic (additive, can repeat)
 *
 * The config file is loaded (or created) first; flag overrides are then
 * applied in-memory (NOT persisted back to the file). SIGINT stops gracefully.
 */
async function runWatchCommand(args: string[], cfg: ReturnType<typeof resolveConfig>): Promise<void> {
  const watchPath = process.env.CHISMOSO_WATCH_CONFIG ?? DEFAULT_WATCH_PATH;

  // --init: create default config file if missing, then exit.
  const initOnly = args.includes('--init');
  if (initOnly) {
    const existed = existsSync(watchPath);
    saveDefaultWatchConfig(watchPath, false);
    if (existed) {
      console.log(`[chismoso] Watch config already exists at ${watchPath} — leaving untouched.`);
    } else {
      console.log(`[chismoso] Created default watch config at ${watchPath}.`);
    }
    return;
  }

  // Load (or create) config.
  if (!existsSync(watchPath)) {
    saveDefaultWatchConfig(watchPath, false);
    console.error(`[chismoso] Created default watch config at ${watchPath}.`);
  }
  const watchConfig = loadWatchConfig(watchPath);

  // Apply --interval override (milliseconds).
  const intervalArg = argInt(args, '--interval');
  if (intervalArg && intervalArg > 0) {
    watchConfig.intervalMs = intervalArg;
  }

  // Apply --topic overrides (additive — may be repeated; can override default topics).
  const adHocTopics: string[] = [];
  for (const a of args) {
    if (a.startsWith('--topic=')) {
      const v = a.slice('--topic='.length);
      if (v.length > 0) adHocTopics.push(v);
    }
  }
  if (adHocTopics.length > 0) {
    // If user passes ad-hoc topics, REPLACE the configured list (more intuitive
    // than appending) — they can always edit data/watch.json to add more.
    watchConfig.topics = adHocTopics;
  }

  if (watchConfig.topics.length === 0) {
    console.error('[chismoso] Watch config has no topics. Aborting.');
    process.exit(2);
  }

  // Instantiate Orchestrator exactly the way `investigate` does.
  const db = new ChismosoDB({ path: cfg.dbPath });
  const repos = new Repositories(db);
  const providerRegistry = createDefaultProviderRegistry();
  const toolRegistry = createDefaultToolRegistry();
  const skipMCP = args.includes('--no-mcp');
  if (!skipMCP) {
    await autoConnectMCP(toolRegistry);
  }
  const llm = new LLMClient();
  const orchestrator = new Orchestrator({
    db,
    repositories: repos,
    providerRegistry,
    toolRegistry,
    llm,
    budget: { maxQueries: watchConfig.maxQueries },
  });

  const schedulerLog = fileAppendedLogger(SCHEDULER_LOG_PATH, logger);
  const scheduler = new TopicScheduler({
    config: watchConfig,
    orchestrator,
    logger: schedulerLog,
  });

  const minutes = Math.round(watchConfig.intervalMs / 60000);
  console.log(
    `[chismoso] Watching ${watchConfig.topics.length} topics every ${minutes} minutes. ` +
    `Geography: ${watchConfig.geography}. Press Ctrl+C to stop.`,
  );
  console.log(`[chismoso] Topics:`);
  for (const t of watchConfig.topics) console.log(`  - ${t}`);
  console.log(`[chismoso] Scheduler log: ${SCHEDULER_LOG_PATH}`);
  schedulerLog.info('Watch command started', {
    topics: watchConfig.topics,
    intervalMs: watchConfig.intervalMs,
    geography: watchConfig.geography,
    maxQueries: watchConfig.maxQueries,
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[chismoso] Received ${signal}, stopping scheduler...`);
    schedulerLog.info('Watch command stopping', { signal });
    scheduler.stop();
    setTimeout(() => {
      try { db.close(); } catch { /* ignore */ }
      process.exit(0);
    }, 500);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  scheduler.start();
}

/**
 * `chismoso mesh <subcommand>` — multi-agent mesh operations.
 *
 * Subcommands:
 *   status                              Show outbox/external_signals counts
 *   publish --opportunity-id=<id>      Manually publish an opportunity
 *   deliver                             Deliver pending events to subscribers
 *   subscribe --agent=NAME --url=URL [--secret=XXX]
 *   list --pending --agent=NAME [--limit=N]
 *   signals [--limit=N]                 List recent external signals
 *   config                              Show current mesh config (JSON)
 *   enable                              Enable mesh auto-publish on investigate
 *   disable                             Disable mesh
 */
async function runMeshCommand(args: string[], cfg: ReturnType<typeof resolveConfig>): Promise<void> {
  const sub = args[1] ?? 'status';
  const mesh = new AgentMesh(cfg.dbPath);
  try {
    if (sub === 'status') {
      const s = mesh.status();
      console.log(JSON.stringify(s, null, 2));
      return;
    }

    if (sub === 'publish') {
      const oppId = argValue(args, '--opportunity-id');
      if (!oppId) {
        console.error('Missing --opportunity-id. Usage: chismoso mesh publish --opportunity-id=<id>');
        process.exit(2);
      }
      const db = new ChismosoDB({ path: cfg.dbPath });
      try {
        // Find the opportunity across all investigations.
        const rows = db.prepare('SELECT * FROM opportunities WHERE id = ?').all(oppId) as any[];
        if (rows.length === 0) {
          console.error(`Opportunity ${oppId} not found.`);
          process.exit(3);
        }
        const r = rows[0];
        const opp = {
          id: r.id,
          title: r.title,
          description: r.description,
          problem: r.problem,
          problemRef: r.problem_ref ?? undefined,
          targetSegment: r.target_segment,
          geography: r.geography,
          evidence: r.evidence_json ? JSON.parse(r.evidence_json) : [],
          trendRef: r.trend_ref ?? undefined,
          demand: r.demand,
          growth: r.growth,
          problemSeverity: r.problem_severity,
          monetization: r.monetization,
          timing: r.timing,
          marketFit: r.market_fit,
          competition: r.competition,
          uncertainty: r.uncertainty,
          score: r.score,
          scoreBreakdown: r.score_breakdown_json ? JSON.parse(r.score_breakdown_json) : {},
          confidence: r.confidence,
          suggestedNextAgent: r.suggested_next_agent || 'AGENTE-LEADS',
          createdAt: r.created_at,
        };
        const evtId = mesh.publishOpportunity(opp as any);
        console.log(JSON.stringify({ ok: true, eventId: evtId, opportunityId: oppId, agentTarget: opp.suggestedNextAgent }, null, 2));
      } finally {
        db.close();
      }
      return;
    }

    if (sub === 'deliver') {
      const stats = await mesh.deliverPending();
      console.log(JSON.stringify(stats, null, 2));
      return;
    }

    if (sub === 'subscribe') {
      const agentName = argValue(args, '--agent');
      const webhookUrl = argValue(args, '--url');
      const secret = argValue(args, '--secret');
      if (!agentName || !webhookUrl) {
        console.error('Missing --agent or --url. Usage: chismoso mesh subscribe --agent=NAME --url=URL [--secret=XXX]');
        process.exit(2);
      }
      mesh.upsertSubscriber({ agentName, webhookUrl, secret });
      console.log(JSON.stringify({ ok: true, agentName, webhookUrl, hasSecret: Boolean(secret) }, null, 2));
      return;
    }

    if (sub === 'list') {
      const pendingOnly = args.includes('--pending');
      const agentName = argValue(args, '--agent');
      const limit = argInt(args, '--limit') ?? 20;
      if (!agentName) {
        console.error('Missing --agent. Usage: chismoso mesh list --pending --agent=NAME');
        process.exit(2);
      }
      if (pendingOnly) {
        const events = mesh.pendingFor(agentName, limit);
        console.log(JSON.stringify({ agent: agentName, count: events.length, events }, null, 2));
      } else {
        console.error('Use --pending to list pending events. (Only pending mode is supported.)');
        process.exit(2);
      }
      return;
    }

    if (sub === 'signals') {
      const limit = argInt(args, '--limit') ?? 20;
      const signals = mesh.listExternalSignals(limit);
      console.log(JSON.stringify({ count: signals.length, signals }, null, 2));
      return;
    }

    if (sub === 'config') {
      const config = mesh.getConfig();
      console.log(JSON.stringify(config, null, 2));
      return;
    }

    if (sub === 'enable') {
      const c = mesh.getConfig();
      mesh.setConfig({ ...c, enabled: true });
      console.log(JSON.stringify({ ok: true, enabled: true }, null, 2));
      return;
    }

    if (sub === 'disable') {
      const c = mesh.getConfig();
      mesh.setConfig({ ...c, enabled: false });
      console.log(JSON.stringify({ ok: true, enabled: false }, null, 2));
      return;
    }

    console.error(`Unknown mesh subcommand: ${sub}`);
    console.error('Try: status, publish, deliver, subscribe, list, signals, config, enable, disable');
    process.exit(2);
  } finally {
    mesh.close();
  }
}

/**
 * `chismoso anomalies` — detect statistical anomalies across the
 * `topic_observations` history and print them as JSON.
 *
 * Flags:
 *   --topic=<name>        Detect only for this single topic.
 *   --watch               Poll continuously, printing only NEW anomalies
 *                         (state stored in data/anomalies.state.json).
 *   --interval=Ms         Polling interval in milliseconds (default 300000 = 5min).
 *
 * Without --watch the command runs once and exits. Without --topic it
 * iterates over every topic that has at least one observation row.
 *
 * Exit codes:
 *   0  — ran successfully (anomalies may or may not have been found)
 *   1  — fatal error during detection
 *   2  — bad flag combination
 */
function runAnomaliesCommand(args: string[], cfg: ReturnType<typeof resolveConfig>): void {
  const topicArg = argValue(args, '--topic');
  const watchMode = args.includes('--watch');
  const intervalMs = argInt(args, '--interval') ?? 5 * 60 * 1000;
  const statePath = '/home/z/my-project/chismoso/data/anomalies.state.json';

  const detectOnce = (): { anomalies: any[]; ranAt: string } => {
    const db = new ChismosoDB({ path: cfg.dbPath });
    const repos = new Repositories(db);
    const detector = new AnomalyDetector(repos);
    const anomalies = topicArg
      ? detector.detectForTopic(topicArg)
      : detector.detectAll();
    db.close();
    return { anomalies, ranAt: new Date().toISOString() };
  };

  if (!watchMode) {
    const { anomalies, ranAt } = detectOnce();
    console.log(JSON.stringify({
      ranAt,
      topic: topicArg ?? null,
      count: anomalies.length,
      anomalies,
    }, null, 2));
    // Explicit exit to avoid better-sqlite3 native destructor crash at exit.
    process.exit(0);
    return;
  }

  // --watch mode: loop forever, printing only anomalies whose observedAt is
  // strictly newer than the newest one we've already shown (state persisted
  // to data/anomalies.state.json so it survives restarts).
  console.error(`[chismoso] Anomaly watch started — polling every ${Math.round(intervalMs / 1000)}s.`);
  console.error(`[chismoso] State file: ${statePath}`);
  console.error('[chismoso] Press Ctrl+C to stop.');

  let lastSeenObservedAt = loadAnomalyState(statePath).lastSeenObservedAt;
  let lastSeenIds = new Set<string>(loadAnomalyState(statePath).lastSeenIds);

  const tick = (): void => {
    let result: { anomalies: any[]; ranAt: string };
    try {
      result = detectOnce();
    } catch (e: any) {
      console.error(`[chismoso] Detection tick failed: ${e?.message ?? e}`);
      return;
    }
    const fresh = result.anomalies.filter((a) => {
      // "Newer than previous run" = observedAt strictly greater than the
      // newest one we've already emitted, OR an id we haven't seen yet.
      if (lastSeenIds.has(a.id)) return false;
      if (lastSeenObservedAt && a.observedAt <= lastSeenObservedAt) return false;
      return true;
    });
    if (fresh.length > 0) {
      for (const a of fresh) lastSeenIds.add(a.id);
      // Bump lastSeenObservedAt to the newest observedAt we've emitted.
      const newest = fresh.reduce((max: string | null, a: any) => {
        if (!max) return a.observedAt;
        return a.observedAt > max ? a.observedAt : max;
      }, null as string | null);
      if (newest && (!lastSeenObservedAt || newest > lastSeenObservedAt)) {
        lastSeenObservedAt = newest;
      }
      // Cap the in-memory ID set so it doesn't grow unbounded over weeks.
      if (lastSeenIds.size > 5000) {
        lastSeenIds = new Set<string>(Array.from(lastSeenIds).slice(-2500));
      }
      saveAnomalyState(statePath, {
        lastSeenObservedAt,
        lastSeenIds: Array.from(lastSeenIds),
        updatedAt: new Date().toISOString(),
      });
      console.log(JSON.stringify({
        ranAt: result.ranAt,
        newCount: fresh.length,
        anomalies: fresh,
      }, null, 2));
    } else {
      // Quietly heartbeat to stderr so the caller knows we're alive.
      console.error(`[chismoso] ${result.ranAt} — no new anomalies (total in DB: ${result.anomalies.length}).`);
    }
  };

  tick();
  const handle = setInterval(tick, intervalMs);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(handle);
    console.error(`[chismoso] Received ${signal}, stopping anomaly watch...`);
    saveAnomalyState(statePath, {
      lastSeenObservedAt,
      lastSeenIds: Array.from(lastSeenIds),
      updatedAt: new Date().toISOString(),
    });
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

interface AnomalyState {
  lastSeenObservedAt: string | null;
  lastSeenIds: string[];
  updatedAt?: string;
}

function loadAnomalyState(pathStr: string): AnomalyState {
  try {
    if (!existsSync(pathStr)) return { lastSeenObservedAt: null, lastSeenIds: [] };
    const raw = readFileSync(pathStr, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      lastSeenObservedAt: parsed.lastSeenObservedAt ?? null,
      lastSeenIds: Array.isArray(parsed.lastSeenIds) ? parsed.lastSeenIds : [],
    };
  } catch {
    return { lastSeenObservedAt: null, lastSeenIds: [] };
  }
}

function saveAnomalyState(pathStr: string, state: AnomalyState): void {
  try {
    mkdirSync(path.dirname(pathStr), { recursive: true });
    writeFileSync(pathStr, JSON.stringify(state, null, 2));
  } catch {
    /* state file is best-effort — never crash the watch loop on it */
  }
}

/**
 * `chismoso mcp <subcommand>` — MCP server operations.
 *
 * Subcommands:
 *   serve [--transport=stdio]   Start the CHISMOSO MCP server over stdio.
 *                              This is the entry point used by Claude Desktop,
 *                              Cursor, Continue.dev, Cline and any MCP client.
 *                              Reads JSON-RPC 2.0 requests from stdin, writes
 *                              responses to stdout. Logs go to stderr.
 *   serve --inspect            Print registered tools/resources/prompts to
 *                              stderr before starting the JSON-RPC loop, so
 *                              operators can verify what's exposed.
 *
 * Future subcommands (not yet implemented):
 *   serve --transport=http     Start an HTTP server (separate task).
 *   serve --transport=sse      Start an SSE server (separate task).
 */
async function runMCPCommand(args: string[], cfg: ReturnType<typeof resolveConfig>): Promise<void> {
  const sub = args[1] ?? 'help';
  const subArgs = args.slice(2);

  if (sub === 'help' || sub === '--help' || sub === '-h') {
    printMCPHelp();
    return;
  }

  // ----- Client-mode subcommands (Task MCP-2) -----
  // CHISMOSO consuming EXTERNAL MCP servers (GitHub, Filesystem, Slack, ...).
  // These do NOT touch the inbound server surface (server.ts/tools.ts/etc).
  if (sub === 'list-servers') return runMCPListServers(subArgs);
  if (sub === 'add') return runMCPAddServer(subArgs);
  if (sub === 'remove') return runMCPRemoveServer(subArgs);
  if (sub === 'connect') return runMCPConnectServer(subArgs);
  if (sub === 'disconnect') return runMCPDisconnectServer(subArgs);
  if (sub === 'tools') return runMCPListTools(subArgs);
  if (sub === 'call') return runMCPCallTool(subArgs);

  // ----- Server-mode subcommand (Task MCP-1) -----
  // CHISMOSO EXPOSING itself as an MCP server to LLM clients (Claude Desktop,
  // Cursor, Continue.dev, Cline). The only command in this group is `serve`.
  if (sub !== 'serve') {
    console.error(`Unknown mcp subcommand: ${sub}`);
    console.error("Try 'chismoso mcp help' for the list of available subcommands.");
    process.exit(2);
  }

  // ----- chismoso mcp serve -----
  const transportFlag = argValue(args, '--transport') ?? 'stdio';
  if (transportFlag !== 'stdio') {
    console.error(
      `Unsupported MCP transport "${transportFlag}". Only "stdio" is implemented in this build.`,
    );
    process.exit(2);
  }

  // CRITICAL: redirect console.log/info/warn to STDERR before any CHISMOSO
  // code runs. The MCP stdio protocol reserves STDOUT for JSON-RPC 2.0
  // messages — even a single stray log line on stdout would corrupt the
  // protocol stream and cause the MCP client to disconnect.
  redirectConsoleToStderr();

  // Construct the deps the server will share across all tool/resource calls.
  const db = new ChismosoDB({ path: cfg.dbPath });
  const repositories = new Repositories(db);
  const providerRegistry = createDefaultProviderRegistry();
  // NOTE: we do NOT auto-connect to OUTBOUND MCP servers here — running an
  // MCP server should not depend on being a client of other MCP servers
  // (would create a recursive spawn at Claude Desktop boot). The inbound
  // server exposes only CHISMOSO's native capabilities.
  const toolRegistry = createDefaultToolRegistry();
  const llm = new LLMClient();

  if (args.includes('--inspect')) {
    const server = createChismosoMCPServer({
      db,
      repositories,
      providerRegistry,
      toolRegistry,
      llm,
    });
    // Touching the server to surface the handlers — we just print the
    // static descriptor tables, since they're what an operator cares about
    // when verifying "what is this server exposing to my LLM client?".
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { CHISMOSO_MCP_TOOLS, CHISMOSO_MCP_RESOURCES, CHISMOSO_MCP_PROMPTS } = await import('./mcp/index.js');
    console.error('[chismoso] MCP server registered tools:');
    for (const t of CHISMOSO_MCP_TOOLS) {
      console.error(`  - ${t.name}: ${t.description.split('\n')[0]}`);
    }
    console.error('[chismoso] MCP server registered resources:');
    for (const r of CHISMOSO_MCP_RESOURCES.resources) {
      console.error(`  - ${r.uri}  (${r.mimeType})  ${r.description}`);
    }
    console.error('[chismoso] MCP server registered resource templates:');
    for (const t of CHISMOSO_MCP_RESOURCES.resourceTemplates) {
      console.error(`  - ${t.uriTemplate}  (${t.mimeType})  ${t.description}`);
    }
    console.error('[chismoso] MCP server registered prompts:');
    for (const p of CHISMOSO_MCP_PROMPTS) {
      console.error(`  - ${p.name}(${p.arguments.map((a) => a.name + (a.required ? '!' : '?')).join(', ')}): ${p.description.split('\n')[0]}`);
    }
    // server is created solely for the inspect branch to surface any
    // initialisation errors early; we then proceed to the real serve path.
    void server;
  }

  // Stdio transport: the JSON-RPC protocol takes over stdin/stdout.
  // All chismoso logs go to stderr by default (logger writes to stderr).
  try {
    await startStdioServer({
      db,
      repositories,
      providerRegistry,
      toolRegistry,
      llm,
    });
  } catch (e: any) {
    console.error(`[chismoso] MCP server failed: ${e?.message ?? e}`);
    try { db.close(); } catch { /* ignore */ }
    process.exit(1);
  }
}

function printMCPHelp(): void {
  console.log(`
CHISMOSO V1.3 — MCP commands

The 'mcp' command has two modes:
  - SERVER mode: 'chismoso mcp serve' exposes CHISMOSO as an MCP server to
    LLM clients (Claude Desktop, Cursor, Continue.dev, Cline). Reads JSON-RPC
    2.0 requests from stdin, writes responses to stdout. Logs go to stderr.
  - CLIENT mode: every other subcommand operates on EXTERNAL MCP servers
    (GitHub, Filesystem, Slack, ...). CHISMOSO connects to them and uses
    their tools as if they were native.

Usage:
  SERVER mode (Task MCP-1):
    chismoso mcp serve                       Start the CHISMOSO MCP server (stdio)
    chismoso mcp serve --transport=stdio    Explicit stdio transport (default)
    chismoso mcp serve --inspect             Print tools/resources/prompts to
                                            stderr before serving JSON-RPC

  CLIENT mode (Task MCP-2):
    chismoso mcp list-servers               List configured MCP servers
    chismoso mcp add <name> [flags]         Add a server to the config file
        --command=<cmd>                      Spawn command (stdio transport)
        --args=<a,b,c>                        Comma-separated spawn args
        --env=K1:V1,K2:V2                     Comma-separated env pairs
        --transport=stdio|http               Transport (default: stdio)
        --url=<URL>                           Required when transport=http
        --enabled                             Auto-connect on investigate
    chismoso mcp remove <name>              Remove a server from the config
    chismoso mcp connect <name>             Connect now to a configured server
    chismoso mcp disconnect <name>          Disconnect and mark disabled
    chismoso mcp tools                       List tools from all connected servers
    chismoso mcp call <server.tool> <json>  Call a tool on a connected server
        Example: chismoso mcp call github.search_repositories '{"query":"next.js"}'

Server mode — connecting from Claude Desktop / Cursor / Continue.dev:
  Configure a stdio MCP server in the host app's settings:

    {
      "mcpServers": {
        "chismoso": {
          "command": "node",
          "args": ["/path/to/chismoso/dist/cli.js", "mcp", "serve"]
        }
      }
    }

Client mode — auto-connect on investigate:
  Any server in the config with 'enabled: true' is auto-connected at the start
  of every 'investigate' / 'investigate-react' / 'watch' command. Its tools
  are registered with the CHISMOSO ToolRegistry and become callable by the
  ReAct loop exactly like the built-in search_web / search_community tools.
  Pass --no-mcp to skip auto-connect (keeps the canonical demo deterministic).

  See docs/MCP.md for the full walkthrough and example configs.
`);
}

// ---------------------------------------------------------------------------
// MCP CLIENT SUBCOMMANDS (Task MCP-2)
// ---------------------------------------------------------------------------
//
// Each handler below operates on the EXTERNAL MCP server config file
// (data/mcp-servers.json by default) or on the in-memory `mcpRegistry`
// singleton (live connections shared with the orchestrator init path).
//
// None of these handlers touch the inbound MCP server surface (server.ts /
// tools.ts / resources.ts / prompts.ts) — that's owned by Task MCP-1.
// ---------------------------------------------------------------------------

/**
 * `chismoso mcp list-servers` — prints every server in the config file,
 * materialising the default config first so users get a template to edit.
 */
async function runMCPListServers(_args: string[]): Promise<void> {
  writeDefaultMCPConfig();
  const config = loadMCPConfig();
  const names = Object.keys(config.servers);
  const connected = new Set(mcpRegistry.listConnected().map((s) => s.name));
  if (names.length === 0) {
    console.log('[chismoso] No MCP servers configured.');
    console.log('[chismoso] Add one with: chismoso mcp add <name> --command=... --args=...');
    return;
  }
  console.log(`[chismoso] ${names.length} MCP server(s) configured:\n`);
  for (const name of names) {
    const s = config.servers[name];
    const state = connected.has(name) ? 'connected' : s.enabled ? 'enabled' : 'disabled';
    console.log(`  - ${name}  [${state}]`);
    console.log(`      transport: ${s.transport}`);
    if (s.transport === 'stdio') {
      console.log(`      command:    ${s.command} ${s.args.join(' ')}`);
    } else {
      console.log(`      url:        ${s.url ?? '(missing)'}`);
    }
    if (s.env && Object.keys(s.env).length > 0) {
      console.log(`      env keys:   ${Object.keys(s.env).join(', ')}`);
    }
  }
}

/**
 * `chismoso mcp add <name> --command=... --args=...` — adds a server to the
 * config file (disabled by default; pass --enabled to auto-connect on investigate).
 */
async function runMCPAddServer(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    console.error('Usage: chismoso mcp add <name> --command=<cmd> --args=<a,b,c> [--env=K:V,...] [--transport=stdio|http] [--url=URL] [--enabled]');
    process.exit(2);
  }
  const command = argValue(args, '--command') ?? '';
  const argsStr = argValue(args, '--args');
  const envStr = argValue(args, '--env');
  const transport = (argValue(args, '--transport') ?? 'stdio') as 'stdio' | 'http';
  const url = argValue(args, '--url');
  const enabled = args.includes('--enabled');

  if (transport === 'stdio' && !command) {
    console.error('[chismoso] stdio transport requires --command=<cmd>');
    process.exit(2);
  }
  if (transport === 'http' && !url) {
    console.error('[chismoso] http transport requires --url=<URL>');
    process.exit(2);
  }

  const serverArgs: string[] = argsStr
    ? argsStr.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    : [];

  // --env=K1:V1,K2:V2 — split on comma, then on FIRST colon only (so values
  // may contain colons, e.g. URLs as values). Empty values are allowed
  // (e.g. --env=DEBUG:).
  const env: Record<string, string> = {};
  if (envStr) {
    for (const pair of envStr.split(',')) {
      const idx = pair.indexOf(':');
      if (idx < 0) continue;
      const key = pair.slice(0, idx).trim();
      const val = pair.slice(idx + 1);
      if (key.length > 0) env[key] = val;
    }
  }

  const config: MCPServerConfig = {
    command,
    args: serverArgs,
    env: Object.keys(env).length > 0 ? env : undefined,
    transport,
    url: transport === 'http' ? url : undefined,
    enabled,
  };

  const updated = mcpAddServer(name, config);
  console.log(`[chismoso] Added MCP server "${name}" (${transport}, enabled=${enabled}).`);
  console.log(JSON.stringify(updated.servers[name], null, 2));
}

/**
 * `chismoso mcp remove <name>` — deletes a server entry from the config file.
 */
async function runMCPRemoveServer(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    console.error('Usage: chismoso mcp remove <name>');
    process.exit(2);
  }
  // If currently connected, disconnect first so the underlying subprocess
  // / SSE transport is cleanly torn down before we wipe its config entry.
  try {
    await mcpRegistry.disconnect(name);
  } catch (e: any) {
    console.error(`[chismoso] Warning: disconnect before remove failed: ${e?.message ?? e}`);
  }
  const result = mcpRemoveServer(name);
  if (!result.removed) {
    console.error(`[chismoso] MCP server "${name}" not found in config.`);
    process.exit(3);
  }
  console.log(`[chismoso] Removed MCP server "${name}".`);
}

/**
 * `chismoso mcp connect <name>` — connects to a configured server now and
 * eagerly lists its tools. Persists `enabled=true` back to the config file
 * so future `connectAll` calls (e.g. from `investigate`) auto-pick it up.
 */
async function runMCPConnectServer(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    console.error('Usage: chismoso mcp connect <name>');
    process.exit(2);
  }
  const config = loadMCPConfig();
  const serverConfig = config.servers[name];
  if (!serverConfig) {
    console.error(`[chismoso] MCP server "${name}" not found in config.`);
    console.error(`[chismoso] Add it first with: chismoso mcp add ${name} --command=... --args=...`);
    process.exit(3);
  }
  try {
    const server = await mcpRegistry.connect(name, serverConfig);
    console.log(`[chismoso] Connected to MCP server "${name}".`);
    console.log(`  transport: ${server.config.transport}`);
    console.log(`  tools:     ${server.tools.length}`);
    for (const t of server.tools) {
      const desc = t.description ? t.description.split('\n')[0] : '';
      console.log(`    - ${t.name}${desc ? ': ' + desc : ''}`);
    }
    console.log(`  resources: ${server.resources.length}`);
    // One-shot CLI invocation: tear down the spawned subprocess / SSE
    // transport before exiting. Without this, the subprocess keeps the
    // Node event loop alive and `process.exit` hangs (or fires after the
    // 30s CLI timeout, leaking a zombie npx child).
    await mcpRegistry.disconnect(name);
  } catch (e: any) {
    console.error(`[chismoso] Failed to connect to MCP server "${name}": ${e?.message ?? e}`);
    try { await mcpRegistry.disconnect(name); } catch { /* best-effort */ }
    process.exit(1);
  }
  process.exit(0);
}

/**
 * `chismoso mcp disconnect <name>` — closes the live transport and marks
 * the config entry `enabled=false` (does NOT delete the entry).
 */
async function runMCPDisconnectServer(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    console.error('Usage: chismoso mcp disconnect <name>');
    process.exit(2);
  }
  await mcpRegistry.disconnect(name);
  console.log(`[chismoso] Disconnected from MCP server "${name}".`);
}

/**
 * `chismoso mcp tools` — lists every tool exposed by every connected server,
 * using the dotted `server.tool` convention (e.g. `github.search_repositories`).
 */
async function runMCPListTools(_args: string[]): Promise<void> {
  // Auto-connect to every enabled server in the config so that this CLI
  // invocation can list tools without requiring a prior `mcp connect` in
  // the same process. (Each CLI invocation is its own process — the
  // registry is in-memory only, so connections do not persist across runs.)
  try {
    const connectResult = await mcpRegistry.connectAll();
    if (connectResult.failed.length > 0) {
      console.error(`[chismoso] Some MCP servers failed to connect:`);
      for (const f of connectResult.failed) {
        console.error(`  - ${f.name}: ${f.error}`);
      }
    }
  } catch (e: any) {
    console.error(`[chismoso] MCP auto-connect failed: ${e?.message ?? e}`);
  }

  const tools = mcpRegistry.getAllTools();
  const connected = mcpRegistry.listConnected();
  if (tools.length === 0) {
    console.log('[chismoso] No MCP tools available.');
    if (connected.length === 0) {
      console.log('[chismoso] Enable a server with: chismoso mcp connect <name>');
    }
    await mcpRegistry.disconnectAll();
    process.exit(0);
  }
  console.log(`[chismoso] ${tools.length} MCP tool(s) from ${connected.length} server(s):\n`);
  for (const t of tools) {
    const desc = t.description ? t.description.split('\n')[0] : '';
    console.log(`  - ${t.fullName}${desc ? '\n      ' + desc : ''}`);
  }
  // Tear down spawned subprocesses before exiting so we don't leak them.
  await mcpRegistry.disconnectAll();
  process.exit(0);
}

/**
 * `chismoso mcp call <server.tool> '<json args>'` — invokes a remote tool.
 *
 * Output: MCP's callTool returns `{ content: [{ type: 'text', text: '...' }, ...] }`.
 * Text blocks are joined with newlines and printed; non-text blocks (image,
 * audio, embedded) are skipped. If no text blocks exist, the raw response
 * is printed as JSON so the caller can still see what came back.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runMCPCallTool(args: string[]): Promise<void> {
  const fullName = args[0];
  const argsJson = args[1];
  if (!fullName || !argsJson) {
    console.error('Usage: chismoso mcp call <server.tool> \'<json args>\'');
    console.error('Example: chismoso mcp call github.search_repositories \'{"query":"next.js"}\'');
    process.exit(2);
  }
  let parsedArgs: any;
  try {
    parsedArgs = JSON.parse(argsJson);
  } catch (e: any) {
    console.error(`[chismoso] Invalid JSON args: ${e?.message ?? e}`);
    process.exit(2);
  }

  // Auto-connect to the specific server named in `<server.tool>`. Each CLI
  // invocation is its own process — the in-memory registry starts empty.
  const dotIdx = fullName.indexOf('.');
  if (dotIdx < 0) {
    console.error(`[chismoso] Invalid tool name "${fullName}" — expected "server.tool"`);
    process.exit(2);
  }
  const serverName = fullName.slice(0, dotIdx);
  const config = loadMCPConfig();
  const serverConfig = config.servers[serverName];
  if (!serverConfig) {
    console.error(`[chismoso] MCP server "${serverName}" not found in config.`);
    console.error(`[chismoso] Add it first with: chismoso mcp add ${serverName} --command=... --args=...`);
    process.exit(3);
  }
  try {
    await mcpRegistry.connect(serverName, serverConfig);
  } catch (e: any) {
    console.error(`[chismoso] Failed to connect to MCP server "${serverName}": ${e?.message ?? e}`);
    process.exit(1);
  }

  try {
    const result = await mcpRegistry.callTool(fullName, parsedArgs);
    const contentArr = Array.isArray(result?.content) ? result.content : [];
    const text = contentArr
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((c: any) => (typeof c?.text === 'string' ? c.text : ''))
      .filter((t: string) => t.length > 0)
      .join('\n');
    if (text.length > 0) {
      console.log(text);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (e: any) {
    console.error(`[chismoso] MCP tool call failed: ${e?.message ?? e}`);
    try { await mcpRegistry.disconnect(serverName); } catch { /* best-effort */ }
    process.exit(1);
  }
  // Tear down the spawned subprocess so we don't leak it.
  try { await mcpRegistry.disconnect(serverName); } catch { /* best-effort */ }
  process.exit(0);
}

main().catch((e) => {
  console.error('[chismoso] FATAL:', e?.stack ?? e);
  process.exit(1);
});
