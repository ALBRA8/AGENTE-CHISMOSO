#!/usr/bin/env tsx
/**
 * CHISMOSO V1.0 — Scheduler standalone entry (Task EXP-1)
 *
 * Usage:
 *   npx tsx src/scheduler/run.ts                 # default config path
 *   CHISMOSO_WATCH_CONFIG=/path/to/watch.json npx tsx src/scheduler/run.ts
 *
 * Loads (or creates) the watch config, instantiates the Orchestrator the same
 * way `cli.ts` does, and starts the TopicScheduler. Logs are appended to
 * data/scheduler.log AND to stdout. Handles SIGINT for graceful shutdown.
 */

import { ChismosoDB } from '../db.js';
import { Repositories } from '../repositories.js';
import { createDefaultProviderRegistry } from '../providers/index.js';
import { createDefaultToolRegistry, LLMClient, Orchestrator } from '../orchestrator/index.js';
import { logger, setLogLevel, LogLevel } from '../logger.js';
import { resolveConfig } from '../config/index.js';
import {
  TopicScheduler,
  loadWatchConfig,
  saveDefaultWatchConfig,
  fileAppendedLogger,
  DEFAULT_WATCH_PATH,
} from './index.js';

const SCHEDULER_LOG_PATH = '/home/z/my-project/chismoso/data/scheduler.log';

async function main(): Promise<void> {
  const cfg = resolveConfig();
  setLogLevel(LogLevel[cfg.logLevel as keyof typeof LogLevel] ?? LogLevel.INFO);

  const watchPath = process.env.CHISMOSO_WATCH_CONFIG ?? DEFAULT_WATCH_PATH;
  saveDefaultWatchConfig(watchPath, false);
  const watchConfig = loadWatchConfig(watchPath);

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

  const log = fileAppendedLogger(SCHEDULER_LOG_PATH, logger);

  const scheduler = new TopicScheduler({
    config: watchConfig,
    orchestrator,
    logger: log,
  });

  const minutes = Math.round(watchConfig.intervalMs / 60000);
  // eslint-disable-next-line no-console
  console.log(
    `[chismoso-scheduler] Watching ${watchConfig.topics.length} topics every ${minutes} minutes. ` +
    `Geography: ${watchConfig.geography}. Press Ctrl+C to stop.`,
  );
  log.info('Scheduler booting', {
    topics: watchConfig.topics,
    intervalMs: watchConfig.intervalMs,
    geography: watchConfig.geography,
    maxQueries: watchConfig.maxQueries,
    logPath: SCHEDULER_LOG_PATH,
  });

  // Graceful shutdown on SIGINT / SIGTERM.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('Scheduler received signal, stopping', { signal });
    scheduler.stop();
    // Give in-flight HTTP calls a moment to drain, then close DB.
    setTimeout(() => {
      try { db.close(); } catch { /* ignore */ }
      process.exit(0);
    }, 500);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  scheduler.start();
}

main().catch((e) => {
  logger.error('Scheduler fatal', { err: e?.stack ?? String(e) });
  // eslint-disable-next-line no-console
  console.error('[chismoso-scheduler] FATAL:', e?.stack ?? e);
  process.exit(1);
});
