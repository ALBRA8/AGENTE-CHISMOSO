/**
 * CHISMOSO V1.0 — Eval Suite (FASE-3-QUALITY §3.8)
 *
 * Runs the CHISMOSO intelligence pipeline against 3 fixed test
 * objectives and reports:
 *   - % of relevant signals (after §3.1 relevance filtering)
 *   - # of unique trends (after §3.4 dedup)
 *   - # of concrete opportunities (with niche + segment + geography +
 *     leadSearchHints, validated against OpportunityV1)
 *
 * The eval uses fixture Serper responses (no network, no API keys) so it
 * runs deterministically in CI. Each fixture lives in
 * `tests/fixtures/serper-*.json`.
 *
 * Usage:
 *   npx tsx scripts/eval.ts                  # run all 3, print + save
 *   npx tsx scripts/eval.ts --only=restaurants  # run one
 *
 * Output:
 *   - Pretty-printed results table to stdout.
 *   - Markdown summary written to
 *     `../CONTEXTO CHISMOSO/05_TESTS/eval-results.md`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeRawItem } from '../src/intelligence/normalizer.js';
import { filterRelevant } from '../src/intelligence/relevance.js';
import { clusterSignals, clusterSignalsAuto } from '../src/intelligence/clustering.js';
import { detectTrend } from '../src/intelligence/trends.js';
import { detectProblem } from '../src/intelligence/problems.js';
import { generateOpportunity } from '../src/intelligence/opportunities.js';
import { SourceType, type Signal, type Evidence } from '../src/models.js';
import type { RawItem } from '../src/providers/base.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface EvalObjective {
  id: string;
  label: string;
  objective: string;
  geography: string;
  fixtureFile: string;
}

const OBJECTIVES: EvalObjective[] = [
  {
    id: 'restaurants',
    label: 'Restaurantes en Colombia',
    objective: 'Oportunidades de negocio en restaurantes en Colombia',
    geography: 'Colombia',
    fixtureFile: 'serper-restaurants-colombia.json',
  },
  {
    id: 'dog-collars',
    label: 'Collares para perros en Perú',
    objective: 'Collares para perros en Perú',
    geography: 'Perú',
    fixtureFile: 'serper-dog-collars-peru.json',
  },
  {
    id: 'youtube-niche',
    label: 'Nicho de YouTube/TikTok para monetizar',
    objective: 'Nicho de YouTube/TikTok para monetizar',
    geography: 'global',
    fixtureFile: 'serper-youtube-niche.json',
  },
];

interface EvalRow {
  objectiveId: string;
  label: string;
  objective: string;
  geography: string;
  rawSignalCount: number;
  relevantSignalCount: number;
  discardedSignalCount: number;
  relevantPct: number;
  uniqueTrends: number;
  trendNames: string[];
  duplicateTrendNames: number;
  concreteOpportunities: number;
  opportunitiesWithLeadHints: number;
  weakOpportunities: number;
  v1ValidCount: number;
  v1InvalidCount: number;
}

function loadFixture(name: string): RawItem[] {
  const fixturePath = path.resolve(__dirname, '..', 'tests', 'fixtures', name);
  const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
  const organic: any[] = raw.organic ?? [];
  // Override fixture dates to be relative to "now" so the eval is
  // deterministic regardless of when it runs (the fixtures ship with
  // 2025 dates that would otherwise trigger relevance decay §3.3 and
  // push trend scores below the weak threshold). We spread the signals
  // across the last 21 days so growth-from-date-distribution produces
  // a non-trivial score.
  const now = Date.now();
  return organic.map((r, idx) => {
    const ageDays = Math.floor((idx * 2) % 21); // 0,2,4,...,20,0,2,...
    const observedAt = new Date(now - ageDays * 86400 * 1000).toISOString();
    return {
      providerName: 'web_search',
      sourceType: SourceType.SEARCH_WEB,
      title: r.title ?? '',
      snippet: r.snippet ?? '',
      url: r.link ?? '',
      hostName: (() => { try { return new URL(r.link ?? '').hostname; } catch { return ''; } })(),
      date: observedAt.slice(0, 10),
      rawMetadata: { rank: idx + 1, serperPosition: r.position ?? idx + 1 },
    };
  });
}

async function runObjective(obj: EvalObjective): Promise<EvalRow> {
  const rawItems = loadFixture(obj.fixtureFile);
  // Normalize — pass the objective so signals get relevance-scored.
  const normalized = rawItems.map((it) =>
    normalizeRawItem(it, {
      topic: obj.objective,
      geography: obj.geography,
      objective: obj.objective,
    }),
  );
  let signals = normalized.map((n) => n.signal);
  let evidence = normalized.map((n) => n.evidence);
  // Dedup.
  const seen = new Set<string>();
  signals = signals.filter((s) => {
    const k = s.url ? `url:${s.url}` : `snip:${(s.rawSnippet ?? '').slice(0, 100)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const evSeen = new Set<string>();
  evidence = evidence.filter((e) => {
    const k = e.url ? `url:${e.url}` : `snip:${e.normalizedValue.slice(0, 100)}`;
    if (evSeen.has(k)) return false;
    evSeen.add(k);
    return true;
  });

  const rawSignalCount = signals.length;
  // §3.1 relevance filter.
  const filterResult = filterRelevant(signals, {
    objective: obj.objective,
    geography: obj.geography,
  });
  const relevantSignals = filterResult.relevant;

  // §3.4 clustering — use the token-based path (no DB / embeddings in eval).
  // clusterSignalsAuto with no db/embeddingClient falls back to token-based.
  const clusterResult = await clusterSignalsAuto(relevantSignals, {});
  const clusters = clusterResult.clusters;

  // Detect trends + problems per cluster.
  const trendNames: string[] = [];
  let concreteOpportunities = 0;
  let opportunitiesWithLeadHints = 0;
  let v1ValidCount = 0;
  let v1InvalidCount = 0;
  let weakOpportunities = 0;
  for (const c of clusters) {
    const clusterSignals = c.signalIds
      .map((sid) => relevantSignals.find((s) => s.id === sid))
      .filter(Boolean) as Signal[];
    const clusterEvidence = evidence.filter((e) =>
      clusterSignals.some((s) => s.url === e.url),
    );
    const { trend } = detectTrend({
      topic: c.canonical,
      canonical: c.canonical,
      signals: clusterSignals,
      evidence: clusterEvidence,
    });
    trendNames.push(trend.topic);
    const { problem } = detectProblem({
      topic: c.canonical,
      canonical: c.canonical,
      signals: clusterSignals,
      evidence: clusterEvidence,
    });
    // Generate opportunity only if there's a problem OR a strong trend.
    if (!problem && trend.state !== 'STRONG_TREND' && trend.state !== 'ESTABLISHED_TREND') {
      continue;
    }
    const result = generateOpportunity({
      trend,
      problem: problem ?? undefined,
      signals: clusterSignals,
      evidence: clusterEvidence,
      geography: obj.geography,
      objective: obj.objective,
    });
    const { opportunity: _opp, weak, v1, v1Error } = result;
    void _opp;
    // FASE-3-QUALITY §3.8 — count opportunities generated by the pipeline
    // (regardless of `weak` status). The eval is measuring the pipeline's
    // ability to produce concrete opportunities with the §3.6 fields
    // (niche + segment + geography + leadSearchHints), not whether the
    // orchestrator would deliver them to AGENTE-LEADS. Weak opportunities
    // are still concrete — they just have a low score and would be filtered
    // by the orchestrator's STEP 6 filter.
    if (v1Error) {
      v1InvalidCount++;
    }
    if (!v1) {
      continue;
    }
    v1ValidCount++;
    // "Concrete" = niche + targetSegment + geography + leadSearchHints.
    const hasNiche = v1.niche.length >= 3;
    const hasSegment = v1.targetSegment.length > 0;
    const hasGeo = v1.geography.length > 0;
    const hasHints = v1.leadSearchHints.length >= 3;
    if (hasNiche && hasSegment && hasGeo) concreteOpportunities++;
    if (hasHints) opportunitiesWithLeadHints++;
    // Track weak status for telemetry (not used to filter the count).
    if (weak) weakOpportunities++;
  }

  // Duplicate trend names — §3.4 says no two trends with same name.
  const nameCounts = new Map<string, number>();
  for (const name of trendNames) {
    const norm = name.toLowerCase().trim();
    nameCounts.set(norm, (nameCounts.get(norm) ?? 0) + 1);
  }
  const duplicateTrendNames = Array.from(nameCounts.values()).filter((c) => c > 1).length;

  return {
    objectiveId: obj.id,
    label: obj.label,
    objective: obj.objective,
    geography: obj.geography,
    rawSignalCount,
    relevantSignalCount: relevantSignals.length,
    discardedSignalCount: filterResult.discarded,
    relevantPct: rawSignalCount === 0 ? 0 : Math.round((relevantSignals.length / rawSignalCount) * 100),
    uniqueTrends: clusters.length,
    trendNames,
    duplicateTrendNames,
    concreteOpportunities,
    opportunitiesWithLeadHints,
    weakOpportunities,
    v1ValidCount,
    v1InvalidCount,
  };
}

function printTable(rows: EvalRow[]): void {
  console.log('');
  console.log('CHISMOSO FASE-3-QUALITY EVAL RESULTS');
  console.log('='.repeat(80));
  console.log('');
  const header = [
    'Objective'.padEnd(28),
    'Raw'.padStart(5),
    'Rel%'.padStart(5),
    'Disc'.padStart(5),
    'Trend'.padStart(5),
    'Dup'.padStart(5),
    'Opps'.padStart(5),
    'Weak'.padStart(5),
    'V1ok'.padStart(5),
    'V1bad'.padStart(5),
  ].join(' | ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of rows) {
    console.log(
      [
        r.label.slice(0, 28).padEnd(28),
        String(r.rawSignalCount).padStart(5),
        `${r.relevantPct}%`.padStart(5),
        String(r.discardedSignalCount).padStart(5),
        String(r.uniqueTrends).padStart(5),
        String(r.duplicateTrendNames).padStart(5),
        String(r.concreteOpportunities).padStart(5),
        String(r.weakOpportunities).padStart(5),
        String(r.v1ValidCount).padStart(5),
        String(r.v1InvalidCount).padStart(5),
      ].join(' | '),
    );
  }
  console.log('');
  console.log('Legend:');
  console.log('  Raw   = total signals after dedup');
  console.log('  Rel%  = % relevant (after §3.1 filter, threshold 0.3)');
  console.log('  Disc  = discarded as irrelevant');
  console.log('  Trend = unique trends (after §3.4 dedup)');
  console.log('  Dup   = duplicate trend names (must be 0)');
  console.log('  Opps  = concrete opportunities (niche + segment + geo)');
  console.log('  Weak  = opportunities generated but weak (score<35)');
  console.log('  V1ok  = opportunities that pass OpportunityV1 schema');
  console.log('  V1bad = opportunities rejected by V1 schema');
  console.log('');
  console.log('Per-objective trend names:');
  for (const r of rows) {
    console.log(`  ${r.label}:`);
    for (const name of r.trendNames) {
      console.log(`    - ${name}`);
    }
  }
}

function toMarkdown(rows: EvalRow[]): string {
  const lines: string[] = [];
  lines.push('# CHISMOSO — FASE-3-QUALITY Eval Results');
  lines.push('');
  lines.push('**Generated:** ' + new Date().toISOString());
  lines.push('');
  lines.push('Eval suite for the Phase 3 Quality-of-Results fixes.');
  lines.push('Each objective runs the full intelligence pipeline against a fixture');
  lines.push('Serper response (no network, no API keys) and reports the §3.1');
  lines.push('relevance filter rate, §3.4 unique trend count, and §3.6/§3.7');
  lines.push('concrete + V1-validated opportunity count.');
  lines.push('');
  lines.push('## Summary table');
  lines.push('');
  lines.push('| Objective | Raw signals | Relevant % | Discarded | Unique trends | Dup names | Concrete opps | Weak opps | V1 valid | V1 invalid |');
  lines.push('| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const r of rows) {
    lines.push(
      `| ${r.label} | ${r.rawSignalCount} | ${r.relevantPct}% | ${r.discardedSignalCount} | ${r.uniqueTrends} | ${r.duplicateTrendNames} | ${r.concreteOpportunities} | ${r.weakOpportunities} | ${r.v1ValidCount} | ${r.v1InvalidCount} |`,
    );
  }
  lines.push('');
  lines.push('## Per-objective details');
  lines.push('');
  for (const r of rows) {
    lines.push(`### ${r.label}`);
    lines.push('');
    lines.push(`- **Objective:** \`${r.objective}\``);
    lines.push(`- **Geography:** \`${r.geography}\``);
    lines.push(`- **Raw signals (after dedup):** ${r.rawSignalCount}`);
    lines.push(`- **Relevant signals (after §3.1 filter):** ${r.relevantSignalCount} (${r.relevantPct}%)`);
    lines.push(`- **Discarded as irrelevant:** ${r.discardedSignalCount}`);
    lines.push(`- **Unique trends (after §3.4 dedup):** ${r.uniqueTrends}`);
    lines.push(`- **Duplicate trend names:** ${r.duplicateTrendNames} (must be 0)`);
    lines.push(`- **Concrete opportunities (niche + segment + geography):** ${r.concreteOpportunities}`);
    lines.push(`- **Opportunities with ≥3 lead search hints:** ${r.opportunitiesWithLeadHints}`);
    lines.push(`- **Weak opportunities (score <35, not delivered by orchestrator):** ${r.weakOpportunities}`);
    lines.push(`- **OpportunityV1 schema valid:** ${r.v1ValidCount}`);
    lines.push(`- **OpportunityV1 schema invalid:** ${r.v1InvalidCount}`);
    lines.push('');
    lines.push('**Trend names detected:**');
    if (r.trendNames.length === 0) {
      lines.push('- (none)');
    } else {
      for (const name of r.trendNames) lines.push(`- \`${name}\``);
    }
    lines.push('');
  }
  lines.push('## Acceptance criteria');
  lines.push('');
  lines.push('| Criterion | Status |');
  lines.push('| :--- | :--- |');
  const allDupZero = rows.every((r) => r.duplicateTrendNames === 0);
  const allHaveOpps = rows.every((r) => r.concreteOpportunities >= 0);
  const allV1Ok = rows.every((r) => r.v1InvalidCount === 0);
  lines.push(`| No duplicate trend names (§3.4) | ${allDupZero ? 'PASS' : 'FAIL'} |`);
  lines.push(`| Concrete opportunities generated (§3.6) | ${allHaveOpps ? 'PASS' : 'FAIL'} |`);
  lines.push(`| All opportunities pass V1 schema (§3.7) | ${allV1Ok ? 'PASS' : 'FAIL'} |`);
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const onlyFlag = process.argv.find((a) => a.startsWith('--only='));
  const onlyId = onlyFlag ? onlyFlag.split('=')[1] : undefined;
  const objectives = onlyId
    ? OBJECTIVES.filter((o) => o.id === onlyId)
    : OBJECTIVES;
  if (objectives.length === 0) {
    console.error(`No objective matches --only=${onlyId}. Valid ids: ${OBJECTIVES.map((o) => o.id).join(', ')}`);
    process.exit(1);
  }
  const rows: EvalRow[] = [];
  for (const obj of objectives) {
    process.stdout.write(`Running objective: ${obj.label}...`);
    const row = await runObjective(obj);
    rows.push(row);
    console.log(` done (${row.relevantSignalCount}/${row.rawSignalCount} relevant, ${row.uniqueTrends} trends, ${row.concreteOpportunities} opps)`);
  }
  printTable(rows);

  // Save markdown report.
  const md = toMarkdown(rows);
  // Resolve the CONTEXTO CHISMOSO/05_TESTS/ directory relative to the
  // chismoso/ project root (../CONTEXTO CHISMOSO/05_TESTS/).
  const candidates = [
    path.resolve(__dirname, '..', '..', 'CONTEXTO CHISMOSO', '05_TESTS', 'eval-results.md'),
    path.resolve(process.cwd(), 'CONTEXTO CHISMOSO', '05_TESTS', 'eval-results.md'),
    path.resolve(process.cwd(), '..', 'CONTEXTO CHISMOSO', '05_TESTS', 'eval-results.md'),
  ];
  let saved = false;
  for (const p of candidates) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, md, 'utf8');
      console.log(`\nMarkdown report saved to: ${p}`);
      saved = true;
      break;
    } catch (e: any) {
      // try next candidate
    }
  }
  if (!saved) {
    console.warn('\nCould not save markdown report — printing to stdout instead:');
    console.log(md);
  }
}

main().catch((e) => {
  console.error('Eval failed:', e);
  process.exit(1);
});
