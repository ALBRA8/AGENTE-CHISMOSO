/**
 * CHISMOSO V1.0 — Report Engine (secciones 27 y 28)
 *
 * Convierte una investigación en dos formatos:
 *   1. Human-readable (markdown): legible para usuarios.
 *   2. Machine-readable (JSON): consumible por otros agentes.
 *
 * Regla: separar OBSERVED / DERIVED / INFERRED / PREDICTED / UNKNOWN
 * en toda afirmación importante.
 */

import type {
  Evidence,
  Investigation,
  IntelligenceReport,
  Opportunity,
  Problem,
  Signal,
  Trend,
} from '../models.js';
import { nowISO, TruthLevel } from '../models.js';

export interface ReportInput {
  investigation: Investigation;
  signals: Signal[];
  evidence: Evidence[];
  trends: Trend[];
  problems: Problem[];
  opportunities: Opportunity[];
}

export interface ReportOutput {
  machine: IntelligenceReport;
  markdown: string;
}

export function buildReport(input: ReportInput): ReportOutput {
  const { investigation, signals, evidence, trends, problems, opportunities } = input;

  const overallConfidence = computeOverallConfidence(trends, problems, opportunities);
  const limitations = computeLimitations(investigation, signals, trends, problems);
  const recommendedNextAction = computeNextAction(opportunities, problems);
  const executiveSummary = computeExecutiveSummary(input, overallConfidence);

  const machine: IntelligenceReport = {
    query: investigation.query,
    scope: investigation.scope,
    generatedAt: nowISO(),
    executiveSummary,
    trends,
    problems,
    opportunities,
    signals,
    evidence,
    overallConfidence,
    limitations,
    recommendedNextAction,
    investigationId: investigation.id,
    providersUsed: investigation.providersUsed,
  };

  const markdown = renderMarkdown(machine);
  return { machine, markdown };
}

// ---------------------------------------------------------------------------
// COMPONENTS
// ---------------------------------------------------------------------------

function computeOverallConfidence(trends: Trend[], problems: Problem[], opportunities: Opportunity[]): number {
  const parts: number[] = [];
  for (const t of trends) parts.push(t.confidence);
  for (const p of problems) parts.push(p.confidence);
  for (const o of opportunities) parts.push(o.confidence);
  if (parts.length === 0) return 0;
  const avg = parts.reduce((a, b) => a + b, 0) / parts.length;
  return Math.round(avg * 100) / 100;
}

function computeLimitations(inv: Investigation, signals: Signal[], trends: Trend[], problems: Problem[]): string[] {
  const out: string[] = [];
  if (signals.length === 0) out.push('No signals collected — investigation could not gather evidence.');
  if (signals.length > 0 && signals.length < 5) out.push(`Only ${signals.length} signals collected — findings are exploratory, not conclusive.`);
  if (inv.providersUsed.length === 1) out.push(`Only one provider was used (${inv.providersUsed[0]}). Cross-source confirmation is weak.`);
  if (!inv.providersUsed.includes('web_search')) out.push('web_search provider was not used.');
  if (!inv.providersUsed.includes('reddit_communities')) out.push('Community sources (reddit/quora) were not queried — problem detection may be incomplete.');
  if (inv.errors.length > 0) out.push(`Investigation encountered ${inv.errors.length} errors.`);
  if (trends.length === 0) out.push('No trends detected — evidence did not meet the trend detection threshold.');
  if (problems.length === 0) out.push('No problems detected — either no friction exists or the threshold (>=2 distinct friction signals) was not reached.');
  // GoogleTrendsProvider is registered but always UNAVAILABLE in V1.
  out.push('GoogleTrendsProvider is UNAVAILABLE in V1 — search-trend signals are missing.');
  return out;
}

function computeNextAction(opportunities: Opportunity[], problems: Problem[]): string {
  if (opportunities.length === 0 && problems.length === 0) {
    return 'No actionable opportunities or problems detected. Consider expanding the scope, changing geography, or re-running with a more specific objective.';
  }
  if (opportunities.length === 0) {
    return 'Problems were detected but no opportunity was generated. Consider deepening investigation on the strongest problem with `deepen_content` and re-running.';
  }
  const top = opportunities[0];
  return `Hand off Opportunity "${top.title}" (score ${top.score}/100, confidence ${top.confidence}) to ${top.suggestedNextAgent}. Consider deepening evidence around: ${top.problem.slice(0, 120)}.`;
}

function computeExecutiveSummary(input: ReportInput, confidence: number): string {
  const { investigation, trends, problems, opportunities, signals } = input;
  const trendCounts = summarizeTrendStates(trends);
  return `Investigation "${investigation.query}" ran with ${investigation.providersUsed.length} providers (${investigation.providersUsed.join(', ')}), produced ${signals.length} signals across ${trends.length} detected trends, ${problems.length} problems and ${opportunities.length} opportunities. Overall confidence: ${Math.round(confidence * 100)}%. Trend distribution: ${trendCounts || 'none'}. Status: ${investigation.status}.`;
}

function summarizeTrendStates(trends: Trend[]): string {
  if (trends.length === 0) return '';
  const m = new Map<string, number>();
  for (const t of trends) m.set(t.state, (m.get(t.state) ?? 0) + 1);
  return Array.from(m.entries()).map(([k, v]) => `${k}=${v}`).join(', ');
}

// ---------------------------------------------------------------------------
// MARKDOWN RENDERER
// ---------------------------------------------------------------------------

