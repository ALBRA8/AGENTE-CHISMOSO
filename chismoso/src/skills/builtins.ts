/**
 * CHISMOSO V1.4 — Built-in Skills (spec §26)
 *
 * Each builtin is a reusable, versioned, measurable capability that the
 * orchestrator can invoke. They ship ACTIVE + origin='builtin' by default
 * so the system is useful out-of-the-box. The 8 skills below cover the
 * canonical CHISMOSO pipeline:
 *
 *   1. signal_discovery        — raw signal collection
 *   2. temporal_analysis        — temporal evolution of a topic's signals
 *   3. trend_detection          — cluster + classify trends
 *   4. anomaly_analysis         — statistical anomalies in observations
 *   5. evidence_validation      — cross-source confirmation
 *   6. opportunity_detection    — generate opportunities from trends/problems
 *   7. alert_prioritization     — prioritize mesh alerts
 *   8. source_evaluation        — provider quality from past runs
 *
 * Each entry is the SkillInput shape (no id, no created_at, no counters) —
 * the repository fills those in. The `identity` is the canonical name used
 * by the orchestrator and the CLI; do not rename without bumping version.
 */

import { SkillStatus, type SkillInput } from './models.js';

export const BUILTIN_SKILL_IDENTITIES = [
  'signal_discovery',
  'temporal_analysis',
  'trend_detection',
  'anomaly_analysis',
  'evidence_validation',
  'opportunity_detection',
  'alert_prioritization',
  'source_evaluation',
] as const;

