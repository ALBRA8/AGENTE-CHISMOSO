/**
 * CHISMOSO V1.0 — Continuous Scheduler (Task EXP-1)
 *
 * Cron-like loop that re-investigates a fixed list of topics on a fixed
 * interval. Each tick calls `orchestrator.investigate(...)` for every topic
 * in the watch config. The orchestrator already records a `topic_observations`
 * row after clustering — so the scheduler only needs to drive the orchestrator
 * and let the existing memory layer persist temporal evolution.
 *
 * Files in this directory:
 *   index.ts — public API (WatchConfig, TopicScheduler, loadWatchConfig, saveDefaultWatchConfig)
 *   run.ts   — standalone entry (`npx tsx src/scheduler/run.ts`)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import type { LogContext } from '../logger.js';

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

export interface WatchConfig {
  topics: string[];
  intervalMs: number;
  geography: string;
  maxQueries: number;
}

export const DEFAULT_WATCH_PATH = '/home/z/my-project/chismoso/data/watch.json';

export const DEFAULT_WATCH_CONFIG: WatchConfig = {
  topics: [
    'restaurantes Colombia',
    'automatización pymes LATAM',
    'IA para pequeños negocios',
  ],
  intervalMs: 60 * 60 * 1000, // 1 hour
  geography: 'LATAM',
  maxQueries: 6,
};

// ---------------------------------------------------------------------------
// LOGGER INTERFACE — minimal, decoupled from chismoso's logger.ts so the
// scheduler can be unit-tested with a stub. In production we pass the real
// chismoso logger (which already satisfies this shape).
// ---------------------------------------------------------------------------

export interface SchedulerLogger {
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  debug(msg: string, ctx?: LogContext): void;
}

// ---------------------------------------------------------------------------
// TOPIC SCHEDULER
// ---------------------------------------------------------------------------

export interface TopicSchedulerOptions {
  config: WatchConfig;
  orchestrator: Orchestrator;
  logger: SchedulerLogger;
  /** Optional clock — defaults to setInterval. Useful for tests. */
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

