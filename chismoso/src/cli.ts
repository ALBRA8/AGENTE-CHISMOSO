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
 *   chismoso alerts <subcommand>                          Manage persisted alerts (IMP-4)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as nodeCrypto from 'node:crypto';
import { ChismosoDB } from './db.js';
import { Repositories } from './repositories.js';
import { createDefaultProviderRegistry } from './providers/index.js';
import { ProviderQualityTracker } from './providers/quality.js';
import { createDefaultToolRegistry, LLMClient, Orchestrator, ReActOrchestrator } from './orchestrator/index.js';
import { logger, setLogLevel, LogLevel } from './logger.js';
import { resolveConfig, resolveOutputPath } from './config/index.js';
import { generateId } from './models.js';
import { SkillsCatalog, SkillStatus } from './skills/index.js';
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
  AlertRepository,
  AlertManager,
  AlertStatus,
  AlertSeverity,
  AlertPriority,
  type Alert,
} from './alerts/index.js';
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
import { ChismosoDoctor } from './doctor/index.js';
import { toConsole, toJSON, toMarkdown } from './doctor/report.js';
import {
  MemoryRepository,
  MemoryStatus,
  MemoryType,
  type MemoryRecord,
} from './memory/index.js';
import { ExecutionTraceRepository } from './execution-trace/index.js';
import {
  FeedbackRepository,
  FeedbackType,
  type FeedbackTargetType,
} from './feedback/index.js';

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
    const sub = args[1];
    // `chismoso providers quality [--name=web_search]`
    // `chismoso providers degraded`
    if (sub === 'quality' || sub === 'degraded') {
      return runProvidersQualityCommand(args, cfg);
    }
    const reg = createDefaultProviderRegistry();
    const healths = await reg.allHealth();
    console.log(JSON.stringify({ providers: reg.list().map((p) => ({ ...p.capabilities(), health: healths[p.capabilities().name] })) }, null, 2));
    return;
  }

  if (cmd === 'auth') {
    return runAuthCommand(args, cfg);
  }

  if (cmd === 'doctor') {
    return runDoctorCommand(args, cfg);
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

  if (cmd === 'alerts') {
    return runAlertsCommand(args, cfg);
  }

  if (cmd === 'mcp') {
    return runMCPCommand(args, cfg);
  }

  if (cmd === 'skills') {
    return runSkillsCommand(args, cfg);
  }

  if (cmd === 'memory') {
    return runMemoryCommand(args, cfg);
  }

  if (cmd === 'trace') {
    return runTraceCommand(args, cfg);
  }

  if (cmd === 'feedback') {
    return runFeedbackCommand(args, cfg);
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
  chismoso providers quality [--name=web_search]  Show §10 provider quality metrics (all or one)
  chismoso providers degraded                     List providers whose quality is degraded
  chismoso auth token                             Generate a new auth token (plaintext + SHA-256 hash)
  chismoso auth status                            Show whether auth is currently enabled
  chismoso auth enable                            Enable auth in .env (CHISMOSO_AUTH_ENABLED=true)
  chismoso auth disable                           Disable auth in .env (CHISMOSO_AUTH_ENABLED=false)
  chismoso history [--topic=<topic>]              Show trend history
  chismoso show <investigationId>                 Show a stored investigation
  chismoso watch [--init] [--interval=Ms] [--topic="..."]  Continuously re-investigate a watch list
  chismoso mesh <subcommand>                      Multi-agent mesh operations
  chismoso anomalies [--topic=...] [--watch] [--interval=Ms]  Detect statistical anomalies
  chismoso doctor [--json] [--fix] [--check=<category>]  Run the 14-subsystem health audit (§31)
  chismoso mcp <subcommand>                       MCP server operations (serve, ...)

Alert subcommands (Task IMP-4):
  chismoso alerts list [--status=DETECTED] [--priority=P1] [--topic=...] [--limit=20]
                                                  List persisted alerts (recently detected first)
  chismoso alerts show <id>                      Show one alert by id
  chismoso alerts ack <id> [--by=user]            Mark an alert ACKNOWLEDGED
  chismoso alerts resolve <id> [--note="..."]    Mark an alert RESOLVED
  chismoso alerts auto-resolve                    Auto-resolve SENT alerts whose anomaly has cleared
  chismoso alerts stats                           Aggregate counts by status/severity/priority

Anomaly subcommands:
  chismoso anomalies                       Detect across all topics, print JSON, exit
  chismoso anomalies --topic=<name>        Detect for a single topic only
  chismoso anomalies --watch                Poll continuously, print only NEW anomalies
  chismoso anomalies --watch --interval=300000  Poll every 5 minutes (ms)

Memory subcommands (Task IMP-1):
  chismoso memory list [--domain=...] [--type=...] [--status=...] [--topic=...] [--limit=N]
                                                  List memories, most-relevant first
  chismoso memory show <id>                       Show one memory by id (full record)
  chismoso memory decay                            Manually trigger the temporal decay pass
  chismoso memory stats                            Aggregate counts by domain / type / status
  chismoso memory verify <id>                      Mark a memory VERIFIED (corroborating evidence)
  chismoso memory archive <id>                     Archive a memory (status -> ARCHIVED)

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

Skills subcommands (spec §26, §27, §28):
  chismoso skills list [--status=ACTIVE]   List skills (optionally filtered by status)
  chismoso skills show <identity>          Show a single skill with recent invocations
  chismoso skills seed                     Insert builtins if not present (idempotent)
  chismoso skills validate <identity>      PROPOSED -> VALIDATING -> ACTIVE (two-step)
  chismoso skills deprecate <identity>     ACTIVE -> DEPRECATED
  chismoso skills retire <identity>        DEPRECATED -> RETIRED (terminal)
  chismoso skills stats                    Aggregate success rates + invocation counts

Trace subcommands (spec §30, Task IMP-5):
  chismoso trace list [--task=investigate] [--status=success] [--limit=20]
                                                  List recent execution traces
  chismoso trace show <id>                  Show one execution trace by id
  chismoso trace stats                       Aggregate counts by status/task + success_rate

Feedback subcommands (spec §28, Task IMP-5):
  chismoso feedback add --type=ALERT_USEFUL --target-type=alert --target-id=<id>
                                                  Record operator feedback (single unit)
                                                  [--note="..."] [--user-id=alice]
  chismoso feedback list [--type=...] [--target-type=alert] [--target-id=<id>] [--limit=20]
                                                  List recent feedback (most recent first)
  chismoso feedback stats                    Aggregate useful_rate + counts by type/target

Doctor subcommands (spec §31, Task IMP-3):
  chismoso doctor                            Run all 14 subsystem checks, print colored summary
  chismoso doctor --json                     Output the report as JSON only (for piping / API use)
  chismoso doctor --fix                      Apply safe deterministic fixes (mkdir, CREATE TABLE)
  chismoso doctor --check=<category>         Run a single check by category
  chismoso doctor --check=providers --json   Single-check mode with JSON output

  Doctor categories (case-insensitive, hyphens accepted):
    providers, signal_ingestion, temporal_engine, embeddings,
    semantic_search, anomaly_detection, trend_detection, memory,
    scheduler, alerts, mcp, agent_runtime, database, configuration

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
 * `chismoso doctor` — runs the 14-subsystem health audit (spec §31).
 *
 * Flags:
 *   --json                 Output the report as JSON only (no console
 *                          symbols / colors). Used by /api/doctor.
 *   --fix                  Apply safe deterministic fixes (mkdir data/,
 *                          CREATE TABLE IF NOT EXISTS signal_embeddings).
 *   --check=<category>     Run only one check (case-insensitive, hyphens
 *                          accepted). Valid categories: providers,
 *                          signal_ingestion, temporal_engine, embeddings,
 *                          semantic_search, anomaly_detection,
 *                          trend_detection, memory, scheduler, alerts,
 *                          mcp, agent_runtime, database, configuration.
 *
 * Without --check, runs all 14 checks in parallel and prints either the
 * colored console summary (default) or the raw JSON (with --json).
 *
 * Exit codes:
 *   0  — doctor ran successfully (regardless of overall_status)
 *   1  — fatal error during doctor run
 *   2  — bad flag (unknown --check category)
 */
async function runDoctorCommand(args: string[], cfg: ReturnType<typeof resolveConfig>): Promise<void> {
  const jsonOnly = args.includes('--json');
  const applyFixes = args.includes('--fix');
  const checkName = argValue(args, '--check');

  // When emitting JSON, suppress INFO/WARN/DEBUG logs so they don't corrupt
  // the JSON stream on stdout (the chismoso logger writes everything except
  // ERROR to console.log → stdout). ERROR still goes to stderr so genuine
  // failures are visible. This mirrors what the /api/doctor route does
  // via the CHISMOSO_LOG_LEVEL=WARN env var, but goes one level stricter
  // because we want CLEAN JSON on stdout for piping into jq / curl.
  if (jsonOnly) setLogLevel(LogLevel.ERROR);

  const doctor = new ChismosoDoctor({ dbPath: cfg.dbPath });
  try {
    if (checkName) {
      // Single-check mode — useful for narrowing down a failing subsystem.
      const check = await doctor.runOne(checkName, { applyFixes });
      if (jsonOnly) {
        console.log(JSON.stringify(check, null, 2));
      } else {
        const symbol = STATUS_SYMBOL_FOR[check.status] ?? '?';
        console.log(`${symbol}  ${check.category.padEnd(20)}  ${check.message}  (${check.duration_ms}ms)`);
        if (check.fix_applied) console.log('    [FIX APPLIED]');
        if (check.details !== undefined) {
          console.log('    details:', JSON.stringify(check.details, null, 2));
        }
      }
      process.exit(0);
      return;
    }

    // Full scan mode — run all 14 checks, print the aggregate report.
    const report = await doctor.runAll({ applyFixes });
    if (jsonOnly) {
      // JSON to stdout — matches what /api/doctor parses.
      console.log(toJSON(report));
    } else {
      // Colored console summary to stderr (so piping stdout to a file gets
      // only the JSON when --json is used; without --json we still want
      // the pretty report visible in the terminal).
      console.error(toConsole(report));
      console.error('');
      console.error(`${ANSI_DIM}Full report (markdown):${ANSI_RESET}`);
      console.error(toMarkdown(report));
    }
    process.exit(0);
  } catch (e: any) {
    console.error(`[chismoso] Doctor failed: ${e?.message ?? e}`);
    process.exit(1);
  }
}

// ANSI dim/reset helpers for the doctor's stderr framing. Kept inline so
// the file stays self-contained — these mirror the symbols in report.ts
// but don't pull that module's helpers into the CLI surface.
const STATUS_SYMBOL_FOR: Record<string, string> = {
  OK: '\u2705',
  DEGRADED: '\u26A0\uFE0F',
  FAIL: '\u274C',
  UNKNOWN: '\u2753',
};
const ANSI_RESET = '\x1b[0m';
const ANSI_DIM = '\x1b[2m';

// ---------------------------------------------------------------------------
// ALERTS (Task IMP-4, spec §20)
// ---------------------------------------------------------------------------
//
// `chismoso alerts <subcommand>` operates on the persisted `alerts` table.
// Each row is a managed alert derived from an Anomaly. The lifecycle is
// DETECTED → SENT → ACKNOWLEDGED → RESOLVED; SUPPRESSED is a transient
// result of `AlertManager.emit()` when cooldown is active (never persisted).
//
// Subcommands:
//   list [--status=...] [--priority=...] [--severity=...] [--topic=...] [--limit=N]
//        Print alerts as JSON, most recent first. Filters are AND-combined.
//   show <id>                  Print a single alert as JSON. Exit 3 if not found.
//   ack <id> [--by=user]        Mark ACKNOWLEDGED (sets acknowledged_at + acknowledged_by).
//   resolve <id> [--note="..."]  Mark RESOLVED (sets resolved_at + resolution_note).
//   auto-resolve                Run the manager's autoResolve() against the current
//                               detector output. SENT alerts whose anomaly is no
//                               longer detected are moved to RESOLVED.
//   stats                       Print aggregate counts by status / severity / priority.
//
// Exit codes:
//   0  — success (may or may not have rows to print)
//   1  — fatal error during the operation
//   2  — bad usage (missing required arg)
//   3  — id not found
// ---------------------------------------------------------------------------

function runAlertsCommand(args: string[], cfg: ReturnType<typeof resolveConfig>): void {
  const sub = args[1] ?? 'list';

  if (sub === 'list') return runAlertsList(args, cfg);
  if (sub === 'show') return runAlertsShow(args, cfg);
  if (sub === 'ack') return runAlertsAck(args, cfg);
  if (sub === 'resolve') return runAlertsResolve(args, cfg);
  if (sub === 'auto-resolve') return runAlertsAutoResolve(args, cfg);
  if (sub === 'stats') return runAlertsStats(args, cfg);

  console.error(`Unknown alerts subcommand: ${sub}`);
  console.error("Try: list, show, ack, resolve, auto-resolve, stats");
  process.exit(2);
}

function parseAlertStatusArg(args: string[]): AlertStatus | undefined {
  const v = argValue(args, '--status');
  if (!v) return undefined;
  const u = v.toUpperCase();
  if (!Object.values(AlertStatus).includes(u as AlertStatus)) {
    console.error(`Invalid --status="${v}". Valid values: ${Object.values(AlertStatus).join(', ')}`);
    process.exit(2);
  }
  return u as AlertStatus;
}

function parseAlertPriorityArg(args: string[]): AlertPriority | undefined {
  const v = argValue(args, '--priority');
  if (!v) return undefined;
  const u = v.toUpperCase();
  if (!Object.values(AlertPriority).includes(u as AlertPriority)) {
    console.error(`Invalid --priority="${v}". Valid values: ${Object.values(AlertPriority).join(', ')}`);
    process.exit(2);
  }
  return u as AlertPriority;
}

function parseAlertSeverityArg(args: string[]): AlertSeverity | undefined {
  const v = argValue(args, '--severity');
  if (!v) return undefined;
  const u = v.toUpperCase();
  if (!Object.values(AlertSeverity).includes(u as AlertSeverity)) {
    console.error(`Invalid --severity="${v}". Valid values: ${Object.values(AlertSeverity).join(', ')}`);
    process.exit(2);
  }
  return u as AlertSeverity;
}

function runAlertsList(args: string[], cfg: ReturnType<typeof resolveConfig>): void {
  const status = parseAlertStatusArg(args);
  const priority = parseAlertPriorityArg(args);
  const severity = parseAlertSeverityArg(args);
  const topic = argValue(args, '--topic');
  const limit = argInt(args, '--limit') ?? 50;

  const db = new ChismosoDB({ path: cfg.dbPath });
  try {
    const repo = new AlertRepository(db);
    const alerts = repo.list({ status, priority, severity, topic, limit });
    console.log(JSON.stringify({
      ranAt: new Date().toISOString(),
      count: alerts.length,
      filters: { status: status ?? null, priority: priority ?? null, severity: severity ?? null, topic: topic ?? null, limit },
      alerts,
    }, null, 2));
  } finally {
    db.close();
  }
  process.exit(0);
}

function runAlertsShow(args: string[], cfg: ReturnType<typeof resolveConfig>): void {
  const id = args[2];
  if (!id) {
    console.error('Usage: chismoso alerts show <id>');
    process.exit(2);
  }
  const db = new ChismosoDB({ path: cfg.dbPath });
  try {
    const repo = new AlertRepository(db);
    const alert = repo.findById(id);
    if (!alert) {
      console.error(`Alert ${id} not found.`);
      process.exit(3);
    }
    console.log(JSON.stringify({ alert }, null, 2));
  } finally {
    db.close();
  }
  process.exit(0);
}

function runAlertsAck(args: string[], cfg: ReturnType<typeof resolveConfig>): void {
  const id = args[2];
  if (!id) {
    console.error('Usage: chismoso alerts ack <id> [--by=user]');
    process.exit(2);
  }
  const by = argValue(args, '--by') ?? 'user';
  const db = new ChismosoDB({ path: cfg.dbPath });
  try {
    const repo = new AlertRepository(db);
    const alert = repo.findById(id);
    if (!alert) {
      console.error(`Alert ${id} not found.`);
      process.exit(3);
    }
    repo.acknowledge(id, by);
    const updated = repo.findById(id)!;
    console.log(JSON.stringify({ ok: true, alert: updated }, null, 2));
  } finally {
    db.close();
  }
  process.exit(0);
}

function runAlertsResolve(args: string[], cfg: ReturnType<typeof resolveConfig>): void {
  const id = args[2];
  if (!id) {
    console.error('Usage: chismoso alerts resolve <id> [--note="..."]');
    process.exit(2);
  }
  const note = argValue(args, '--note') ?? 'resolved via CLI';
  const db = new ChismosoDB({ path: cfg.dbPath });
  try {
    const repo = new AlertRepository(db);
    const alert = repo.findById(id);
    if (!alert) {
      console.error(`Alert ${id} not found.`);
      process.exit(3);
    }
    repo.resolve(id, note);
    const updated = repo.findById(id)!;
    console.log(JSON.stringify({ ok: true, alert: updated }, null, 2));
  } finally {
    db.close();
  }
  process.exit(0);
}

function runAlertsAutoResolve(args: string[], cfg: ReturnType<typeof resolveConfig>): void {
  const cooldownMinutes = argInt(args, '--cooldown-minutes') ?? 60;
  const db = new ChismosoDB({ path: cfg.dbPath });
  try {
    const repos = new Repositories(db);
    const alertRepo = new AlertRepository(db);
    const manager = new AlertManager(alertRepo, { cooldownMinutes });
    // Use a detector WITHOUT an AlertManager wired in to avoid creating new
    // alerts during the auto-resolve scan — autoResolve only needs the set
    // of currently-detected anomaly keys.
    const detector = new AnomalyDetector(repos);
    const result = manager.autoResolve(detector);
    console.log(JSON.stringify({
      ok: true,
      resolved: result.resolved,
      ranAt: new Date().toISOString(),
    }, null, 2));
  } finally {
    db.close();
  }
  process.exit(0);
}

function runAlertsStats(_args: string[], cfg: ReturnType<typeof resolveConfig>): void {
  const db = new ChismosoDB({ path: cfg.dbPath });
  try {
    const repo = new AlertRepository(db);
    const stats = repo.stats();
    console.log(JSON.stringify({
      ranAt: new Date().toISOString(),
      ...stats,
    }, null, 2));
  } finally {
    db.close();
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// `chismoso memory <subcommand>` — MemoryDV operations (Task IMP-1)
// ---------------------------------------------------------------------------

/**
 * MemoryDV CLI (spec §12-§15). Subcommands:
 *   list [--domain=...] [--type=...] [--status=...] [--topic=...] [--limit=N]
 *        List memories, most-relevant first.
 *   show <id>
 *        Show one memory by id.
 *   decay
 *        Manually trigger the temporal decay pass.
 *   stats
 *        Aggregate counts by domain / type / status.
 *   verify <id>
 *        Manually mark a memory VERIFIED (corroborating evidence arrived).
 *   archive <id>
 *        Manually archive a memory (status → ARCHIVED).
 *
 * All subcommands open the DB read-write and close it before exit so
 * better-sqlite3's native destructor doesn't race with process teardown.
 */
function runMemoryCommand(args: string[], cfg: ReturnType<typeof resolveConfig>): void {
  const sub = args[1] ?? 'list';
  if (sub === 'list') return runMemoryList(args, cfg);
  if (sub === 'show') return runMemoryShow(args, cfg);
  if (sub === 'decay') return runMemoryDecay(args, cfg);
  if (sub === 'stats') return runMemoryStats(args, cfg);
  if (sub === 'verify') return runMemoryVerify(args, cfg);
  if (sub === 'archive') return runMemoryArchive(args, cfg);
  console.error(`Unknown memory subcommand: ${sub}`);
  console.error("Try: list, show, decay, stats, verify, archive");
  process.exit(2);
}

function parseMemoryTypeArg(args: string[]): MemoryType | undefined {
  const v = argValue(args, '--type');
  if (!v) return undefined;
  const u = v.toUpperCase();
  if (!Object.values(MemoryType).includes(u as MemoryType)) {
    console.error(`Invalid --type="${v}". Valid: ${Object.values(MemoryType).join(', ')}`);
    process.exit(2);
  }
  return u as MemoryType;
}

function parseMemoryStatusArg(args: string[]): MemoryStatus | undefined {
  const v = argValue(args, '--status');
  if (!v) return undefined;
  const u = v.toUpperCase();
  if (!Object.values(MemoryStatus).includes(u as MemoryStatus)) {
    console.error(`Invalid --status="${v}". Valid: ${Object.values(MemoryStatus).join(', ')}`);
    process.exit(2);
  }
  return u as MemoryStatus;
}

function summarize(m: MemoryRecord): Record<string, unknown> {
  return {
    id: m.id,
    domain: m.domain,
    type: m.type,
    status: m.status,
    truth_level: m.truth_level,
    confidence: m.confidence,
    relevance: m.relevance,
    utility: m.utility,
    scope: m.scope,
    related_topic: m.related_topic ?? null,
    content: m.content.length > 140 ? m.content.slice(0, 137) + '...' : m.content,
    created_at: m.created_at,
    updated_at: m.updated_at,
    last_verified: m.last_verified,
  };
}

function runMemoryList(args: string[], cfg: ReturnType<typeof resolveConfig>): void {
  const domain = argValue(args, '--domain');
  const type = parseMemoryTypeArg(args);
  const status = parseMemoryStatusArg(args);
  const topic = argValue(args, '--topic');
  const limit = argInt(args, '--limit') ?? 20;

  const db = new ChismosoDB({ path: cfg.dbPath });
  try {
    const repo = new MemoryRepository(db);
    const memories = repo.list({ domain, type, status, topic, limit });
    console.log(JSON.stringify({
      ranAt: new Date().toISOString(),
      count: memories.length,
      filters: { domain: domain ?? null, type: type ?? null, status: status ?? null, topic: topic ?? null, limit },
      memories: memories.map(summarize),
    }, null, 2));
  } finally {
    db.close();
  }
  process.exit(0);
}

function runMemoryShow(args: string[], cfg: ReturnType<typeof resolveConfig>): void {
  const id = args[2];
  if (!id) {
    console.error('Missing memory id. Usage: chismoso memory show <id>');
    process.exit(2);
  }
  const db = new ChismosoDB({ path: cfg.dbPath });
  try {
    const repo = new MemoryRepository(db);
    const mem = repo.findById(id);
    if (!mem) {
      console.error(`Memory ${id} not found`);
      process.exit(3);
    }
    console.log(JSON.stringify(mem, null, 2));
  } finally {
    db.close();
  }
  process.exit(0);
}

function runMemoryDecay(_args: string[], cfg: ReturnType<typeof resolveConfig>): void {
  const db = new ChismosoDB({ path: cfg.dbPath });
  try {
    const repo = new MemoryRepository(db);
    const result = repo.applyDecay();
    console.log(JSON.stringify({
      ranAt: new Date().toISOString(),
      ...result,
    }, null, 2));
  } finally {
    db.close();
  }
  process.exit(0);
}

function runMemoryStats(_args: string[], cfg: ReturnType<typeof resolveConfig>): void {
  const db = new ChismosoDB({ path: cfg.dbPath });
  try {
    const repo = new MemoryRepository(db);
    const stats = repo.stats();
    console.log(JSON.stringify({
      ranAt: new Date().toISOString(),
      ...stats,
    }, null, 2));
  } finally {
    db.close();
  }
  process.exit(0);
}

function runMemoryVerify(args: string[], cfg: ReturnType<typeof resolveConfig>): void {
  const id = args[2];
  if (!id) {
    console.error('Missing memory id. Usage: chismoso memory verify <id>');
    process.exit(2);
  }
  const db = new ChismosoDB({ path: cfg.dbPath });
  try {
    const repo = new MemoryRepository(db);
    const before = repo.findById(id);
    if (!before) {
      console.error(`Memory ${id} not found`);
      process.exit(3);
    }
    repo.verify(id);
    const after = repo.findById(id);
    console.log(JSON.stringify({
      ranAt: new Date().toISOString(),
      id,
      before: { truth_level: before.truth_level, last_verified: before.last_verified },
      after: { truth_level: after?.truth_level, last_verified: after?.last_verified },
    }, null, 2));
  } finally {
    db.close();
  }
  process.exit(0);
}

function runMemoryArchive(args: string[], cfg: ReturnType<typeof resolveConfig>): void {
  const id = args[2];
  if (!id) {
    console.error('Missing memory id. Usage: chismoso memory archive <id>');
    process.exit(2);
  }
  const db = new ChismosoDB({ path: cfg.dbPath });
  try {
    const repo = new MemoryRepository(db);
    const before = repo.findById(id);
    if (!before) {
      console.error(`Memory ${id} not found`);
      process.exit(3);
    }
    repo.archive(id);
    const after = repo.findById(id);
    console.log(JSON.stringify({
      ranAt: new Date().toISOString(),
      id,
      before: { status: before.status },
      after: { status: after?.status },
    }, null, 2));
  } finally {
    db.close();
  }
  process.exit(0);
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

// ---------------------------------------------------------------------------
// SKILLS COMMAND (spec §26, §27, §28)
// ---------------------------------------------------------------------------
//
// Skills are reusable, versioned, measurable capabilities. Each lives a
// lifecycle:
//
//   PROPOSED → VALIDATING → ACTIVE → DEPRECATED → RETIRED
//
// Transitions are guarded by the repository (`isAllowedTransition`) — the
// CLI just dispatches. The `seed` subcommand inserts the 8 builtins
// (signal_discovery, temporal_analysis, trend_detection, anomaly_analysis,
// evidence_validation, opportunity_detection, alert_prioritization,
// source_evaluation) if they're not already present.
//
// All subcommands open a short-lived ChismosoDB connection, do their work,
// print JSON to stdout, then close + exit(0). The exit is explicit so the
// better-sqlite3 native destructor can't segfault at process teardown.
// ---------------------------------------------------------------------------

/**
 * `chismoso skills <subcommand>` — Skills catalog operations.
 *
 * Subcommands:
 *   list [--status=ACTIVE]   List skills (optionally filtered by status)
 *   show <identity>          Show one skill with the 20 most recent invocations
 *   seed                     Insert builtins if not present (idempotent)
 *   validate <identity>      PROPOSED → VALIDATING → ACTIVE (two-step transition)
 *   deprecate <identity>     ACTIVE → DEPRECATED
 *   retire <identity>        DEPRECATED → RETIRED (terminal)
 *   stats                    Aggregate success rates + invocation counts
 */
function runSkillsCommand(args: string[], cfg: ReturnType<typeof resolveConfig>): void {
  const sub = args[1] ?? 'list';
  const db = new ChismosoDB({ path: cfg.dbPath });
  try {
    const catalog = new SkillsCatalog(db);

    if (sub === 'list') {
      const statusArg = argValue(args, '--status');
      const filter: { status?: SkillStatus; origin?: string } = {};
      if (statusArg) {
        const upper = statusArg.toUpperCase();
        if (!Object.values(SkillStatus).includes(upper as SkillStatus)) {
          console.error(`[chismoso] Invalid --status value: ${statusArg}. ` +
            `Valid: ${Object.values(SkillStatus).join(', ')}`);
          process.exit(2);
        }
        filter.status = upper as SkillStatus;
      }
      const originArg = argValue(args, '--origin');
      if (originArg) filter.origin = originArg;
      const skills = catalog.list(filter);
      console.log(JSON.stringify({
        count: skills.length,
        filter,
        skills: skills.map(summarizeSkill),
      }, null, 2));
      return;
    }

    if (sub === 'show') {
      const identity = args[2];
      if (!identity) {
        console.error('Usage: chismoso skills show <identity>');
        process.exit(2);
      }
      const skill = catalog.findByIdentity(identity) ?? catalog.findById(identity);
      if (!skill) {
        console.error(`[chismoso] Skill not found: ${identity}`);
        process.exit(3);
      }
      const invocations = catalog.recentInvocations(skill.id, 20);
      console.log(JSON.stringify({ skill, recentInvocations: invocations }, null, 2));
      return;
    }

    if (sub === 'seed') {
      const inserted = catalog.seedBuiltins();
      const all = catalog.list();
      console.log(JSON.stringify({
        ok: true,
        inserted,
        total: all.length,
        active: all.filter((s) => s.status === SkillStatus.ACTIVE).length,
        identities: all.map((s) => s.identity),
      }, null, 2));
      return;
    }

    if (sub === 'validate') {
      const identity = args[2];
      if (!identity) {
        console.error('Usage: chismoso skills validate <identity>');
        process.exit(2);
      }
      try {
        const skill = catalog.validate(identity);
        console.log(JSON.stringify({ ok: true, skill: summarizeSkill(skill) }, null, 2));
      } catch (e: any) {
        console.error(`[chismoso] validate failed: ${e?.message ?? e}`);
        process.exit(1);
      }
      return;
    }

    if (sub === 'deprecate') {
      const identity = args[2];
      if (!identity) {
        console.error('Usage: chismoso skills deprecate <identity>');
        process.exit(2);
      }
      try {
        const skill = catalog.deprecate(identity);
        console.log(JSON.stringify({ ok: true, skill: summarizeSkill(skill) }, null, 2));
      } catch (e: any) {
        console.error(`[chismoso] deprecate failed: ${e?.message ?? e}`);
        process.exit(1);
      }
      return;
    }

    if (sub === 'retire') {
      const identity = args[2];
      if (!identity) {
        console.error('Usage: chismoso skills retire <identity>');
        process.exit(2);
      }
      try {
        const skill = catalog.retire(identity);
        console.log(JSON.stringify({ ok: true, skill: summarizeSkill(skill) }, null, 2));
      } catch (e: any) {
        console.error(`[chismoso] retire failed: ${e?.message ?? e}`);
        process.exit(1);
      }
      return;
    }

    if (sub === 'stats') {
      const all = catalog.list();
      const totals = all.reduce(
        (acc, s) => {
          acc.invocations += s.invocations;
          acc.successes += s.successes;
          acc.failures += s.failures;
          return acc;
        },
        { invocations: 0, successes: 0, failures: 0 },
      );
      console.log(JSON.stringify({
        total: all.length,
        byStatus: Object.values(SkillStatus).map((st) => ({
          status: st,
          count: all.filter((s) => s.status === st).length,
        })),
        totals,
        overallSuccessRate: totals.invocations > 0
          ? Number((totals.successes / totals.invocations).toFixed(4))
          : 0,
        skills: all.map((s) => ({
          identity: s.identity,
          status: s.status,
          version: s.version,
          invocations: s.invocations,
          successes: s.successes,
          failures: s.failures,
          success_rate: s.success_rate,
          confidence: s.confidence,
          last_validated: s.last_validated,
        })),
      }, null, 2));
      return;
    }

    console.error(`Unknown skills subcommand: ${sub}`);
    console.error('Try: list, show, seed, validate, deprecate, retire, stats');
    process.exit(2);
  } finally {
    db.close();
    // Exit explicitly to avoid better-sqlite3 native destructor crash at exit.
    // The list/show/stats subcommands do NOT need to exit (they're
    // fire-and-forget reads) — but the lifecycle verbs (seed/validate/
    // deprecate/retire) mutate state and we want a clean teardown.
    if (['seed', 'validate', 'deprecate', 'retire'].includes(args[1] ?? '')) {
      process.exit(0);
    }
  }
}

/**
 * Compact view of a skill for list/stats output — drops the long prose
 * fields (procedure, evidence, pitfalls, verification) so the JSON stays
 * scannable. Use `chismoso skills show <identity>` for the full record.
 */
function summarizeSkill(s: {
  id: string;
  identity: string;
  purpose: string;
  version: string;
  status: SkillStatus;
  origin: string;
  confidence: number;
  success_rate: number;
  invocations: number;
  successes: number;
  failures: number;
  last_validated: string | null;
  updated_at: string;
}): {
  id: string;
  identity: string;
  purpose: string;
  version: string;
  status: SkillStatus;
  origin: string;
  confidence: number;
  success_rate: number;
  invocations: number;
  successes: number;
  failures: number;
  last_validated: string | null;
  updated_at: string;
} {
  return {
    id: s.id,
    identity: s.identity,
    purpose: s.purpose,
    version: s.version,
    status: s.status,
    origin: s.origin,
    confidence: s.confidence,
    success_rate: s.success_rate,
    invocations: s.invocations,
    successes: s.successes,
    failures: s.failures,
    last_validated: s.last_validated,
    updated_at: s.updated_at,
  };
}

// ---------------------------------------------------------------------------
// §10 PROVIDER QUALITY subcommands (Task IMP-6)
// ---------------------------------------------------------------------------

/**
 * `chismoso providers quality [--name=web_search]`
 * `chismoso providers degraded`
 *
 * Surfaces the per-provider quality metrics maintained by
 * `ProviderQualityTracker` (spec §10, audit B findings). Without
 * these commands, operators could only inspect per-call audit data by
 * hand-writing SQL against the `provider_runs` table.
 */
function runProvidersQualityCommand(args: string[], cfg: ReturnType<typeof resolveConfig>): void {
  const sub = args[1]; // 'quality' | 'degraded'
  const db = new ChismosoDB({ path: cfg.dbPath });
  try {
    const tracker = new ProviderQualityTracker(db);
    if (sub === 'degraded') {
      const degraded = tracker.detectDegraded();
      if (degraded.length === 0) {
        console.log(JSON.stringify({ degraded: [], count: 0, note: 'No degraded providers detected.' }, null, 2));
      } else {
        console.log(JSON.stringify({ degraded, count: degraded.length }, null, 2));
      }
      return;
    }

    // 'quality'
    const name = argValue(args, '--name');
    if (name) {
      const m = tracker.getMetrics(name);
      if (!m) {
        console.error(`[chismoso] No quality metrics recorded for provider "${name}".`);
        console.error('[chismoso] Run an investigation first so the tracker can record calls.');
        process.exit(3);
      }
      console.log(JSON.stringify(m, null, 2));
      return;
    }
    const all = tracker.getAllMetrics();
    if (all.length === 0) {
      console.log(JSON.stringify({
        providers: [],
        count: 0,
        note: 'No provider quality metrics recorded yet. Run an investigation first.',
      }, null, 2));
      return;
    }
    console.log(JSON.stringify({ providers: all, count: all.length }, null, 2));
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// §34 AUTH subcommands (Task IMP-6)
// ---------------------------------------------------------------------------

/**
 * `chismoso auth token`     — generate a fresh random token + its SHA-256 hash.
 * `chismoso auth status`    — show whether auth is currently enabled.
 * `chismoso auth enable`    — set CHISMOSO_AUTH_ENABLED=true in .env.
 * `chismoso auth disable`   — set CHISMOSO_AUTH_ENABLED=false in .env.
 *
 * The auth check itself lives in `src/lib/auth.ts` (Next.js side). These
 * CLI commands exist so operators can provision tokens and flip the
 * enabled flag without manually editing .env.
 */
function runAuthCommand(args: string[], _cfg: ReturnType<typeof resolveConfig>): void {
  const sub = args[1] ?? 'status';

  if (sub === 'token') {
    const { token, hash } = generateAuthToken();
    console.log(JSON.stringify({
      token,
      hash,
      header: process.env.CHISMOSO_AUTH_HEADER ?? 'X-Chismoso-Agent',
      instructions: [
        '1. Hand the plaintext `token` to the agent client (it will send it in the `X-Chismoso-Agent` header).',
        '2. Append the `hash` to CHISMOSO_AUTH_TOKENS in .env (comma-separated if multiple tokens):',
        `   CHISMOSO_AUTH_TOKENS=${hash}`,
        '3. Enable auth in .env:',
        '   CHISMOSO_AUTH_ENABLED=true',
        '4. Restart the Next.js dev server for the env change to take effect.',
      ],
    }, null, 2));
    return;
  }

  if (sub === 'status') {
    const enabled = process.env.CHISMOSO_AUTH_ENABLED === 'true';
    const header = process.env.CHISMOSO_AUTH_HEADER ?? 'X-Chismoso-Agent';
    const tokensConfigured = (process.env.CHISMOSO_AUTH_TOKENS ?? '')
      .split(',').map((t) => t.trim()).filter((t) => t.length > 0).length;
    console.log(JSON.stringify({
      enabled,
      header,
      tokens_configured: tokensConfigured,
      env_var: 'CHISMOSO_AUTH_ENABLED',
      note: enabled && tokensConfigured === 0
        ? 'Auth is ENABLED but no tokens are configured — all requests will be rejected.'
        : undefined,
    }, null, 2));
    return;
  }

  if (sub === 'enable' || sub === 'disable') {
    const newValue = sub === 'enable' ? 'true' : 'false';
    const envPath = resolveEnvPath();
    try {
      upsertEnvVar(envPath, 'CHISMOSO_AUTH_ENABLED', newValue);
      console.log(JSON.stringify({
        ok: true,
        env_path: envPath,
        CHISMOSO_AUTH_ENABLED: newValue,
        note: sub === 'enable'
          ? 'Auth is now enabled. Restart the Next.js dev server for the change to take effect.'
          : 'Auth is now disabled. Restart the Next.js dev server for the change to take effect.',
      }, null, 2));
    } catch (e: any) {
      console.error(`[chismoso] Failed to update .env: ${e?.message ?? e}`);
      process.exit(1);
    }
    return;
  }

  console.error(`Unknown auth subcommand: ${sub}`);
  console.error("Try 'chismoso auth token', 'chismoso auth status', 'chismoso auth enable', or 'chismoso auth disable'.");
  process.exit(2);
}

/**
 * Resolves the .env path. Prefers the Next.js project root .env, falls
 * back to the chismoso/ subdir .env (which is where chismoso-specific
 * vars typically live in dev).
 */
function resolveEnvPath(): string {
  const candidates = [
    '/home/z/my-project/.env',
    '/home/z/my-project/chismoso/.env',
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Default to the Next.js root .env (will be created on first write).
  return '/home/z/my-project/.env';
}

/**
 * Upserts a single KEY=VALUE line in the given .env file. Preserves all
 * other lines, comments, and ordering. If the key doesn't exist, it's
 * appended. If it does, the value is replaced in place. The file is
 * created if it doesn't exist.
 */
function upsertEnvVar(envPath: string, key: string, value: string): void {
  let lines: string[] = [];
  if (existsSync(envPath)) {
    const raw = readFileSync(envPath, 'utf-8');
    lines = raw.split('\n');
  }
  let replaced = false;
  const prefix = `${key}=`;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(prefix) || lines[i].startsWith(`# ${prefix}`)) {
      lines[i] = `${key}=${value}`;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    if (lines.length > 0 && lines[lines.length - 1] !== '' && lines[lines.length - 1] !== '\n') {
      lines.push('');
    }
    lines.push(`${key}=${value}`);
  }
  writeFileSync(envPath, lines.join('\n'), { mode: 0o600 });
}

/**
 * Generates a fresh random token (32 bytes, URL-safe base64) and its
 * SHA-256 hex hash. Mirrors the implementation in `src/lib/auth.ts` so
 * CLI-generated tokens are accepted by the auth middleware without
 * translation.
 */
function generateAuthToken(): { token: string; hash: string } {
  // Use Node's `node:crypto` module directly via ES import (not `require`)
  // so the auth-token command works in the compiled ESM dist build.
  // `randomFillSync` and `createHash` are both stable across Node 18+.
  const crypto = nodeCrypto;
  const bytes = crypto.randomFillSync(Buffer.alloc(32));
  // Convert to URL-safe base64.
  const token = bytes.toString('base64url');
  const hash = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  return { token, hash };
}

// ---------------------------------------------------------------------------
// Task IMP-5 — Execution Trace + Feedback CLI commands
// (spec §28, §30 — see chismoso/src/execution-trace/ and chismoso/src/feedback/)
// ---------------------------------------------------------------------------

/**
 * `chismoso trace <subcommand>` — list / show / stats over execution_traces.
 *
 * Trace rows are written by the orchestrator (orchestrator.ts + react.ts) at
 * the start (status='running') and end (status='success' | 'failure') of
 * every investigation. They give a unified audit view across investigation,
 * ReAct, MCP, and skill-invocation execution shapes.
 */
function runTraceCommand(args: string[], cfg: ReturnType<typeof resolveConfig>): void {
  const sub = args[1] ?? 'list';
  const db = new ChismosoDB({ path: cfg.dbPath });
  const repo = new ExecutionTraceRepository(db);
  try {
    if (sub === 'list') {
      const task = argValue(args, '--task');
      const status = argValue(args, '--status');
      const limit = argInt(args, '--limit') ?? 20;
      const traces = repo.list({
        task,
        status: status as any,
        limit,
      });
      const summary = traces.map((t) => ({
        id: t.id,
        task: t.task,
        status: t.status,
        start_time: t.start_time,
        duration_ms: t.duration_ms,
        tools_used_count: t.tools_used.length,
        errors_count: t.errors.length,
        related_investigation_id: t.related_investigation_id,
      }));
      console.log(JSON.stringify({
        count: summary.length,
        traces: summary,
      }, null, 2));
      return;
    }

    if (sub === 'show') {
      const id = args[2];
      if (!id) {
        console.error('Usage: chismoso trace show <id>');
        process.exit(2);
      }
      const trace = repo.findById(id);
      if (!trace) {
        console.error(`Trace ${id} not found`);
        process.exit(3);
      }
      console.log(JSON.stringify(trace, null, 2));
      return;
    }

    if (sub === 'stats') {
      const stats = repo.stats();
      console.log(JSON.stringify(stats, null, 2));
      return;
    }

    console.error(`Unknown trace subcommand: ${sub}`);
    console.error('Available: list, show, stats');
    process.exit(2);
  } finally {
    db.close();
  }
}

/**
 * `chismoso feedback <subcommand>` — add / list / stats over feedback rows.
 *
 * Feedback is the operator's signal back to CHISMOSO about the quality of
 * what it produced (spec §28). Without it, the agent has no learning loop:
 * anomalies are emitted but never confirmed/rejected; opportunities are
 * scored but never marked useful/irrelevant.
 */
function runFeedbackCommand(args: string[], cfg: ReturnType<typeof resolveConfig>): void {
  const sub = args[1] ?? 'list';
  const db = new ChismosoDB({ path: cfg.dbPath });
  const repo = new FeedbackRepository(db);
  try {
    if (sub === 'add') {
      const type = argValue(args, '--type') as FeedbackType | undefined;
      const targetType = argValue(args, '--target-type') as FeedbackTargetType | undefined;
      const targetId = argValue(args, '--target-id');
      const note = argValue(args, '--note');
      const userId = argValue(args, '--user-id');
      if (!type || !targetType || !targetId) {
        console.error('Usage: chismoso feedback add --type=ALERT_USEFUL --target-type=alert --target-id=<id> [--note="..."] [--user-id=alice]');
        console.error(`Valid types: ${Object.values(FeedbackType).join(', ')}`);
        console.error('Valid target-types: alert, trend, opportunity, signal, memory, skill');
        process.exit(2);
      }
      if (!Object.values(FeedbackType).includes(type)) {
        console.error(`Invalid type: ${type}`);
        console.error(`Valid types: ${Object.values(FeedbackType).join(', ')}`);
        process.exit(2);
      }
      const validTargets: FeedbackTargetType[] = ['alert', 'trend', 'opportunity', 'signal', 'memory', 'skill'];
      if (!validTargets.includes(targetType)) {
        console.error(`Invalid target-type: ${targetType}`);
        console.error(`Valid target-types: ${validTargets.join(', ')}`);
        process.exit(2);
      }
      const fb = repo.insert({
        type,
        target_type: targetType,
        target_id: targetId,
        note,
        user_id: userId,
      });
      console.log(JSON.stringify(fb, null, 2));
      return;
    }

    if (sub === 'list') {
      const type = argValue(args, '--type') as FeedbackType | undefined;
      const targetType = argValue(args, '--target-type') as FeedbackTargetType | undefined;
      const targetId = argValue(args, '--target-id');
      const userId = argValue(args, '--user-id');
      const limit = argInt(args, '--limit') ?? 20;
      const items = repo.list({
        type,
        target_type: targetType,
        target_id: targetId,
        user_id: userId,
        limit,
      });
      console.log(JSON.stringify({
        count: items.length,
        feedback: items,
      }, null, 2));
      return;
    }

    if (sub === 'stats') {
      const stats = repo.stats();
      console.log(JSON.stringify(stats, null, 2));
      return;
    }

    console.error(`Unknown feedback subcommand: ${sub}`);
    console.error('Available: add, list, stats');
    process.exit(2);
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error('[chismoso] FATAL:', e?.stack ?? e);
  process.exit(1);
});
