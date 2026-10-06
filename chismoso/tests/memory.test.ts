/**
 * Unit tests — MemoryDV (Task IMP-1, spec §12-§15)
 *
 * Covers:
 *   - MemoryRepository: insert / findById / findByDomain / findByTopic
 *   - MemoryConsolidator: ingestInvestigation dedup + verify flow
 *   - decay.computeRelevance: half-life math (1/2/4 half-lives → 50/25/6.25%)
 *   - decay.shouldDecay: ACTIVE / DECAYED / ARCHIVED transitions
 *   - decay.boostUtility: cap at 1.0
 *   - MemoryRepository.verify: truth_level VERIFIED + last_verified refreshed
 *   - MemoryRepository.markContradicted: confidence halved + status DECAYED
 *   - MemoryRepository.applyDecay: batch update + status transitions
 *
 * Uses an in-memory ChismosoDB so each test starts clean. The DB schema is
 * applied by ChismosoDB's constructor (SCHEMA_V1 + SCHEMA_V2 in db.ts) which
 * includes the `memories` table + indexes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChismosoDB } from '../src/db.js';
import { Repositories } from '../src/repositories.js';
import {
  AGENT_ID,
  boostUtility,
  computeRelevance,
  MemoryConsolidator,
  MemoryRepository,
  MemoryStatus,
  MemoryType,
  shouldDecay,
  type MemoryRecord,
} from '../src/memory/index.js';
import {
  InvestigationStatus,
  type Investigation,
  type Opportunity,
  type Problem,
  type Trend,
  TrendState,
  type Evidence,
  type Signal,
  SignalType,
  SourceType,
  TruthLevel,
} from '../src/models.js';

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function iso(daysAgo: number): string {
  // ISO timestamps N days in the past, deterministic per offset.
  const d = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));
  d.setUTCDate(d.getUTCDate() + 1 - daysAgo);
  return d.toISOString();
}

function makeMinimalInvestigation(): Investigation {
  return {
    id: 'inv_test_001',
    query: 'vibe coding market fit',
    scope: 'global',
    startedAt: iso(0),
    completedAt: iso(0),
    status: InvestigationStatus.COMPLETED,
    providersUsed: ['web_search'],
    queriesExecuted: ['web_search: vibe coding'],
    signalsFound: 1,
    evidenceFound: 1,
    trendsFound: 1,
    problemsFound: 0,
    opportunitiesFound: 0,
    errors: [],
    iterations: 1,
    budget: {
      maxIterations: 1,
      maxQueries: 1,
      maxSources: 1,
      maxResults: 1,
      maxRuntimeMs: 1000,
      maxProviderCalls: 1,
    },
    providerRuns: [],
  };
}

function makeTrend(overrides: Partial<Trend> = {}): Trend {
  const base: Trend = {
    id: 'trend_1',
    topic: 'vibe-coding',
    description: 'AI-assisted coding tools gaining momentum',
    state: TrendState.EMERGING_TREND,
    confidence: 0.8,
    sourcesCount: 3,
    signalsCount: 5,
    evidence: [],
    signals: [],
    firstSeen: iso(0),
    lastSeen: iso(0),
    observationCount: 1,
    growth: 0.5,
    velocity: 0.3,
    persistence: 0.7,
    crossSourceConfirmation: 0.6,
    score: 70,
    scoreBreakdown: {},
    createdAt: iso(0),
    updatedAt: iso(0),
  };
  return { ...base, ...overrides };
}

function makeProblem(overrides: Partial<Problem> = {}): Problem {
  const base: Problem = {
    id: 'problem_1',
    description: 'Devs struggle with framework churn',
    topic: 'vibe-coding',
    severity: 65,
    frequency: 50,
    confidence: 0.7,
    evidence: [],
    signals: [],
    segmentsAffected: ['frontend-devs'],
    firstSeen: iso(0),
    lastSeen: iso(0),
    observationCount: 1,
    createdAt: iso(0),
  };
  return { ...base, ...overrides };
}

function makeOpportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  const base: Opportunity = {
    id: 'opp_1',
    title: 'Stability-as-a-service for vibe coders',
    description: 'Subscription that pins framework versions automatically.',
    problem: 'framework churn',
    problemRef: 'problem_1',
    targetSegment: 'frontend-devs',
    geography: 'global',
    evidence: [],
    demand: 70,
    growth: 60,
    problemSeverity: 65,
    monetization: 75,
    timing: 80,
    marketFit: 70,
    competition: 30,
    uncertainty: 40,
    score: 72,
    scoreBreakdown: {},
    confidence: 0.6,
    suggestedNextAgent: 'AGENTE-CHISMOSO',
    createdAt: iso(0),
  };
  return { ...base, ...overrides };
}

/** Insert a memory directly via raw SQL so we can control updated_at (for decay tests). */
function insertMemoryDirectly(
  db: ChismosoDB,
  overrides: Partial<MemoryRecord> & { id: string; content: string },
): MemoryRecord {
  const ts = new Date().toISOString();
  const rec: MemoryRecord = {
    id: overrides.id,
    agent_id: AGENT_ID,
    domain: overrides.domain ?? 'trend_detection',
    type: overrides.type ?? MemoryType.SEMANTIC,
    content: overrides.content,
    source: overrides.source ?? 'orchestrator',
    source_type: overrides.source_type,
    evidence_id: overrides.evidence_id,
    provenance: overrides.provenance ?? 'investigation:inv_test',
    confidence: overrides.confidence ?? 1.0,
    truth_level: overrides.truth_level ?? 'OBSERVED',
    relevance: overrides.relevance ?? overrides.confidence ?? 1.0,
    utility: overrides.utility ?? 0,
    decay_half_life_days: overrides.decay_half_life_days ?? 30,
    scope: overrides.scope ?? 'global',
    status: overrides.status ?? MemoryStatus.ACTIVE,
    created_at: overrides.created_at ?? ts,
    updated_at: overrides.updated_at ?? ts,
    last_verified: overrides.last_verified ?? ts,
    related_signal_ids: overrides.related_signal_ids,
    related_topic: overrides.related_topic,
  };
  db.prepare(
    `INSERT INTO memories (
      id, agent_id, domain, type, content, source, source_type, evidence_id,
      provenance, confidence, truth_level, relevance, utility, decay_half_life_days,
      scope, status, created_at, updated_at, last_verified,
      related_signal_ids_json, related_topic
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    rec.id,
    rec.agent_id,
    rec.domain,
    rec.type,
    rec.content,
    rec.source,
    rec.source_type ?? null,
    rec.evidence_id ?? null,
    rec.provenance,
    rec.confidence,
    rec.truth_level,
    rec.relevance,
    rec.utility,
    rec.decay_half_life_days,
    rec.scope,
    rec.status,
    rec.created_at,
    rec.updated_at,
    rec.last_verified,
    rec.related_signal_ids ? JSON.stringify(rec.related_signal_ids) : null,
    rec.related_topic ?? null,
  );
  return rec;
}

function now(): string {
  return new Date().toISOString();
}

// Silence the logger during tests — otherwise every MemoryRepository.applyDecay
// call spits out a JSON log line. The logger writes to console.log which vitest
// captures; importing it here keeps tests quiet.
import { setLogLevel, LogLevel } from '../src/logger.js';
setLogLevel(LogLevel.ERROR);

// ---------------------------------------------------------------------------
// DECAY — pure functions
// ---------------------------------------------------------------------------

describe('memory/decay', () => {
  describe('computeRelevance', () => {
    it('returns confidence when age = 0 (just inserted)', () => {
      const now = new Date('2024-01-01T00:00:00Z');
      const mem: MemoryRecord = {
        id: 'mem_1',
        agent_id: AGENT_ID,
        domain: 'trend_detection',
        type: MemoryType.SEMANTIC,
        content: 'x',
        source: 'orchestrator',
        provenance: 'inv:test',
        confidence: 0.8,
        truth_level: 'OBSERVED',
        relevance: 0.8,
        utility: 0,
        decay_half_life_days: 30,
        scope: 'global',
        status: MemoryStatus.ACTIVE,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        last_verified: now.toISOString(),
      };
      // age 0 → decayFactor = 1 → relevance = confidence = 0.8
      expect(computeRelevance(mem, now)).toBeCloseTo(0.8, 5);
    });

    it('halves relevance after 1 half-life (30 days → 50%)', () => {
      const createdAt = new Date('2024-01-01T00:00:00Z');
      const now = new Date('2024-01-31T00:00:00Z'); // 30 days later
      const mem: MemoryRecord = {
        id: 'mem_1',
        agent_id: AGENT_ID,
        domain: 'trend_detection',
        type: MemoryType.SEMANTIC,
        content: 'x',
        source: 'orchestrator',
        provenance: 'inv:test',
        confidence: 1.0,
        truth_level: 'OBSERVED',
        relevance: 1.0,
        utility: 0,
        decay_half_life_days: 30,
        scope: 'global',
        status: MemoryStatus.ACTIVE,
        created_at: createdAt.toISOString(),
        updated_at: createdAt.toISOString(),
        last_verified: createdAt.toISOString(),
      };
      // 30 days / 30 half-life = 1 → 0.5^1 = 0.5 → relevance = 1.0 * 0.5 = 0.5
      expect(computeRelevance(mem, now)).toBeCloseTo(0.5, 5);
    });

    it('quarters relevance after 2 half-lives (60 days → 25%)', () => {
      const createdAt = new Date('2024-01-01T00:00:00Z');
      const now = new Date('2024-03-01T00:00:00Z'); // 60 days later
      const mem: MemoryRecord = {
        id: 'mem_1',
        agent_id: AGENT_ID,
        domain: 'trend_detection',
        type: MemoryType.SEMANTIC,
        content: 'x',
        source: 'orchestrator',
        provenance: 'inv:test',
        confidence: 1.0,
        truth_level: 'OBSERVED',
        relevance: 1.0,
        utility: 0,
        decay_half_life_days: 30,
        scope: 'global',
        status: MemoryStatus.ACTIVE,
        created_at: createdAt.toISOString(),
        updated_at: createdAt.toISOString(),
        last_verified: createdAt.toISOString(),
      };
      // 60 days / 30 = 2 → 0.5^2 = 0.25 → relevance = 0.25
      expect(computeRelevance(mem, now)).toBeCloseTo(0.25, 5);
    });

    it('hits ~6.25% after 4 half-lives (120 days)', () => {
      // Use a 120-day offset relative to a fixed reference so the math is
      // exact (not subject to month-length variance).
      const createdAt = new Date('2024-01-01T00:00:00Z');
      // 120 days later = 2024-04-30T00:00:00Z (120 * 24h = 2880h)
      const now = new Date(createdAt.getTime() + 120 * 24 * 60 * 60 * 1000);
      const mem: MemoryRecord = {
        id: 'mem_1',
        agent_id: AGENT_ID,
        domain: 'trend_detection',
        type: MemoryType.SEMANTIC,
        content: 'x',
        source: 'orchestrator',
        provenance: 'inv:test',
        confidence: 1.0,
        truth_level: 'OBSERVED',
        relevance: 1.0,
        utility: 0,
        decay_half_life_days: 30,
        scope: 'global',
        status: MemoryStatus.ACTIVE,
        created_at: createdAt.toISOString(),
        updated_at: createdAt.toISOString(),
        last_verified: createdAt.toISOString(),
      };
      // 120 days / 30 = 4 → 0.5^4 = 0.0625 → relevance = 0.0625
      expect(computeRelevance(mem, now)).toBeCloseTo(0.0625, 5);
    });

    it('utility boosts relevance (utility=1 → 1.5x)', () => {
      const now = new Date('2024-01-01T00:00:00Z');
      const mem: MemoryRecord = {
        id: 'mem_1',
        agent_id: AGENT_ID,
        domain: 'trend_detection',
        type: MemoryType.SEMANTIC,
        content: 'x',
        source: 'orchestrator',
        provenance: 'inv:test',
        confidence: 0.6,
        truth_level: 'OBSERVED',
        relevance: 0.6,
        utility: 1.0,
        decay_half_life_days: 30,
        scope: 'global',
        status: MemoryStatus.ACTIVE,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        last_verified: now.toISOString(),
      };
      // age 0 → decayFactor = 1, utilityBoost = 1.5 → 0.6 * 1 * 1.5 = 0.9
      expect(computeRelevance(mem, now)).toBeCloseTo(0.9, 5);
    });

    it('clamps to 1 even if utility boost pushes above', () => {
      const now = new Date('2024-01-01T00:00:00Z');
      const mem: MemoryRecord = {
        id: 'mem_1',
        agent_id: AGENT_ID,
        domain: 'trend_detection',
        type: MemoryType.SEMANTIC,
        content: 'x',
        source: 'orchestrator',
        provenance: 'inv:test',
        confidence: 1.0,
        truth_level: 'OBSERVED',
        relevance: 1.0,
        utility: 1.0,
        decay_half_life_days: 30,
        scope: 'global',
        status: MemoryStatus.ACTIVE,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        last_verified: now.toISOString(),
      };
      // 1.0 * 1 * 1.5 = 1.5 → clamped to 1.0
      expect(computeRelevance(mem, now)).toBe(1);
    });

    it('falls back to DEFAULT_HALF_LIFE_DAYS when half_life is 0', () => {
      const createdAt = new Date('2024-01-01T00:00:00Z');
      const now = new Date('2024-01-31T00:00:00Z'); // 30 days later
      const mem: MemoryRecord = {
        id: 'mem_1',
        agent_id: AGENT_ID,
        domain: 'trend_detection',
        type: MemoryType.SEMANTIC,
        content: 'x',
        source: 'orchestrator',
        provenance: 'inv:test',
        confidence: 1.0,
        truth_level: 'OBSERVED',
        relevance: 1.0,
        utility: 0,
        decay_half_life_days: 0, // misconfigured → falls back to 30
        scope: 'global',
        status: MemoryStatus.ACTIVE,
        created_at: createdAt.toISOString(),
        updated_at: createdAt.toISOString(),
        last_verified: createdAt.toISOString(),
      };
      // Falls back to default 30 → 0.5^1 = 0.5
      expect(computeRelevance(mem, now)).toBeCloseTo(0.5, 5);
    });

    it('returns 0 for malformed updated_at', () => {
      const mem: MemoryRecord = {
        id: 'mem_1',
        agent_id: AGENT_ID,
        domain: 'trend_detection',
        type: MemoryType.SEMANTIC,
        content: 'x',
        source: 'orchestrator',
        provenance: 'inv:test',
        confidence: 1.0,
        truth_level: 'OBSERVED',
        relevance: 1.0,
        utility: 0,
        decay_half_life_days: 30,
        scope: 'global',
        status: MemoryStatus.ACTIVE,
        created_at: 'not-a-date',
        updated_at: 'not-a-date',
        last_verified: 'not-a-date',
      };
      // Malformed date → returns 0 (clamped from NaN)
      expect(computeRelevance(mem, new Date())).toBe(0);
    });
  });

  describe('shouldDecay', () => {
    it('returns ACTIVE for relevance >= 0.1', () => {
      const now = new Date('2024-01-01T00:00:00Z');
      const mem: MemoryRecord = {
        id: 'mem_1',
        agent_id: AGENT_ID,
        domain: 'trend_detection',
        type: MemoryType.SEMANTIC,
        content: 'x',
        source: 'orchestrator',
        provenance: 'inv:test',
        confidence: 1.0,
        truth_level: 'OBSERVED',
        relevance: 1.0,
        utility: 0,
        decay_half_life_days: 30,
        scope: 'global',
        status: MemoryStatus.ACTIVE,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        last_verified: now.toISOString(),
      };
      const result = shouldDecay(mem, now);
      expect(result.status).toBe(MemoryStatus.ACTIVE);
      expect(result.relevance).toBeCloseTo(1.0, 5);
    });

    it('returns DECAYED when 0.01 <= relevance < 0.1 (e.g. 0.05)', () => {
      // confidence=1, half_life=30, age=129 days → 0.5^(129/30) = 0.5^4.3 ≈ 0.0508
      const createdAt = new Date('2024-01-01T00:00:00Z');
      const now = new Date('2024-05-10T00:00:00Z'); // ~129 days later
      const mem: MemoryRecord = {
        id: 'mem_1',
        agent_id: AGENT_ID,
        domain: 'trend_detection',
        type: MemoryType.SEMANTIC,
        content: 'x',
        source: 'orchestrator',
        provenance: 'inv:test',
        confidence: 1.0,
        truth_level: 'OBSERVED',
        relevance: 1.0,
        utility: 0,
        decay_half_life_days: 30,
        scope: 'global',
        status: MemoryStatus.ACTIVE,
        created_at: createdAt.toISOString(),
        updated_at: createdAt.toISOString(),
        last_verified: createdAt.toISOString(),
      };
      const result = shouldDecay(mem, now);
      expect(result.status).toBe(MemoryStatus.DECAYED);
      expect(result.relevance).toBeGreaterThan(0.01);
      expect(result.relevance).toBeLessThan(0.1);
    });

    it('returns ARCHIVED when relevance < 0.01 (very old)', () => {
      // confidence=1, half_life=30, age=400 days → 0.5^(400/30) ≈ 1.6e-4
      const createdAt = new Date('2024-01-01T00:00:00Z');
      const now = new Date('2025-02-05T00:00:00Z'); // ~400 days later
      const mem: MemoryRecord = {
        id: 'mem_1',
        agent_id: AGENT_ID,
        domain: 'trend_detection',
        type: MemoryType.SEMANTIC,
        content: 'x',
        source: 'orchestrator',
        provenance: 'inv:test',
        confidence: 1.0,
        truth_level: 'OBSERVED',
        relevance: 1.0,
        utility: 0,
        decay_half_life_days: 30,
        scope: 'global',
        status: MemoryStatus.ACTIVE,
        created_at: createdAt.toISOString(),
        updated_at: createdAt.toISOString(),
        last_verified: createdAt.toISOString(),
      };
      const result = shouldDecay(mem, now);
      expect(result.status).toBe(MemoryStatus.ARCHIVED);
      expect(result.relevance).toBeLessThan(0.01);
    });

    it('never returns RETIRED (manual-only status)', () => {
      const now = new Date('2024-01-01T00:00:00Z');
      const mem: MemoryRecord = {
        id: 'mem_1',
        agent_id: AGENT_ID,
        domain: 'trend_detection',
        type: MemoryType.SEMANTIC,
        content: 'x',
        source: 'orchestrator',
        provenance: 'inv:test',
        confidence: 1.0,
        truth_level: 'OBSERVED',
        relevance: 1.0,
        utility: 0,
        decay_half_life_days: 30,
        scope: 'global',
        status: MemoryStatus.ACTIVE,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        last_verified: now.toISOString(),
      };
      const result = shouldDecay(mem, now);
      expect(result.status).not.toBe(MemoryStatus.RETIRED);
    });
  });

  describe('boostUtility', () => {
    it('adds 0.1 by default', () => {
      const mem: MemoryRecord = {
        id: 'mem_1',
        agent_id: AGENT_ID,
        domain: 'trend_detection',
        type: MemoryType.SEMANTIC,
        content: 'x',
        source: 'orchestrator',
        provenance: 'inv:test',
        confidence: 1.0,
        truth_level: 'OBSERVED',
        relevance: 1.0,
        utility: 0.3,
        decay_half_life_days: 30,
        scope: 'global',
        status: MemoryStatus.ACTIVE,
        created_at: now(),
        updated_at: now(),
        last_verified: now(),
      };
      expect(boostUtility(mem)).toBeCloseTo(0.4, 5);
    });

    it('respects custom amount', () => {
      const mem: MemoryRecord = {
        id: 'mem_1',
        agent_id: AGENT_ID,
        domain: 'trend_detection',
        type: MemoryType.SEMANTIC,
        content: 'x',
        source: 'orchestrator',
        provenance: 'inv:test',
        confidence: 1.0,
        truth_level: 'OBSERVED',
        relevance: 1.0,
        utility: 0.2,
        decay_half_life_days: 30,
        scope: 'global',
        status: MemoryStatus.ACTIVE,
        created_at: now(),
        updated_at: now(),
        last_verified: now(),
      };
      expect(boostUtility(mem, 0.5)).toBeCloseTo(0.7, 5);
    });

    it('caps at 1.0', () => {
      const mem: MemoryRecord = {
        id: 'mem_1',
        agent_id: AGENT_ID,
        domain: 'trend_detection',
        type: MemoryType.SEMANTIC,
        content: 'x',
        source: 'orchestrator',
        provenance: 'inv:test',
        confidence: 1.0,
        truth_level: 'OBSERVED',
        relevance: 1.0,
        utility: 0.95,
        decay_half_life_days: 30,
        scope: 'global',
        status: MemoryStatus.ACTIVE,
        created_at: now(),
        updated_at: now(),
        last_verified: now(),
      };
      expect(boostUtility(mem, 0.5)).toBe(1);
    });

    it('is a no-op for non-positive amount', () => {
      const mem: MemoryRecord = {
        id: 'mem_1',
        agent_id: AGENT_ID,
        domain: 'trend_detection',
        type: MemoryType.SEMANTIC,
        content: 'x',
        source: 'orchestrator',
        provenance: 'inv:test',
        confidence: 1.0,
        truth_level: 'OBSERVED',
        relevance: 1.0,
        utility: 0.5,
        decay_half_life_days: 30,
        scope: 'global',
        status: MemoryStatus.ACTIVE,
        created_at: now(),
        updated_at: now(),
        last_verified: now(),
      };
      expect(boostUtility(mem, 0)).toBe(0.5);
      expect(boostUtility(mem, -1)).toBe(0.5);
      expect(boostUtility(mem, NaN)).toBe(0.5);
    });
  });
});

// ---------------------------------------------------------------------------
// REPOSITORY — DB-backed
// ---------------------------------------------------------------------------

describe('MemoryRepository', () => {
  let db: ChismosoDB;
  let repo: MemoryRepository;

  beforeEach(() => {
    db = new ChismosoDB({ path: ':memory:' });
    repo = new MemoryRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('insert + findById', () => {
    it('inserts a memory and reads it back by id', () => {
      const rec = repo.insert({
        agent_id: AGENT_ID,
        domain: 'trend_detection',
        type: MemoryType.SEMANTIC,
        content: 'AI coding tools are trending up',
        source: 'orchestrator',
        provenance: 'investigation:inv_1',
        confidence: 0.8,
        truth_level: 'OBSERVED',
        decay_half_life_days: 30,
        scope: 'global',
        related_topic: 'vibe-coding',
      });

      expect(rec.id).toMatch(/^mem_/);
      expect(rec.status).toBe(MemoryStatus.ACTIVE);
      expect(rec.utility).toBe(0);
      expect(rec.relevance).toBeCloseTo(0.8, 5); // initial relevance == confidence
      expect(rec.truth_level).toBe('OBSERVED');
      expect(rec.related_topic).toBe('vibe-coding');
      expect(rec.created_at).toBeTruthy();
      expect(rec.updated_at).toBe(rec.created_at);
      expect(rec.last_verified).toBe(rec.created_at);

      const fetched = repo.findById(rec.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.content).toBe('AI coding tools are trending up');
      expect(fetched!.domain).toBe('trend_detection');
      expect(fetched!.type).toBe(MemoryType.SEMANTIC);
    });

    it('findById returns null for unknown id', () => {
      expect(repo.findById('mem_does_not_exist')).toBeNull();
    });
  });

  describe('findByDomain / findByTopic / findActive', () => {
    beforeEach(() => {
      repo.insert({
        agent_id: AGENT_ID,
        domain: 'trend_detection',
        type: MemoryType.SEMANTIC,
        content: 'a',
        source: 'x',
        provenance: 'inv:1',
        confidence: 0.9,
        truth_level: 'OBSERVED',
        decay_half_life_days: 30,
        scope: 'global',
        related_topic: 'topic-A',
      });
      repo.insert({
        agent_id: AGENT_ID,
        domain: 'problem_detection',
        type: MemoryType.EPISODIC,
        content: 'b',
        source: 'x',
        provenance: 'inv:2',
        confidence: 0.5,
        truth_level: 'OBSERVED',
        decay_half_life_days: 14,
        scope: 'global',
        related_topic: 'topic-A',
      });
      repo.insert({
        agent_id: AGENT_ID,
        domain: 'trend_detection',
        type: MemoryType.SEMANTIC,
        content: 'c',
        source: 'x',
        provenance: 'inv:3',
        confidence: 0.7,
        truth_level: 'OBSERVED',
        decay_half_life_days: 30,
        scope: 'global',
        related_topic: 'topic-B',
      });
    });

    it('findByDomain returns only memories of that domain', () => {
      const trends = repo.findByDomain('trend_detection');
      expect(trends).toHaveLength(2);
      expect(trends.every((m) => m.domain === 'trend_detection')).toBe(true);
    });

    it('findByTopic returns memories across domains sharing a topic', () => {
      const aMems = repo.findByTopic('topic-A');
      expect(aMems).toHaveLength(2);
      const domains = aMems.map((m) => m.domain).sort();
      expect(domains).toEqual(['problem_detection', 'trend_detection']);
    });

    it('findByTopic returns [] for empty topic', () => {
      expect(repo.findByTopic('')).toEqual([]);
    });

    it('findActive returns only ACTIVE memories', () => {
      const active = repo.findActive();
      expect(active).toHaveLength(3);
      expect(active.every((m) => m.status === MemoryStatus.ACTIVE)).toBe(true);
    });

    it('list() filters by domain+status+type+topic', () => {
      const filtered = repo.list({
        domain: 'trend_detection',
        type: MemoryType.SEMANTIC,
        status: MemoryStatus.ACTIVE,
      });
      expect(filtered).toHaveLength(2);
      const byTopic = repo.list({ topic: 'topic-A' });
      expect(byTopic).toHaveLength(2);
    });
  });

  describe('stats', () => {
    it('returns grouped counts', () => {
      repo.insert({
        agent_id: AGENT_ID,
        domain: 'trend_detection',
        type: MemoryType.SEMANTIC,
        content: 'a',
        source: 'x',
        provenance: 'inv:1',
        confidence: 0.9,
        truth_level: 'OBSERVED',
        decay_half_life_days: 30,
        scope: 'global',
      });
      repo.insert({
        agent_id: AGENT_ID,
        domain: 'trend_detection',
        type: MemoryType.SEMANTIC,
        content: 'b',
        source: 'x',
        provenance: 'inv:2',
        confidence: 0.9,
        truth_level: 'OBSERVED',
        decay_half_life_days: 30,
        scope: 'global',
      });
      repo.insert({
        agent_id: AGENT_ID,
        domain: 'problem_detection',
        type: MemoryType.EPISODIC,
        content: 'c',
        source: 'x',
        provenance: 'inv:3',
        confidence: 0.9,
        truth_level: 'OBSERVED',
        decay_half_life_days: 14,
        scope: 'global',
      });
      const s = repo.stats();
      expect(s.total).toBe(3);
      expect(s.byDomain.find((g) => g.key === 'trend_detection')?.count).toBe(2);
      expect(s.byDomain.find((g) => g.key === 'problem_detection')?.count).toBe(1);
      expect(s.byType.find((g) => g.key === MemoryType.SEMANTIC)?.count).toBe(2);
      expect(s.byType.find((g) => g.key === MemoryType.EPISODIC)?.count).toBe(1);
      expect(s.byStatus.find((g) => g.key === MemoryStatus.ACTIVE)?.count).toBe(3);
    });
  });

  describe('verify', () => {
    it('marks truth_level VERIFIED and refreshes last_verified + updated_at', () => {
      const rec = repo.insert({
        agent_id: AGENT_ID,
        domain: 'trend_detection',
        type: MemoryType.SEMANTIC,
        content: 'x',
        source: 'orchestrator',
        provenance: 'inv:1',
        confidence: 0.8,
        truth_level: 'OBSERVED',
        decay_half_life_days: 30,
        scope: 'global',
      });
      const beforeLastVerified = rec.last_verified;
      // Sleep 10ms so updated_at changes.
      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
      return sleep(10).then(() => {
        repo.verify(rec.id);
        const after = repo.findById(rec.id);
        expect(after).not.toBeNull();
        expect(after!.truth_level).toBe('VERIFIED');
        expect(after!.last_verified).not.toBe(beforeLastVerified);
        expect(after!.updated_at).not.toBe(rec.updated_at);
        expect(after!.last_verified).toBe(after!.updated_at);
      });
    });
  });

  describe('markContradicted', () => {
    it('halves confidence and demotes to DECAYED', () => {
      const rec = repo.insert({
        agent_id: AGENT_ID,
        domain: 'trend_detection',
        type: MemoryType.SEMANTIC,
        content: 'x',
        source: 'orchestrator',
        provenance: 'inv:1',
        confidence: 0.8,
        truth_level: 'OBSERVED',
        decay_half_life_days: 30,
        scope: 'global',
      });
      repo.markContradicted(rec.id);
      const after = repo.findById(rec.id);
      expect(after).not.toBeNull();
      expect(after!.confidence).toBeCloseTo(0.4, 5);
      expect(after!.status).toBe(MemoryStatus.DECAYED);
    });
  });

  describe('boostUtility', () => {
    it('boosts utility by 0.1 default and caps at 1', () => {
      const rec = repo.insert({
        agent_id: AGENT_ID,
        domain: 'trend_detection',
        type: MemoryType.SEMANTIC,
        content: 'x',
        source: 'orchestrator',
        provenance: 'inv:1',
        confidence: 0.8,
        truth_level: 'OBSERVED',
        decay_half_life_days: 30,
        scope: 'global',
      });
      repo.boostUtility(rec.id);
      expect(repo.findById(rec.id)!.utility).toBeCloseTo(0.1, 5);

      // Boost past cap.
      repo.boostUtility(rec.id, 0.95);
      expect(repo.findById(rec.id)!.utility).toBe(1);
    });

    it('is a no-op for unknown id', () => {
      expect(() => repo.boostUtility('mem_does_not_exist')).not.toThrow();
    });
  });

  describe('archive / retire', () => {
    it('archive sets status to ARCHIVED', () => {
      const rec = repo.insert({
        agent_id: AGENT_ID,
        domain: 'trend_detection',
        type: MemoryType.SEMANTIC,
        content: 'x',
        source: 'orchestrator',
        provenance: 'inv:1',
        confidence: 0.8,
        truth_level: 'OBSERVED',
        decay_half_life_days: 30,
        scope: 'global',
      });
      repo.archive(rec.id);
      expect(repo.findById(rec.id)!.status).toBe(MemoryStatus.ARCHIVED);
    });

    it('retire sets status to RETIRED', () => {
      const rec = repo.insert({
        agent_id: AGENT_ID,
        domain: 'trend_detection',
        type: MemoryType.SEMANTIC,
        content: 'x',
        source: 'orchestrator',
        provenance: 'inv:1',
        confidence: 0.8,
        truth_level: 'OBSERVED',
        decay_half_life_days: 30,
        scope: 'global',
      });
      repo.retire(rec.id);
      expect(repo.findById(rec.id)!.status).toBe(MemoryStatus.RETIRED);
    });
  });

  describe('applyDecay', () => {
    it('does nothing when all memories are fresh', () => {
      repo.insert({
        agent_id: AGENT_ID,
        domain: 'trend_detection',
        type: MemoryType.SEMANTIC,
        content: 'fresh',
        source: 'orchestrator',
        provenance: 'inv:1',
        confidence: 0.9,
        truth_level: 'OBSERVED',
        decay_half_life_days: 30,
        scope: 'global',
      });
      const result = repo.applyDecay();
      expect(result.updated).toBe(0);
      expect(result.decayed).toBe(0);
      expect(result.archived).toBe(0);
    });

    it('marks 5 stale memories as DECAYED out of 10 (mixed batch)', () => {
      // 5 fresh memories (today) — relevance 0.9, should stay ACTIVE.
      for (let i = 0; i < 5; i++) {
        insertMemoryDirectly(db, {
          id: `mem_fresh_${i}`,
          content: `fresh-${i}`,
          confidence: 0.9,
          relevance: 0.9,
          // updated_at = now
        });
      }
      // 5 stale memories (~130 days old → relevance ~0.05 → DECAYED).
      // Use a fixed "now" so the test is deterministic.
      const staleUpdatedAt = new Date(Date.now() - 130 * 24 * 60 * 60 * 1000).toISOString();
      for (let i = 0; i < 5; i++) {
        insertMemoryDirectly(db, {
          id: `mem_stale_${i}`,
          content: `stale-${i}`,
          confidence: 1.0,
          relevance: 1.0,
          updated_at: staleUpdatedAt,
          created_at: staleUpdatedAt,
          last_verified: staleUpdatedAt,
        });
      }

      const result = repo.applyDecay();
      expect(result.decayed).toBe(5);
      expect(result.archived).toBe(0);
      expect(result.updated).toBe(5);

      // Verify the DB state.
      const active = repo.findActive();
      expect(active).toHaveLength(5); // the fresh ones
      const decayed = repo.list({ status: MemoryStatus.DECAYED });
      expect(decayed).toHaveLength(5);
    });

    it('does not re-process DECAYED memories', () => {
      // Insert 1 stale memory that should become DECAYED.
      const staleUpdatedAt = new Date(Date.now() - 130 * 24 * 60 * 60 * 1000).toISOString();
      insertMemoryDirectly(db, {
        id: 'mem_stale_1',
        content: 'stale',
        confidence: 1.0,
        relevance: 1.0,
        updated_at: staleUpdatedAt,
        created_at: staleUpdatedAt,
        last_verified: staleUpdatedAt,
      });

      const first = repo.applyDecay();
      expect(first.decayed).toBe(1);

      // Run again — should be a no-op (DECAYED rows are excluded).
      const second = repo.applyDecay();
      expect(second.updated).toBe(0);
      expect(second.decayed).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// CONSOLIDATOR — orchestrator ingest
// ---------------------------------------------------------------------------

describe('MemoryConsolidator', () => {
  let db: ChismosoDB;
  let repos: Repositories;
  let memRepo: MemoryRepository;
  let consolidator: MemoryConsolidator;

  beforeEach(() => {
    db = new ChismosoDB({ path: ':memory:' });
    repos = new Repositories(db);
    memRepo = new MemoryRepository(db);
    consolidator = new MemoryConsolidator(memRepo, repos);
  });

  afterEach(() => {
    db.close();
  });

  it('ingests trends + problems + opportunities as new memories', async () => {
    const inv = makeMinimalInvestigation();
    const trends = [makeTrend()];
    const problems = [makeProblem()];
    const opportunities = [makeOpportunity()];

    const result = await consolidator.ingestInvestigation(inv, trends, problems, opportunities);

    // 3 new memories (one per category) — no dedup because the table is empty.
    expect(result.ingested).toBe(3);
    expect(result.deduped).toBe(0);
    expect(result.verified).toBe(0);

    const all = memRepo.list({ limit: 100 });
    expect(all).toHaveLength(3);

    const trend = all.find((m) => m.domain === 'trend_detection');
    expect(trend).toBeDefined();
    expect(trend!.type).toBe(MemoryType.SEMANTIC);
    expect(trend!.truth_level).toBe('OBSERVED');
    expect(trend!.related_topic).toBe('vibe-coding');
    expect(trend!.decay_half_life_days).toBe(30);

    const problem = all.find((m) => m.domain === 'problem_detection');
    expect(problem).toBeDefined();
    expect(problem!.type).toBe(MemoryType.EPISODIC);
    expect(problem!.decay_half_life_days).toBe(14); // problems decay faster

    const opp = all.find((m) => m.domain === 'opportunity_detection');
    expect(opp).toBeDefined();
    expect(opp!.type).toBe(MemoryType.PROCEDURAL);
    expect(opp!.truth_level).toBe('INFERRED');
    expect(opp!.decay_half_life_days).toBe(60); // opportunities decay slower
  });

  it('dedupes trends on same topic — verify existing, no insert', async () => {
    const inv = makeMinimalInvestigation();
    const trends = [makeTrend({ topic: 'shared-topic' })];

    // First investigation: ingests 1 new memory.
    const r1 = await consolidator.ingestInvestigation(inv, trends, [], []);
    expect(r1.ingested).toBe(1);
    expect(r1.deduped).toBe(0);
    expect(r1.verified).toBe(0);

    // Second investigation with the SAME trend topic → should dedup + verify.
    const inv2 = { ...inv, id: 'inv_test_002' };
    const r2 = await consolidator.ingestInvestigation(inv2, trends, [], []);
    expect(r2.ingested).toBe(0);
    expect(r2.deduped).toBe(1);
    expect(r2.verified).toBe(1);

    // Total memory count should still be 1.
    const all = memRepo.list({ limit: 100 });
    expect(all).toHaveLength(1);

    // The existing memory should now be VERIFIED.
    expect(all[0].truth_level).toBe('VERIFIED');
  });

  it('dedupes problems on same topic', async () => {
    const inv = makeMinimalInvestigation();
    const problems = [makeProblem({ topic: 'shared-problem-topic' })];

    const r1 = await consolidator.ingestInvestigation(inv, [], problems, []);
    expect(r1.ingested).toBe(1);

    const inv2 = { ...inv, id: 'inv_test_002' };
    const r2 = await consolidator.ingestInvestigation(inv2, [], problems, []);
    expect(r2.ingested).toBe(0);
    expect(r2.deduped).toBe(1);
    expect(r2.verified).toBe(1);
  });

  it('does NOT dedup opportunities (each is unique synthesis)', async () => {
    const inv = makeMinimalInvestigation();
    const opps = [makeOpportunity({ title: 'Opp A' })];

    const r1 = await consolidator.ingestInvestigation(inv, [], [], opps);
    expect(r1.ingested).toBe(1);

    const inv2 = { ...inv, id: 'inv_test_002' };
    const opps2 = [makeOpportunity({ title: 'Opp B' })];
    const r2 = await consolidator.ingestInvestigation(inv2, [], [], opps2);
    expect(r2.ingested).toBe(1);
    expect(r2.deduped).toBe(0);

    const all = memRepo.list({ limit: 100 });
    expect(all).toHaveLength(2);
  });

  it('skips NOISE trends', async () => {
    const inv = makeMinimalInvestigation();
    const trends = [makeTrend({ state: TrendState.NOISE, topic: 'noise-topic' })];

    const result = await consolidator.ingestInvestigation(inv, trends, [], []);
    expect(result.ingested).toBe(0);

    const all = memRepo.list({ limit: 100 });
    expect(all).toHaveLength(0);
  });

  it('never throws on a single bad item — logs and skips', async () => {
    const inv = makeMinimalInvestigation();
    // Insert a trend that will cause a DB error downstream (omit topic).
    const badTrend = makeTrend({ topic: '' });

    // Should not throw even if the dedup logic touches edge cases.
    const result = await consolidator.ingestInvestigation(inv, [badTrend], [], []);
    // Empty topic → findSimilar returns null → inserts new memory (allowed).
    expect(result.ingested).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// INTEGRATION — orchestrator wiring (without LLM)
// ---------------------------------------------------------------------------

describe('MemoryConsolidator integration with Repositories', () => {
  it('a memory ingested from a trend can be re-found via findByTopic', async () => {
    const db = new ChismosoDB({ path: ':memory:' });
    const repos = new Repositories(db);
    const memRepo = new MemoryRepository(db);
    const consolidator = new MemoryConsolidator(memRepo, repos);

    const inv = makeMinimalInvestigation();
    const trend = makeTrend({ topic: 'integration-topic' });
    await consolidator.ingestInvestigation(inv, [trend], [], []);

    const byTopic = memRepo.findByTopic('integration-topic');
    expect(byTopic).toHaveLength(1);
    expect(byTopic[0].domain).toBe('trend_detection');
    db.close();
  });
});