export const BUILTIN_SKILLS: SkillInput[] = [
  // ---------------------------------------------------------------------------
  // 1. signal_discovery
  // ---------------------------------------------------------------------------
  {
    identity: 'signal_discovery',
    purpose:
      'Discover raw signals on a topic by querying the open web + community sources and normalizing results.',
    trigger:
      'A new investigation objective has been parsed by the planner OR the orchestrator needs to refresh a stale topic.',
    prerequisites: [],
    procedure: [
      '1. Read the planner output to get the list of (providerName, query) pairs.',
      '2. For each pair, invoke the matching tool (search_web, search_community, deepen_content).',
      '3. Normalize raw items via normalizeRawItem (Topic + Geography + InvestigationId context).',
      '4. Dedup signals and evidence (dedupSignals, dedupEvidence).',
      '5. Persist via repositories.signals.insertMany + repositories.evidence.insert.',
      '6. Record each provider run on the investigation for observability.',
      '7. Return a summary: itemCount / signalsStored / evidenceStored / durationMs per provider.',
    ].join('\n'),
    tools_required: ['search_web', 'search_community', 'deepen_content'],
    expected_result:
      'A deduplicated set of normalized signals and evidence rows in SQLite, linked to the active investigation_id. Every provider call recorded in provider_runs.',
    verification:
      'Run `chismoso show <investigationId>` — signalsCount + evidenceCount must be > 0 for at least one provider, and provider_runs JSON includes one entry per provider called.',
    pitfalls: [
      'Do NOT skip dedup — the same URL will appear across providers (e.g. a Reddit thread surfaced by both web_search and reddit_communities).',
      'Do NOT pass geographies inconsistently — searchCommunityTool takes geography from the ctx, not the args.',
      'GoogleTrendsProvider is UNAVAILABLE in V1 — collect_trends will return available:false without simulating data. Do NOT treat this as a failure.',
      'recencyDays is provider-specific — web_search honors it, reddit_communities ignores it.',
    ],
    evidence:
      'Spec §13 (signals), §14 (signal types), §23 (tools). AUDIT-C H2 (ToolDefinition gaps) notes these tools only carry 2/13 spec fields — the skills layer compensates by documenting procedure here.',
    version: '1.0.0',
    confidence: 0.85,
    origin: 'builtin',
    status: SkillStatus.ACTIVE,
  },

  // ---------------------------------------------------------------------------
  // 2. temporal_analysis
  // ---------------------------------------------------------------------------
  {
    identity: 'temporal_analysis',
    purpose:
      'Analyze the temporal evolution of a topic — signal volume over time, direction (up/down/flat), and velocity.',
    trigger:
      'After signal_discovery completes AND the topic has prior observations stored in topic_observations.',
    prerequisites: ['signal_discovery'],
    procedure: [
      '1. Load all signals for the topic via repositories.signals.findByTopic(topic).',
      '2. Group signals by source_type and bucket by ISO week.',
      '3. Compute direction (up/down/flat) by comparing the latest bucket to the prior bucket.',
      '4. Compute velocity = (current_count - prior_count) / prior_count, clamped to [-1, 1].',
      '5. Upsert a topic_observations row with sources_count / signals_count / evidence_count / confidence / note.',
      '6. Return the observation summary; the anomaly_analysis skill will consume this row next.',
    ].join('\n'),
    tools_required: [],
    expected_result:
      'A new topic_observations row stamped with the current observed_at, reflecting the latest signal counts and a derived confidence value.',
    verification:
      'Query `SELECT * FROM topic_observations WHERE topic = ? ORDER BY observed_at DESC LIMIT 1` — the row exists and signals_count matches the post-dedup count.',
    pitfalls: [
      'A topic with <2 historical observations will look "flat" — that is correct, do NOT fabricate prior data.',
      'Velocity must be clamped to [-1, 1]; otherwise a single observation spikes velocity to infinity.',
      'Do NOT delete prior observations — temporal analysis depends on the full history.',
    ],
    evidence:
      'Spec §15 (temporal memory), §18 (topic clustering). Backs the /api/anomalies source-diversity N+1 query optimized in AUDIT-PERF.',
    version: '1.0.0',
    confidence: 0.8,
    origin: 'builtin',
    status: SkillStatus.ACTIVE,
  },

  // ---------------------------------------------------------------------------
  // 3. trend_detection
  // ---------------------------------------------------------------------------
  {
    identity: 'trend_detection',
    purpose:
      'Detect trends from clustered signals with state classification (NOISE / WEAK_SIGNAL / EMERGING_TREND / STRONG_TREND / ESTABLISHED_TREND / DECLINING_TREND).',
    trigger:
      'After signal_discovery completes — clustering + trend classification runs on the fresh signal set.',
    prerequisites: ['signal_discovery'],
    procedure: [
      '1. Cluster signals via clusterSignals (overlap coefficient threshold 0.34).',
      '2. For each cluster with >=2 signals, compute the trend vector (growth, persistence, crossSource, recency, velocity, noise).',
      '3. Classify state via classifyState: NOISE / WEAK_SIGNAL / EMERGING_TREND / STRONG_TREND / ESTABLISHED_TREND / DECLINING_TREND.',
      '4. Skip clusters classified as NOISE — they are not trends.',
      '5. Persist each trend via repositories.trends.insert with investigation_id linkage.',
      '6. Return the list of trends; the orchestrator surfaces these in the IntelligenceReport.',
    ].join('\n'),
    tools_required: [],
    expected_result:
      'Zero or more trends persisted to the trends table, each with a non-NOISE state and a 0..100 score.',
    verification:
      'Run `chismoso show <investigationId>` — trendsFound must equal the count of trend rows with investigation_id = <investigationId>.',
    pitfalls: [
      'A cluster of size 1 is by definition NOISE — do not emit a trend.',
      'classifyState requires growth + persistence + crossSource — never compute trend from a single source.',
      'Score breakdown must be persisted as JSON in score_breakdown_json so the dashboard can render the radar chart.',
    ],
    evidence:
      'Spec §7.1 (trend states), §15 (trend scoring). Backs the /api/trends route.',
    version: '1.0.0',
    confidence: 0.82,
    origin: 'builtin',
    status: SkillStatus.ACTIVE,
  },

  // ---------------------------------------------------------------------------
  // 4. anomaly_analysis
  // ---------------------------------------------------------------------------
  {
    identity: 'anomaly_analysis',
    purpose:
      'Detect statistical anomalies in a topic observation history using z-score deviation against a sliding-window baseline.',
    trigger:
      'Periodic scheduler tick (default 5min) OR explicit `chismoso anomalies` invocation.',
    prerequisites: ['temporal_analysis'],
    procedure: [
      '1. For each topic in topic_observations with >= min_samples (default 5) rows:',
      '2.   Compute baseline mean + stddev over the trailing windowDays (default 7) observations.',
      '3.   Compare the latest observation value (signals_count) to the baseline.',
      '4.   zscore = (current - mean) / stddev (guard against stddev=0).',
      '5.   If |zscore| > zscoreThreshold (default 2.0), emit an Anomaly with severity = min(100, |zscore| * 25).',
      '6. Return the list of anomalies; the scheduler emits fresh ones via stdout.',
    ].join('\n'),
    tools_required: [],
    expected_result:
      'Zero or more Anomaly objects with id/topic/type/severity/observedAt/baseline/currentValue/zscore/description/recommendedAction.',
    verification:
      'Run `chismoso anomalies --topic=<topic>` — count matches the number of topics whose latest observation exceeds the z-score threshold.',
    pitfalls: [
      'Topics with < min_samples observations are silently skipped — they appear neither as anomalies nor as errors.',
      'A stddev of 0 (flat history) makes zscore undefined; the detector must return 0 in that case (no anomaly).',
      'severity is capped at 100 — a single outlier should not produce severity=999.',
    ],
    evidence:
      'Spec §19 (anomalies), §32 (observability). Backs the /api/anomalies route and the /api/chat/poll proactive push.',
    version: '1.0.0',
    confidence: 0.78,
    origin: 'builtin',
    status: SkillStatus.ACTIVE,
  },

  // ---------------------------------------------------------------------------
  // 5. evidence_validation
  // ---------------------------------------------------------------------------
  {
    identity: 'evidence_validation',
    purpose:
      'Validate evidence by cross-source confirmation — require >=2 distinct source_types before promoting evidence confidence above 0.5.',
    trigger:
      'After signal_discovery AND before trend_detection — the trend detector consumes the validated evidence set.',
    prerequisites: ['signal_discovery'],
    procedure: [
      '1. Load all evidence for the investigation via repositories.evidence.findByInvestigation.',
      '2. Group by normalized value (raw_value lowercased + stripped of punctuation).',
      '3. For each group, count distinct source_types.',
      '4.   1 source_type -> confidence *= 0.5 (low — single source).',
      '5.   2 source_types -> confidence *= 0.8 (medium).',
      '6.   >=3 source_types -> confidence unchanged (high — cross-confirmed).',
      '7. Update each evidence row in-place with the new confidence.',
      '8. Return the validated evidence set; trend_detection uses the high-confidence subset.',
    ].join('\n'),
    tools_required: ['deepen_content'],
    expected_result:
      'Every evidence row has a confidence value reflecting its cross-source confirmation. Trends derived from low-confidence evidence are marked accordingly.',
    verification:
      'Run `chismoso show <investigationId>` — evidence with raw_value present in 2+ source_types has confidence >= 0.5; single-source evidence has confidence <= 0.5.',
    pitfalls: [
      'Do NOT promote confidence above the original LLM-assigned value — cross-source confirmation can only LOWER confidence, never raise.',
      'A single URL quoted by both web_search and reddit_communities still counts as 2 source_types — they are different source_types per the enum.',
      'Normalized value comparison must strip punctuation — "WhatsApp" and "whatsapp" must merge.',
    ],
    evidence:
      'Spec §6 (evidence ADN), §13 (signal confidence), §16 (cross-source confirmation). Backs the crossSourceConfidence() helper.',
    version: '1.0.0',
    confidence: 0.75,
    origin: 'builtin',
    status: SkillStatus.ACTIVE,
  },

  // ---------------------------------------------------------------------------
  // 6. opportunity_detection
  // ---------------------------------------------------------------------------
  {
    identity: 'opportunity_detection',
    purpose:
      'Generate business opportunities from validated trends + detected problems, scored across 8 dimensions (demand, growth, problemSeverity, monetization, timing, marketFit, competition, uncertainty).',
    trigger:
      'After trend_detection AND problem detection have completed — opportunities are derived from their outputs.',
    prerequisites: ['trend_detection', 'evidence_validation'],
    procedure: [
      '1. Load trends and problems for the investigation.',
      '2. For each trend with state >= EMERGING_TREND:',
      '3.   Find matching problems (topic overlap or friction patterns in evidence).',
      '4.   Generate an Opportunity with the 8-dimension scoring vector.',
      '5.   Score = sum(weight_i * dimension_i), weights: demand 0.18, growth 0.18, problemSeverity 0.16, monetization 0.14, timing 0.12, marketFit 0.12, competition -0.05, uncertainty -0.09.',
      '6.   Set suggestedNextAgent = "AGENTE-LEADS".',
      '7. Persist via repositories.opportunities.insert.',
      '8. Auto-publish to mesh outbox (if mesh is enabled).',
    ].join('\n'),
    tools_required: [],
    expected_result:
      'Zero or more opportunities persisted with 0..100 scores. Each opportunity references a trend and/or problem.',
    verification:
      'Run `chismoso show <investigationId>` — opportunitiesFound matches the count of opportunities with investigation_id = <investigationId>. Score breakdown is queryable in score_breakdown_json.',
    pitfalls: [
      'A trend with no matching problem still yields an opportunity — but the problemSeverity dimension will be 0, dragging down the score.',
      'Do NOT set suggestedNextAgent to anything other than AGENTE-LEADS in V1 — the mesh routing relies on it.',
      'competition and uncertainty have NEGATIVE weights — high values REDUCE the score, do not add.',
    ],
    evidence:
      'Spec §20 (opportunities), §21 (scoring), §30 (suggested next agent). Backs the /api/opportunities and /api/mesh/events routes.',
    version: '1.0.0',
    confidence: 0.8,
    origin: 'builtin',
    status: SkillStatus.ACTIVE,
  },

  // ---------------------------------------------------------------------------
  // 7. alert_prioritization
  // ---------------------------------------------------------------------------
  {
    identity: 'alert_prioritization',
    purpose:
      'Prioritize mesh alerts by severity + relevance + time-decay so the receiver (AGENTE-LEADS) processes high-priority events first.',
    trigger:
      'When mesh_outbox has >=1 pending event for the target agent AND the agent has called GET /api/mesh/list --pending.',
    prerequisites: ['opportunity_detection'],
    procedure: [
      '1. Load pending mesh_outbox events for the agent (fetchPendingEvents).',
      '2. For each event, parse the opportunity payload.',
      '3. Compute priority = opportunity.score * relevance * decay_factor.',
      '4.   relevance = 1.0 if opportunity.targetSegment matches agent capabilities, else 0.6.',
      '5.   decay_factor = exp(-age_hours / 168)  // 1 week half-life.',
      '6. Sort events by priority DESC.',
      '7. Return the sorted list; the receiver acks in priority order.',
    ].join('\n'),
    tools_required: [],
    expected_result:
      'The pending mesh_outbox events returned in priority order. The agent processes the highest-priority first.',
    verification:
      'Run `chismoso mesh list --pending --agent=AGENTE-LEADS` — events are sorted by priority (descending), with the freshest + highest-scored event first.',
    pitfalls: [
      'decay_factor must use age_hours (created_at delta), not event_count — older events decay even if no new events arrive.',
      'relevance 0.6 is a soft penalty, not a hard filter — the agent still sees the event, just ranks it lower.',
      'Do NOT mutate the opportunity score itself — priority is a derived view, the persisted score stays intact.',
    ],
    evidence:
      'Spec §34 (mesh interoperability), §30 (alert delivery). Backs the /api/mesh/events route.',
    version: '1.0.0',
    confidence: 0.7,
    origin: 'builtin',
    status: SkillStatus.ACTIVE,
  },

  // ---------------------------------------------------------------------------
  // 8. source_evaluation
  // ---------------------------------------------------------------------------
  {
    identity: 'source_evaluation',
    purpose:
      'Evaluate provider (source) quality from past provider_runs — compute per-provider success rate, average duration, and error distribution.',
    trigger:
      'On `chismoso providers` invocation OR before a new investigation that will use the provider.',
    prerequisites: [],
    procedure: [
      '1. Load all provider_runs for the provider (or all providers if none specified).',
      '2. Compute success_rate = runs_with_results > 0 / total_runs.',
      '3. Compute avg_duration_ms = AVG(duration_ms) over completed runs.',
      '4. Compute error_distribution = GROUP BY error_code.',
      '5. Cross-reference provider_capabilities (authentication, limits) from the ProviderRegistry.',
      '6. Emit a ProviderQuality object { name, success_rate, avg_duration_ms, error_distribution, health, authentication, limits }.',
    ].join('\n'),
    tools_required: [],
    expected_result:
      'A ProviderQuality object per provider, suitable for the dashboard and the orchestrator budget planner.',
    verification:
      'Run `chismoso providers` — output JSON includes health per provider; provider_runs query confirms the success_rate matches the historical data.',
    pitfalls: [
      'A provider with 0 historical runs is reported with success_rate=0 (not NaN) — distinguish "no data" from "all failures" by checking the run count.',
      'AUTH_REQUIRED health status must NOT be reported as UNAVAILABLE — the provider may still work after credentials are supplied.',
      'avg_duration_ms must exclude null durations (incomplete runs) — otherwise the average is artificially low.',
    ],
    evidence:
      'Spec §33 (provider health), §23 (tools). Backs the /api/providers route.',
    version: '1.0.0',
    confidence: 0.72,
    origin: 'builtin',
    status: SkillStatus.ACTIVE,
  },
];
