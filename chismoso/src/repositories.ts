/**
 * CHISMOSO V1.0 — Repositories
 *
 * Capa fina de persistencia. Cada repositorio sabe cómo serializar y
 * deserializar su modelo desde/hacia SQLite. La lógica de negocio vive
 * en los engines, no aquí.
 */

import type { ChismosoDB } from './db.js';
import type {
  Signal,
  Evidence,
  Trend,
  Problem,
  Opportunity,
  Investigation,
  ProviderRun,
  TopicCluster,
} from './models.js';

// ---------------------------------------------------------------------------
// SIGNALS
// ---------------------------------------------------------------------------

export class SignalRepository {
  constructor(private db: ChismosoDB) {}

  insert(s: Signal, investigationId?: string): void {
    this.db.prepare(`
      INSERT INTO signals (
        id, topic, keyword, source, source_type, timestamp, observed_at, geography,
        metric, value, normalized_value, unit, entity, direction, velocity,
        confidence, evidence_type, signal_type, metadata_json, raw_snippet, url,
        evidence_ids_json, investigation_id, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      s.id,
      s.topic,
      s.keyword,
      s.source,
      s.sourceType,
      s.timestamp,
      s.observedAt ?? null,
      s.geography,
      s.metric,
      String(s.value),
      s.normalizedValue,
      s.unit ?? null,
      s.entity ?? null,
      s.direction,
      s.velocity,
      s.confidence,
      s.evidenceType,
      s.signalType,
      JSON.stringify(s.metadata),
      s.rawSnippet,
      s.url ?? null,
      s.evidenceIds ? JSON.stringify(s.evidenceIds) : null,
      investigationId ?? null,
      new Date().toISOString(),
    );
  }

  insertMany(signals: Signal[], investigationId?: string): number {
    const tx = this.db.transaction(() => {
      for (const s of signals) this.insert(s, investigationId);
      return signals.length;
    });
    return tx();
  }

  findByTopic(topic: string): Signal[] {
    const rows = this.db.prepare('SELECT * FROM signals WHERE topic = ? ORDER BY timestamp DESC').all(topic) as any[];
    return rows.map(parseSignalRow);
  }

  findByInvestigation(investigationId: string): Signal[] {
    const rows = this.db.prepare('SELECT * FROM signals WHERE investigation_id = ?').all(investigationId) as any[];
    return rows.map(parseSignalRow);
  }

  countSince(topic: string, sinceISO: string): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS c FROM signals WHERE topic = ? AND timestamp >= ?')
      .get(topic, sinceISO) as { c: number };
    return r?.c ?? 0;
  }

  countBySourceType(sinceISO: string): Record<string, number> {
    const rows = this.db
      .prepare('SELECT source_type, COUNT(*) AS c FROM signals WHERE timestamp >= ? GROUP BY source_type')
      .all(sinceISO) as any[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.source_type] = r.c;
    return out;
  }

  distinctKeywords(topic: string): string[] {
    const rows = this.db.prepare('SELECT DISTINCT keyword FROM signals WHERE topic = ?').all(topic) as any[];
    return rows.map((r) => r.keyword);
  }
}

function parseSignalRow(r: any): Signal {
  return {
    id: r.id,
    topic: r.topic,
    keyword: r.keyword,
    source: r.source,
    sourceType: r.source_type,
    timestamp: r.timestamp,
    observedAt: r.observed_at ?? undefined,
    geography: r.geography,
    metric: r.metric,
    value: r.value,
    normalizedValue: r.normalized_value,
    unit: r.unit ?? undefined,
    entity: r.entity ?? undefined,
    direction: r.direction,
    velocity: r.velocity,
    confidence: r.confidence,
    evidenceType: r.evidence_type,
    signalType: r.signal_type,
    metadata: r.metadata_json ? JSON.parse(r.metadata_json) : {},
    rawSnippet: r.raw_snippet,
    url: r.url ?? undefined,
    evidenceIds: r.evidence_ids_json ? JSON.parse(r.evidence_ids_json) : undefined,
  };
}

// ---------------------------------------------------------------------------
// EVIDENCE
// ---------------------------------------------------------------------------

export class EvidenceRepository {
  constructor(private db: ChismosoDB) {}

  insert(e: Evidence, investigationId?: string): void {
    this.db.prepare(`
      INSERT INTO evidence (
        id, source, source_type, url, observed_at, collected_at,
        geographic_scope, topic, raw_value, normalized_value, extracted_fact,
        provenance, verification_status, confidence, evidence_type, metadata_json,
        investigation_id, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      e.id,
      e.source,
      e.sourceType,
      e.url ?? null,
      e.observedAt,
      e.collectedAt,
      e.geographicScope,
      e.topic,
      e.rawValue,
      e.normalizedValue,
      e.extractedFact ?? null,
      e.provenance ?? null,
      e.verificationStatus ?? 'unverified',
      e.confidence,
      e.evidenceType,
      JSON.stringify(e.metadata),
      investigationId ?? null,
      new Date().toISOString(),
    );
  }

  findByTopic(topic: string, limit = 50): Evidence[] {
    const rows = this.db
      .prepare('SELECT * FROM evidence WHERE topic = ? ORDER BY collected_at DESC LIMIT ?')
      .all(topic, limit) as any[];
    return rows.map(parseEvidenceRow);
  }

  findByInvestigation(investigationId: string): Evidence[] {
    const rows = this.db
      .prepare('SELECT * FROM evidence WHERE investigation_id = ?')
      .all(investigationId) as any[];
    return rows.map(parseEvidenceRow);
  }
}

function parseEvidenceRow(r: any): Evidence {
  return {
    id: r.id,
    source: r.source,
    sourceType: r.source_type,
    url: r.url ?? undefined,
    observedAt: r.observed_at,
    collectedAt: r.collected_at,
    geographicScope: r.geographic_scope,
    topic: r.topic,
    rawValue: r.raw_value,
    normalizedValue: r.normalized_value,
    extractedFact: r.extracted_fact ?? undefined,
    provenance: r.provenance ?? undefined,
    verificationStatus: (r.verification_status ?? 'unverified') as Evidence['verificationStatus'],
    confidence: r.confidence,
    evidenceType: r.evidence_type,
    metadata: r.metadata_json ? JSON.parse(r.metadata_json) : {},
  };
}

// ---------------------------------------------------------------------------
// TOPICS (clustering + memory)
// ---------------------------------------------------------------------------

export class TopicRepository {
  constructor(private db: ChismosoDB) {}