function renderMarkdown(r: IntelligenceReport): string {
  const L: string[] = [];
  L.push(`# CHISMOSO INTELLIGENCE REPORT`);
  L.push('');
  L.push(`**Investigation ID:** \`${r.investigationId}\``);
  L.push(`**Generated at:** ${r.generatedAt}`);
  L.push(`**Providers used:** ${r.providersUsed.join(', ') || '—'}`);
  L.push('');
  L.push(`## Question`);
  L.push(r.query);
  L.push('');
  L.push(`## Resumen ejecutivo`);
  L.push(r.executiveSummary);
  L.push('');
  L.push(`## Confidence`);
  L.push(`- Overall confidence: **${Math.round(r.overallConfidence * 100)}%**`);
  L.push('');
  L.push(`## Tendencias detectadas (${r.trends.length})`);
  if (r.trends.length === 0) L.push('_(none)_');
  for (let i = 0; i < r.trends.length; i++) {
    const t = r.trends[i];
    L.push('');
    L.push(`### ${i + 1}. ${t.topic}`);
    L.push(`- State: **${t.state}**`);
    L.push(`- Confidence: ${Math.round(t.confidence * 100)}%`);
    L.push(`- Score: ${t.score}/100`);
    L.push(`- Sources: ${t.sourcesCount} (signal types: ${t.signalsCount})`);
    L.push(`- Growth: ${t.growth} · Velocity: ${t.velocity} · Persistence: ${t.persistence} · Cross-source: ${t.crossSourceConfirmation}`);
    L.push(`- First seen: ${t.firstSeen}`);
    L.push(`- Last seen: ${t.lastSeen}`);
    if (t.scoreBreakdown) {
      L.push(`- Breakdown: ${Object.entries(t.scoreBreakdown).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }
    L.push(`- TruthLevel: ${TruthLevel.OBSERVED} (signals from real providers)`);
    if (t.evidence.length > 0) {
      L.push(`- Evidence (top ${Math.min(3, t.evidence.length)}):`);
      for (const e of t.evidence.slice(0, 3)) {
        L.push(`    - [${e.evidenceType}] ${e.source} — ${truncate(e.rawValue, 140)} (${e.url ?? 'no url'})`);
      }
    }
  }

  L.push('');
  L.push(`## Problemas emergentes (${r.problems.length})`);
  if (r.problems.length === 0) L.push('_(none)_');
  for (let i = 0; i < r.problems.length; i++) {
    const p = r.problems[i];
    L.push('');
    L.push(`### ${i + 1}. ${truncate(p.description.split('.')[0], 100)}`);
    L.push(`- Severity: ${p.severity}/100`);
    L.push(`- Frequency: ${p.frequency}/100`);
    L.push(`- Confidence: ${Math.round(p.confidence * 100)}%`);
    L.push(`- Segments affected: ${p.segmentsAffected.join(', ') || 'unspecified'}`);
    L.push(`- First seen: ${p.firstSeen}`);
    L.push(`- Last seen: ${p.lastSeen}`);
    if (p.evidence.length > 0) {
      L.push(`- Evidence (top ${Math.min(3, p.evidence.length)}):`);
      for (const e of p.evidence.slice(0, 3)) {
        L.push(`    - [${e.evidenceType}] ${e.source} — ${truncate(e.rawValue, 140)} (${e.url ?? 'no url'})`);
      }
    }
  }

  L.push('');
  L.push(`## Oportunidades (${r.opportunities.length})`);
  if (r.opportunities.length === 0) L.push('_(none)_');
  for (let i = 0; i < r.opportunities.length; i++) {
    const o = r.opportunities[i];
    L.push('');
    L.push(`### Opportunity #${i + 1}: ${o.title}`);
    L.push(`**Score: ${o.score}/100** · Confidence: ${Math.round(o.confidence * 100)}%`);
    L.push('');
    L.push(`**Description:** ${o.description}`);
    L.push('');
    L.push(`- Problem: ${o.problem}`);
    L.push(`- Target segment: ${o.targetSegment}`);
    L.push(`- Geography: ${o.geography}`);
    L.push(`- Why now: ${o.timing}/100`);
    L.push(`- Demand: ${o.demand}/100 · Growth: ${o.growth}/100`);
    L.push(`- Monetization: ${o.monetization}/100 · Market fit: ${o.marketFit}/100`);
    L.push(`- Competition: ${o.competition}/100 · Uncertainty: ${o.uncertainty}/100`);
    L.push(`- Suggested next agent: **${o.suggestedNextAgent}**`);
    L.push(`- TruthLevel: ${TruthLevel.DERIVED} (synthesis from observed signals and detected trend/problem)`);
    if (o.scoreBreakdown) {
      L.push(`- Score breakdown: ${Object.entries(o.scoreBreakdown).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }
    if (o.evidence.length > 0) {
      L.push(`- Evidence (top ${Math.min(5, o.evidence.length)}):`);
      for (const e of o.evidence.slice(0, 5)) {
        L.push(`    - [${e.evidenceType}] ${e.source} — ${truncate(e.rawValue, 160)} (${e.url ?? 'no url'})`);
      }
    }
  }

  L.push('');
  L.push(`## Signals (${r.signals.length})`);
  L.push(`_See attached machine-readable JSON for full signal list._`);

  L.push('');
  L.push(`## Sources (${r.evidence.length} evidence items)`);
  const bySource = new Map<string, number>();
  for (const e of r.evidence) bySource.set(e.source, (bySource.get(e.source) ?? 0) + 1);
  for (const [src, count] of bySource.entries()) L.push(`- ${src}: ${count} items`);

  L.push('');
  L.push(`## Limitations`);
  for (const lim of r.limitations) L.push(`- ${lim}`);

  L.push('');
  L.push(`## Recommended next action`);
  L.push(r.recommendedNextAction);

  return L.join('\n');
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