export class TopicScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private tickInProgress = false;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;

  constructor(private opts: TopicSchedulerOptions) {
    this.setIntervalFn = opts.setInterval ?? setInterval;
    this.clearIntervalFn = opts.clearInterval ?? clearInterval;
  }

  /**
   * Starts the scheduler. The first tick runs immediately (so the user gets
   * feedback without waiting for the first interval), then every intervalMs.
   */
  start(): void {
    if (this.running) {
      this.opts.logger.warn('TopicScheduler.start called twice — ignoring');
      return;
    }
    this.running = true;
    this.opts.logger.info('TopicScheduler started', {
      topics: this.opts.config.topics.length,
      intervalMs: this.opts.config.intervalMs,
      geography: this.opts.config.geography,
    });
    // Kick off the first tick immediately (do not await — runs in background).
    void this.tick();
    this.timer = this.setIntervalFn(() => {
      void this.tick();
    }, this.opts.config.intervalMs);
  }

  /**
   * Stops the scheduler. Safe to call multiple times.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer !== null) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
    this.opts.logger.info('TopicScheduler stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * One iteration of the watch loop. Iterates over every topic in the config
   * and calls orchestrator.investigate. Failures are logged but never crash
   * the loop — a single bad topic should not stop watching the rest.
   */
  private async tick(): Promise<void> {
    if (this.tickInProgress) {
      this.opts.logger.warn('Previous tick still running — skipping this interval');
      return;
    }
    this.tickInProgress = true;
    const startedAt = new Date().toISOString();
    let successes = 0;
    let failures = 0;
    for (const topic of this.opts.config.topics) {
      if (!this.running) break;
      try {
        this.opts.logger.info('Watch tick — investigating topic', { topic, startedAt });
        const result = await this.opts.orchestrator.investigate({
          objective: topic,
          geography: this.opts.config.geography,
          budget: { maxQueries: this.opts.config.maxQueries },
        });
        successes++;
        this.opts.logger.info('Watch tick — topic done', {
          topic,
          status: result.investigation.status,
          signals: result.signals.length,
          trends: result.trends.length,
          opportunities: result.opportunities.length,
          durationMs: result.investigation.durationMs,
        });
      } catch (e: any) {
        failures++;
        this.opts.logger.error('Watch tick — topic failed', {
          topic,
          err: e?.message ?? String(e),
        });
      }
    }
    this.opts.logger.info('Watch tick complete', {
      startedAt,
      finishedAt: new Date().toISOString(),
      successes,
      failures,
    });
    this.tickInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// CONFIG PERSISTENCE
// ---------------------------------------------------------------------------

/**
 * Loads a WatchConfig from a JSON file. If the file does not exist, returns
 * the default config WITHOUT writing — callers (CLI, run.ts) decide whether
 * to call saveDefaultWatchConfig first.
 */
export function loadWatchConfig(pathStr: string = DEFAULT_WATCH_PATH): WatchConfig {
  if (!existsSync(pathStr)) {
    return { ...DEFAULT_WATCH_CONFIG };
  }
  const raw = readFileSync(pathStr, 'utf-8');
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`Invalid JSON in watch config at ${pathStr}: ${e?.message ?? e}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Watch config at ${pathStr} is not an object`);
  }
  // Merge with defaults so missing fields fall back to sane values.
  const cfg: WatchConfig = {
    topics: Array.isArray(parsed.topics)
      ? parsed.topics.filter((t: unknown) => typeof t === 'string' && t.length > 0)
      : [...DEFAULT_WATCH_CONFIG.topics],
    intervalMs: typeof parsed.intervalMs === 'number' && parsed.intervalMs > 0
      ? parsed.intervalMs
      : DEFAULT_WATCH_CONFIG.intervalMs,
    geography: typeof parsed.geography === 'string' && parsed.geography.length > 0
      ? parsed.geography
      : DEFAULT_WATCH_CONFIG.geography,
    maxQueries: typeof parsed.maxQueries === 'number' && parsed.maxQueries > 0
      ? parsed.maxQueries
      : DEFAULT_WATCH_CONFIG.maxQueries,
  };
  if (cfg.topics.length === 0) {
    cfg.topics = [...DEFAULT_WATCH_CONFIG.topics];
  }
  return cfg;
}

/**
 * Writes a sample watch config to the given path. Does NOT overwrite an
 * existing file unless `force` is true.
 */
export function saveDefaultWatchConfig(
  pathStr: string = DEFAULT_WATCH_PATH,
  force = false,
): void {
  if (existsSync(pathStr) && !force) return;
  mkdirSync(path.dirname(pathStr), { recursive: true });
  const json = JSON.stringify(DEFAULT_WATCH_CONFIG, null, 2);
  writeFileSync(pathStr, json, 'utf-8');
}

// ---------------------------------------------------------------------------
// FILE LOGGER (used by run.ts)
// ---------------------------------------------------------------------------

/**
 * Returns a SchedulerLogger that ALSO appends every line to a file
 * (in addition to passing through to the underlying logger).
 */
export function fileAppendedLogger(
  filePath: string,
  inner: SchedulerLogger,
): SchedulerLogger {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const append = (level: string, msg: string, ctx?: LogContext) => {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      ...(ctx ?? {}),
    }) + '\n';
    try {
      appendFileSync(filePath, line, 'utf-8');
    } catch {
      // ignore disk errors — never crash the scheduler because logging failed
    }
  };
  return {
    info: (m, c) => { inner.info(m, c); append('INFO', m, c); },
    warn: (m, c) => { inner.warn(m, c); append('WARN', m, c); },
    error: (m, c) => { inner.error(m, c); append('ERROR', m, c); },
    debug: (m, c) => { inner.debug(m, c); append('DEBUG', m, c); },
  };
}