  upsert(cluster: TopicCluster): void {
    this.db.prepare(`
      INSERT INTO topics (
        id, canonical, keywords_json, sources_count, first_seen, last_seen,
        observation_count, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        keywords_json = excluded.keywords_json,
        sources_count = excluded.sources_count,
        last_seen = excluded.last_seen,
        observation_count = excluded.observation_count,
        updated_at = excluded.updated_at
    `).run(
      cluster.id,
      cluster.canonical,
      JSON.stringify(cluster.keywords),
      cluster.sourcesCount,
      cluster.firstSeen,
      cluster.lastSeen,
      cluster.observationCount,
      new Date().toISOString(),
      new Date().toISOString(),
    );
  }

  findByCanonical(canonical: string): TopicCluster | null {
    const r = this.db.prepare('SELECT * FROM topics WHERE canonical = ?').get(canonical) as any;
    if (!r) return null;
    return {
      id: r.id,
      canonical: r.canonical,
      keywords: JSON.parse(r.keywords_json),
      signalIds: [],
      evidenceIds: [],
      sourcesCount: r.sources_count,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      observationCount: r.observation_count,
    };
  }

  recordObservation(topic: string, sourcesCount: number, signalsCount: number, evidenceCount: number, confidence: number, note?: string): void {
    this.db.prepare(`
      INSERT INTO topic_observations (topic, observed_at, sources_count, signals_count, evidence_count, confidence, note)
      VALUES (?,?,?,?,?,?,?)
    `).run(topic, new Date().toISOString(), sourcesCount, signalsCount, evidenceCount, confidence, note ?? null);
  }

