import { normalizeRawItem } from '../src/intelligence/normalizer.js';
import { filterRelevant } from '../src/intelligence/relevance.js';
import { clusterSignalsAuto } from '../src/intelligence/clustering.js';
import { detectTrend } from '../src/intelligence/trends.js';
import { detectProblem } from '../src/intelligence/problems.js';
import { generateOpportunity } from '../src/intelligence/opportunities.js';
import { SourceType } from '../src/models.js';
import fs from 'node:fs';
import path from 'node:path';

const fixturePath = path.resolve('tests/fixtures/serper-dog-collars-peru.json');
const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
const items = raw.organic.map((r: any, idx: number) => ({
  providerName: 'web_search',
  sourceType: SourceType.SEARCH_WEB,
  title: r.title ?? '',
  snippet: r.snippet ?? '',
  url: r.link ?? '',
  hostName: '',
  date: r.date ?? '',
  rawMetadata: { rank: idx + 1 },
}));
const objective = 'Collares para perros en Perú';
const geography = 'Perú';
const normalized = items.map((it: any) => normalizeRawItem(it, { topic: objective, geography, objective }));
let signals = normalized.map((n: any) => n.signal);
const evidence = normalized.map((n: any) => n.evidence);
const filterResult = filterRelevant(signals, { objective, geography });
console.log('total:', signals.length, 'relevant:', filterResult.relevant.length, 'discarded:', filterResult.discarded);
signals = filterResult.relevant;
const { clusters } = await clusterSignalsAuto(signals, {});
for (const c of clusters) {
  const sigs = c.signalIds.map((sid) => signals.find((s) => s.id === sid)).filter(Boolean) as any[];
  const ev = evidence.filter((e: any) => sigs.some((s: any) => s.url === e.url));
  const { trend } = detectTrend({ topic: c.canonical, canonical: c.canonical, signals: sigs, evidence: ev });
  const { problem } = detectProblem({ topic: c.canonical, canonical: c.canonical, signals: sigs, evidence: ev });
  console.log(`cluster ${c.canonical} sigs=${sigs.length} trend=${trend.state}/${trend.score} problem=${problem ? 'detected' : 'null'}`);
  if (problem) {
    const r = generateOpportunity({ trend, problem, signals: sigs, evidence: ev, geography, objective });
    console.log(`  opp: weak=${r.weak} v1=${r.v1 ? 'ok' : 'null'} v1Err=${r.v1Error?.slice(0, 80)}`);
  }
}
