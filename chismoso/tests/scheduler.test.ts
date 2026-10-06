/**
 * Unit tests — Continuous Scheduler (Task EXP-1)
 *
 * Uses a stubbed Orchestrator (no LLM, no providers, no DB) so we can drive
 * the TopicScheduler with a tiny intervalMs and assert that ticks actually
 * fire and call orchestrator.investigate.
 *
 * loadWatchConfig / saveDefaultWatchConfig are exercised against a temp
 * JSON file under os.tmpdir().
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  TopicScheduler,
  loadWatchConfig,
  saveDefaultWatchConfig,
  DEFAULT_WATCH_CONFIG,
  type WatchConfig,
  type SchedulerLogger,
} from '../src/scheduler/index.js';
import type { Orchestrator, InvestigateInput, InvestigateResult } from '../src/orchestrator/orchestrator.js';
import { InvestigationStatus, type Investigation } from '../src/models.js';

// ---------------------------------------------------------------------------
// STUBS
// ---------------------------------------------------------------------------

const silentLogger: SchedulerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const SCHEDULER_TEST_BUDGET = {
  maxIterations: 1,
  maxQueries: 4,
  maxSources: 3,
  maxResults: 30,
  maxRuntimeMs: 60_000,
  maxProviderCalls: 5,
};

function mkInvestigation(): Investigation {
  return {
    id: `inv_${Math.random().toString(36).slice(2, 8)}`,
    query: 'test',
    scope: 'global',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status: InvestigationStatus.COMPLETED,
    providersUsed: [],
    queriesExecuted: [],
    signalsFound: 0,
    evidenceFound: 0,
    trendsFound: 0,
    problemsFound: 0,
    opportunitiesFound: 0,
    errors: [],
    iterations: 1,
    budget: SCHEDULER_TEST_BUDGET,
    providerRuns: [],
  };
}

function mkStubOrchestrator(): {
  orchestrator: Orchestrator;
  calls: InvestigateInput[];
  nextResult: () => InvestigateResult;
} {
  const calls: InvestigateInput[] = [];
  const orchestrator = {
    async investigate(input: InvestigateInput): Promise<InvestigateResult> {
      calls.push(input);
      return {
        investigation: mkInvestigation(),
        signals: [],
        evidence: [],
        trends: [],
        problems: [],
        opportunities: [],
        report: { machine: {} as any, markdown: '' },
      };
    },
  } as unknown as Orchestrator;
  return { orchestrator, calls, nextResult: () => ({}) as InvestigateResult };
}

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

describe('TopicScheduler', () => {
  it('constructor accepts a WatchConfig + stub orchestrator', () => {
    const { orchestrator } = mkStubOrchestrator();
    const sched = new TopicScheduler({
      config: { ...DEFAULT_WATCH_CONFIG, intervalMs: 1000 },
      orchestrator,
      logger: silentLogger,
    });
    expect(sched.isRunning()).toBe(false);
    expect(sched).toBeDefined();
  });

  it('start() runs the interval and stop() clears it', async () => {
    const { orchestrator, calls } = mkStubOrchestrator();
    const sched = new TopicScheduler({
      config: {
        topics: ['test-topic-1'],
        intervalMs: 30,
        geography: 'Colombia',
        maxQueries: 2,
      },
      orchestrator,
      logger: silentLogger,
    });

    sched.start();
    expect(sched.isRunning()).toBe(true);

    // First tick runs immediately (synchronously kicked off as a Promise).
    // Wait long enough for the first tick (and maybe a second one) to land.
    await new Promise((r) => setTimeout(r, 120));

    sched.stop();
    expect(sched.isRunning()).toBe(false);

    // The first tick runs immediately (no wait for interval), so we should
    // have at least one call recorded.
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0].objective).toBe('test-topic-1');
    expect(calls[0].geography).toBe('Colombia');
  });

  it('stop() is idempotent and safe when not running', () => {
    const { orchestrator } = mkStubOrchestrator();
    const sched = new TopicScheduler({
      config: { ...DEFAULT_WATCH_CONFIG, intervalMs: 100 },
      orchestrator,
      logger: silentLogger,
    });
    expect(() => sched.stop()).not.toThrow();
    sched.start();
    sched.stop();
    expect(() => sched.stop()).not.toThrow();
  });

  it('start() called twice is a no-op on the second call', () => {
    const { orchestrator } = mkStubOrchestrator();
    const warnCalls: string[] = [];
    const sched = new TopicScheduler({
      config: { ...DEFAULT_WATCH_CONFIG, intervalMs: 100 },
      orchestrator,
      logger: { ...silentLogger, warn: (m: string) => warnCalls.push(m) },
    });
    sched.start();
    sched.start();
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    sched.stop();
  });

  it('a failing investigate does NOT crash the loop', async () => {
    let calls = 0;
    const orchestrator = {
      async investigate(): Promise<InvestigateResult> {
        calls++;
        if (calls === 1) throw new Error('boom');
        return {
          investigation: mkInvestigation(),
          signals: [], evidence: [], trends: [], problems: [], opportunities: [],
          report: { machine: {} as any, markdown: '' },
        };
      },
    } as unknown as Orchestrator;

    const sched = new TopicScheduler({
      config: { topics: ['a'], intervalMs: 30, geography: 'g', maxQueries: 1 },
      orchestrator,
      logger: silentLogger,
    });
    sched.start();
    await new Promise((r) => setTimeout(r, 80));
    sched.stop();
    // Should have run at least 2 ticks (first throws, second succeeds).
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// CONFIG PERSISTENCE
// ---------------------------------------------------------------------------

describe('WatchConfig persistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'chismoso-watch-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loadWatchConfig returns DEFAULT_WATCH_CONFIG when file missing', () => {
    const p = path.join(tmpDir, 'nope.json');
    expect(existsSync(p)).toBe(false);
    const cfg = loadWatchConfig(p);
    expect(cfg.topics).toEqual(DEFAULT_WATCH_CONFIG.topics);
    expect(cfg.intervalMs).toBe(DEFAULT_WATCH_CONFIG.intervalMs);
    expect(cfg.geography).toBe(DEFAULT_WATCH_CONFIG.geography);
    expect(cfg.maxQueries).toBe(DEFAULT_WATCH_CONFIG.maxQueries);
  });

  it('saveDefaultWatchConfig writes default config to disk', () => {
    const p = path.join(tmpDir, 'watch.json');
    saveDefaultWatchConfig(p, true);
    expect(existsSync(p)).toBe(true);
    const raw = readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.topics).toEqual(DEFAULT_WATCH_CONFIG.topics);
    expect(parsed.intervalMs).toBe(DEFAULT_WATCH_CONFIG.intervalMs);
  });

  it('saveDefaultWatchConfig does NOT overwrite an existing file unless force=true', () => {
    const p = path.join(tmpDir, 'existing.json');
    writeFileSync(p, JSON.stringify({ topics: ['custom'], intervalMs: 99, geography: 'X', maxQueries: 1 }));
    saveDefaultWatchConfig(p); // force defaults to false
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    expect(parsed.topics).toEqual(['custom']);
    expect(parsed.intervalMs).toBe(99);
  });

  it('loadWatchConfig reads a custom config and merges with defaults', () => {
    const p = path.join(tmpDir, 'custom.json');
    writeFileSync(p, JSON.stringify({
      topics: ['my-topic'],
      // intentionally missing intervalMs + geography + maxQueries
    }));
    const cfg = loadWatchConfig(p);
    expect(cfg.topics).toEqual(['my-topic']);
    expect(cfg.intervalMs).toBe(DEFAULT_WATCH_CONFIG.intervalMs);
    expect(cfg.geography).toBe(DEFAULT_WATCH_CONFIG.geography);
    expect(cfg.maxQueries).toBe(DEFAULT_WATCH_CONFIG.maxQueries);
  });

  it('loadWatchConfig throws on invalid JSON', () => {
    const p = path.join(tmpDir, 'bad.json');
    writeFileSync(p, 'not json {');
    expect(() => loadWatchConfig(p)).toThrow(/Invalid JSON/);
  });

  it('loadWatchConfig falls back to defaults when topics array is empty', () => {
    const p = path.join(tmpDir, 'empty-topics.json');
    writeFileSync(p, JSON.stringify({ topics: [] }));
    const cfg = loadWatchConfig(p);
    expect(cfg.topics.length).toBeGreaterThan(0);
    expect(cfg.topics).toEqual(DEFAULT_WATCH_CONFIG.topics);
  });

  it('roundtrip: save → load preserves the values', () => {
    const p = path.join(tmpDir, 'roundtrip.json');
    saveDefaultWatchConfig(p, true);
    const cfg: WatchConfig = loadWatchConfig(p);
    expect(cfg).toEqual(DEFAULT_WATCH_CONFIG);
  });
});