  getHistory(topic: string, limit = 20): Array<{ observed_at: string; sources_count: number; signals_count: number; confidence: number }> {
    return this.db
      .prepare('SELECT observed_at, sources_count, signals_count, confidence FROM topic_observations WHERE topic = ? ORDER BY observed_at DESC, id DESC LIMIT ?')
      .all(topic, limit) as any[];
  }
}

// ---------------------------------------------------------------------------
// TRENDS
// ---------------------------------------------------------------------------

export class TrendRepository {
  constructor(private db: ChismosoDB) {}

  insert(t: Trend, investigationId?: string): void {
    this.db.prepare(`
      INSERT INTO trends (
        id, topic, description, state, direction, confidence, sources_count,
        signals_count, first_seen, last_seen, observation_count, growth,
        velocity, persistence, cross_source_confirmation, score,
        score_breakdown_json, evidence_json, signals_json, created_at,
        updated_at, investigation_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      t.id,
      t.topic,
      t.description,
      t.state,
      t.direction,
      t.confidence,
      t.sourcesCount,
      t.signalsCount,
      t.firstSeen,
      t.lastSeen,
      t.observationCount,
      t.growth,
      t.velocity,
      t.persistence,
      t.crossSourceConfirmation,
      t.score,
      JSON.stringify(t.scoreBreakdown),
      JSON.stringify(t.evidence),
      JSON.stringify(t.signals),
      t.createdAt,
      t.updatedAt,
      investigationId ?? null,
    );
  }

  findByTopic(topic: string): Trend[] {
    const rows = this.db.prepare('SELECT * FROM trends WHERE topic = ? ORDER BY created_at DESC').all(topic) as any[];
    return rows.map(parseTrendRow);
  }

  latest(limit = 20): Trend[] {
    const rows = this.db.prepare('SELECT * FROM trends ORDER BY created_at DESC LIMIT ?').all(limit) as any[];
    return rows.map(parseTrendRow);
  }

  findByInvestigation(investigationId: string): Trend[] {
    const rows = this.db.prepare('SELECT * FROM trends WHERE investigation_id = ?').all(investigationId) as any[];
    return rows.map(parseTrendRow);
  }
}

function parseTrendRow(r: any): Trend {
  return {
    id: r.id,
    topic: r.topic,
    description: r.description,
    state: r.state,
    direction: (r.direction ?? 'flat') as Trend['direction'],
    confidence: r.confidence,
    sourcesCount: r.sources_count,
    signalsCount: r.signals_count,
    evidence: r.evidence_json ? JSON.parse(r.evidence_json) : [],
    signals: r.signals_json ? JSON.parse(r.signals_json) : [],
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    observationCount: r.observation_count,
    growth: r.growth,
    velocity: r.velocity,
    persistence: r.persistence,
    crossSourceConfirmation: r.cross_source_confirmation,
    score: r.score,
    scoreBreakdown: r.score_breakdown_json ? JSON.parse(r.score_breakdown_json) : {},
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---------------------------------------------------------------------------
// PROBLEMS
// ---------------------------------------------------------------------------

export class ProblemRepository {
  constructor(private db: ChismosoDB) {}

  insert(p: Problem, investigationId?: string): void {
    this.db.prepare(`
      INSERT INTO problems (
        id, description, topic, severity, frequency, confidence,
        segments_json, first_seen, last_seen, observation_count,
        evidence_json, signals_json, created_at, investigation_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      p.id,
      p.description,
      p.topic,
      p.severity,
      p.frequency,
      p.confidence,
      JSON.stringify(p.segmentsAffected),
      p.firstSeen,
      p.lastSeen,
      p.observationCount,
      JSON.stringify(p.evidence),
      JSON.stringify(p.signals),
      p.createdAt,
      investigationId ?? null,
    );
  }

  findByInvestigation(investigationId: string): Problem[] {
    const rows = this.db.prepare('SELECT * FROM problems WHERE investigation_id = ?').all(investigationId) as any[];
    return rows.map(parseProblemRow);
  }
}

function parseProblemRow(r: any): Problem {
  return {
    id: r.id,
    description: r.description,
    topic: r.topic,
    severity: r.severity,
    frequency: r.frequency,
    confidence: r.confidence,
    segmentsAffected: r.segments_json ? JSON.parse(r.segments_json) : [],
    evidence: r.evidence_json ? JSON.parse(r.evidence_json) : [],
    signals: r.signals_json ? JSON.parse(r.signals_json) : [],
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    observationCount: r.observation_count,
    createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// OPPORTUNITIES
// ---------------------------------------------------------------------------

export class OpportunityRepository {
  constructor(private db: ChismosoDB) {}

  insert(o: Opportunity, investigationId?: string): void {
    this.db.prepare(`
      INSERT INTO opportunities (
        id, title, description, problem, problem_ref, target_segment, geography,
        demand, growth, problem_severity, monetization, timing, market_fit,
        competition, uncertainty, score, score_breakdown_json, confidence,
        suggested_next_agent, trend_ref, evidence_json, created_at, investigation_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      o.id,
      o.title,
      o.description,
      o.problem,
      o.problemRef ?? null,
      o.targetSegment,
      o.geography,
      o.demand,
      o.growth,
      o.problemSeverity,
      o.monetization,
      o.timing,
      o.marketFit,
      o.competition,
      o.uncertainty,
      o.score,
      JSON.stringify(o.scoreBreakdown),
      o.confidence,
      o.suggestedNextAgent,
      o.trendRef ?? null,
      JSON.stringify(o.evidence),
      o.createdAt,
      investigationId ?? null,
    );
  }

  findTop(limit = 20): Opportunity[] {
    const rows = this.db.prepare('SELECT * FROM opportunities ORDER BY score DESC LIMIT ?').all(limit) as any[];
    return rows.map(parseOpportunityRow);
  }

  findByInvestigation(investigationId: string): Opportunity[] {
    const rows = this.db.prepare('SELECT * FROM opportunities WHERE investigation_id = ? ORDER BY score DESC').all(investigationId) as any[];
    return rows.map(parseOpportunityRow);
  }
}

function parseOpportunityRow(r: any): Opportunity {
  return {
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
    suggestedNextAgent: r.suggested_next_agent,
    createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// INVESTIGATIONS + PROVIDER RUNS (observability)
// ---------------------------------------------------------------------------

export class InvestigationRepository {
  constructor(private db: ChismosoDB) {}

  insert(inv: Investigation): void {
    this.db.prepare(`
      INSERT INTO investigations (
        id, query, scope, started_at, completed_at, status, providers_json,
        queries_json, signals_found, evidence_found, trends_found,
        problems_found, opportunities_found, errors_json, duration_ms,
        iterations, budget_json, provider_runs_json, execution_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      inv.id,
      inv.query,
      inv.scope,
      inv.startedAt,
      inv.completedAt ?? null,
      inv.status,
      JSON.stringify(inv.providersUsed),
      JSON.stringify(inv.queriesExecuted),
      inv.signalsFound,
      inv.evidenceFound,
      inv.trendsFound,
      inv.problemsFound,
      inv.opportunitiesFound,
      JSON.stringify(inv.errors),
      inv.durationMs ?? null,
      inv.iterations,
      JSON.stringify(inv.budget),
      JSON.stringify(inv.providerRuns),
      inv.executionId ?? null,
    );
  }

  update(inv: Investigation): void {
    this.db.prepare(`
      UPDATE investigations SET
        completed_at = ?, status = ?, providers_json = ?, queries_json = ?,
        signals_found = ?, evidence_found = ?, trends_found = ?,
        problems_found = ?, opportunities_found = ?, errors_json = ?,
        duration_ms = ?, iterations = ?, provider_runs_json = ?,
        execution_id = COALESCE(?, execution_id)
      WHERE id = ?
    `).run(
      inv.completedAt ?? null,
      inv.status,
      JSON.stringify(inv.providersUsed),
      JSON.stringify(inv.queriesExecuted),
      inv.signalsFound,
      inv.evidenceFound,
      inv.trendsFound,
      inv.problemsFound,
      inv.opportunitiesFound,
      JSON.stringify(inv.errors),
      inv.durationMs ?? null,
      inv.iterations,
      JSON.stringify(inv.providerRuns),
      inv.executionId ?? null,
      inv.id,
    );
  }

  recordProviderRun(invId: string, run: ProviderRun): void {
    this.db.prepare(`
      INSERT INTO provider_runs (
        investigation_id, provider_name, started_at, completed_at,
        query, results_count, error, error_code, duration_ms
      ) VALUES (?,?,?,?,?,?,?,?,?)
    `).run(
      invId,
      run.providerName,
      run.startedAt,
      run.completedAt ?? null,
      run.query,
      run.resultsCount,
      run.error ?? null,
      run.errorCode ?? null,
      run.durationMs ?? null,
    );
  }

  listProviderRuns(invId: string): ProviderRun[] {
    const rows = this.db
      .prepare('SELECT * FROM provider_runs WHERE investigation_id = ? ORDER BY id ASC')
      .all(invId) as any[];
    return rows.map((r) => ({
      providerName: r.provider_name,
      startedAt: r.started_at,
      completedAt: r.completed_at ?? undefined,
      query: r.query,
      resultsCount: r.results_count,
      error: r.error ?? undefined,
      errorCode: r.error_code ?? undefined,
      durationMs: r.duration_ms ?? undefined,
    }));
  }

  get(id: string): Investigation | null {
    const r = this.db.prepare('SELECT * FROM investigations WHERE id = ?').get(id) as any;
    if (!r) return null;
    return {
      id: r.id,
      query: r.query,
      scope: r.scope,
      startedAt: r.started_at,
      completedAt: r.completed_at ?? undefined,
      status: r.status,
      providersUsed: r.providers_json ? JSON.parse(r.providers_json) : [],
      queriesExecuted: r.queries_json ? JSON.parse(r.queries_json) : [],
      signalsFound: r.signals_found,
      evidenceFound: r.evidence_found,
      trendsFound: r.trends_found,
      problemsFound: r.problems_found,
      opportunitiesFound: r.opportunities_found,
      errors: r.errors_json ? JSON.parse(r.errors_json) : [],
      durationMs: r.duration_ms ?? undefined,
      iterations: r.iterations,
      budget: r.budget_json ? JSON.parse(r.budget_json) : ({} as any),
      providerRuns: r.provider_runs_json ? JSON.parse(r.provider_runs_json) : [],
      executionId: r.execution_id ?? undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// REPOSITORY FACTORY
// ---------------------------------------------------------------------------

export class Repositories {
  signals: SignalRepository;
  evidence: EvidenceRepository;
  topics: TopicRepository;
  trends: TrendRepository;
  problems: ProblemRepository;
  opportunities: OpportunityRepository;
  investigations: InvestigationRepository;

  constructor(public db: ChismosoDB) {
    this.signals = new SignalRepository(db);
    this.evidence = new EvidenceRepository(db);
    this.topics = new TopicRepository(db);
    this.trends = new TrendRepository(db);
    this.problems = new ProblemRepository(db);
    this.opportunities = new OpportunityRepository(db);
    this.investigations = new InvestigationRepository(db);
  }
}
