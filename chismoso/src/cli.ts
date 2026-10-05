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
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ChismosoDB } from './db.js';
import { Repositories } from './repositories.js';
import { createDefaultProviderRegistry } from './providers/index.js';
import { createDefaultToolRegistry, LLMClient, Orchestrator } from './orchestrator/index.js';
import { logger, setLogLevel, LogLevel } from './logger.js';
import { resolveConfig, resolveOutputPath } from './config/index.js';
import { generateId } from './models.js';

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
  chismoso demo                                   Run the canonical demo objective
  chismoso providers                              List providers and their health
  chismoso history [--topic=<topic>]              Show trend history
  chismoso show <investigationId>                 Show a stored investigation

Environment:
  CHISMOSO_DB_PATH          SQLite path (default: data/chismoso.db)
  CHISMOSO_LOG_LEVEL        DEBUG | INFO | WARN | ERROR
  CHISMOSO_GEOGRAPHY        Default geography (default: global)
  CHISMOSO_OUTPUT_DIR       Where to save reports (default: /home/z/my-project/download/chismoso)
`);
}

main().catch((e) => {
  console.error('[chismoso] FATAL:', e?.stack ?? e);
  process.exit(1);
});
