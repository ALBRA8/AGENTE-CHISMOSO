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

    const db = new ChismosoDB({ path: cfg.dbPath });
    const repos = new Repositories(db);
    const providerRegistry = createDefaultProviderRegistry();
    const toolRegistry = createDefaultToolRegistry();
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

    const db = new ChismosoDB({ path: cfg.dbPath });
    const repos = new Repositories(db);
    const providerRegistry = createDefaultProviderRegistry();
    const toolRegistry = createDefaultToolRegistry();
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

main().catch((e) => {
  console.error('[chismoso] FATAL:', e?.stack ?? e);
  process.exit(1);
});
