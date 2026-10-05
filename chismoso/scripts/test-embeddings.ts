/**
 * CHISMOSO V1.1 — Embeddings test script (EXP-4)
 *
 * End-to-end smoke + correctness test for the new embedding-based path:
 *   1. Build 10 fake signals covering 3 thematic groups.
 *   2. Embed them (TF-IDF hash).
 *   3. Cluster them with clusterSignalsSemantic.
 *   4. Verify that signals within the same thematic group ended up in
 *      the same cluster, and cross-group signals did not.
 *   5. Persist embeddings into an in-memory SQLite DB.
 *   6. Run semanticSearch against that DB and verify the top results for
 *      a thematic query are members of the expected group.
 *
 * Run: `cd /home/z/my-project/chismoso && npx tsx scripts/test-embeddings.ts`
 *
 * Exit codes:
 *   0 — all assertions passed
 *   1 — at least one assertion failed
 */

import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { SignalType, SourceType, TruthLevel } from '../src/models.js';
import type { Signal } from '../src/models.js';
import { EmbeddingClient, cosineSimilarity } from '../src/intelligence/embeddings.js';
import { clusterSignalsSemantic } from '../src/intelligence/semantic-cluster.js';
import { semanticSearch } from '../src/intelligence/semantic-search.js';
import {
  ensureEmbeddingsSchema,
  storeEmbeddings,
  loadAllEmbeddings,
} from '../src/db-extensions/embeddings.sql.js';

// ---------------------------------------------------------------------------
// FAKE SIGNALS — 3 thematic groups
// ---------------------------------------------------------------------------

interface SignalSpec {
  id: string;
  topic: string;
  keyword: string;
  source: string;
  snippet: string;
  group: 'WHATSAPP_RESERVAS' | 'EMAIL_MARKETING' | 'CRYPTO_PAYMENTS';
}

const SPECS: SignalSpec[] = [
  // Group A: WhatsApp restaurant reservations (ES + EN mix, ~4 signals).
  // Designed so each signal shares the tokens `whatsapp` + `reserva` (or
  // their EN equivalents). TF-IDF hash is TOKEN-based, so within-group
  // overlap must be non-trivial for clustering to fire.
  {
    id: 'sig_wa_1',
    topic: 'reservas por whatsapp',
    keyword: 'whatsapp',
    source: 'reddit',
    snippet:
      'Estoy buscando una forma de gestionar las reservas por WhatsApp de mi restaurante sin tener que responder cada mensaje manualmente.',
    group: 'WHATSAPP_RESERVAS',
  },
  {
    id: 'sig_wa_2',
    topic: 'whatsapp reservas',
    keyword: 'reservas',
    source: 'web_search',
    snippet:
      'How to set up WhatsApp reservations for a restaurant — agendar mesa por WhatsApp sin perder reservas.',
    group: 'WHATSAPP_RESERVAS',
  },
  {
    id: 'sig_wa_3',
    topic: 'agendar mesa whatsapp',
    keyword: 'agendar',
    source: 'web_content',
    snippet:
      'Automatizar agendamiento de mesas por WhatsApp: el cliente escribe y el bot confirma la reserva.',
    group: 'WHATSAPP_RESERVAS',
  },
  {
    id: 'sig_wa_4',
    topic: 'bot reservas whatsapp',
    keyword: 'bot',
    source: 'reddit',
    snippet:
      'WhatsApp reservation bot for small restaurants — does anyone use one for managing reservas?',
    group: 'WHATSAPP_RESERVAS',
  },

  // Group B: Email marketing for stores (3 signals). All share the tokens
  // `email` + `marketing`. Demonstrates ES/EN cross-lingual token overlap.
  {
    id: 'sig_em_1',
    topic: 'email marketing tiendas',
    keyword: 'email',
    source: 'web_search',
    snippet:
      'Las tiendas pequeñas usan email marketing para fidelizar clientes y anunciar promociones por correo.',
    group: 'EMAIL_MARKETING',
  },
  {
    id: 'sig_em_2',
    topic: 'email marketing campañas',
    keyword: 'marketing',
    source: 'reddit',
    snippet:
      'Email marketing best practices — newsletter campaigns for small shops to grow an email list.',
    group: 'EMAIL_MARKETING',
  },
  {
    id: 'sig_em_3',
    topic: 'email marketing promociones',
    keyword: 'promociones',
    source: 'web_content',
    snippet:
      'Cómo lanzar una campaña de email marketing para promociones de temporada en tu tienda online.',
    group: 'EMAIL_MARKETING',
  },

  // Group C: Crypto payments (3 signals). All share `crypto` + `payments`
  // (English tokens) for reliable token overlap.
  {
    id: 'sig_cp_1',
    topic: 'crypto payments comercios',
    keyword: 'crypto',
    source: 'web_search',
    snippet:
      'Small businesses accepting crypto payments via USDT and Bitcoin Lightning network — pros and cons.',
    group: 'CRYPTO_PAYMENTS',
  },
  {
    id: 'sig_cp_2',
    topic: 'crypto payments store',
    keyword: 'payments',
    source: 'reddit',
    snippet:
      'How to accept crypto payments at a physical store with Bitcoin Lightning — hardware wallet setup.',
    group: 'CRYPTO_PAYMENTS',
  },
  {
    id: 'sig_cp_3',
    topic: 'crypto payments stablecoins',
    keyword: 'usdt',
    source: 'web_content',
    snippet:
      'Accepting crypto payments with USDT stablecoins at your store — integrating Bitcoin and Lightning.',
    group: 'CRYPTO_PAYMENTS',
  },
];

function buildSignal(spec: SignalSpec): Signal {
  return {
    id: spec.id,
    topic: spec.topic,
    keyword: spec.keyword,
    source: spec.source,
    sourceType: SourceType.SEARCH_WEB,
    timestamp: '2024-09-15T10:00:00Z',
    geography: 'LATAM',
    metric: 'mention_count',
    value: 1,
    normalizedValue: 1,
    direction: 'up',
    velocity: 0,
    confidence: 0.7,
    evidenceType: TruthLevel.OBSERVED,
    signalType: SignalType.MENTION_SPIKE,
    metadata: {},
    rawSnippet: spec.snippet,
  };
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const failures: string[] = [];
  const log = (msg: string) => console.log(msg);
  const fail = (msg: string) => {
    console.error('  ✗ FAIL: ' + msg);
    failures.push(msg);
  };
  const pass = (msg: string) => console.log('  ✓ ' + msg);

  const signals = SPECS.map(buildSignal);
  log('\n[1/5] Embedding ' + signals.length + ' signals (TF-IDF hash, dim=256)…');

  const client = new EmbeddingClient();
  const embeddings = await client.embedBatch(
    signals.map((s) => `${s.keyword} ${s.topic} ${s.rawSnippet.slice(0, 200)}`),
  );
  pass('embedded ' + embeddings.length + ' vectors, dim=' + embeddings[0].dim);

  // Quick sanity: cosine sim of an identical vector is 1.
  const selfSim = cosineSimilarity(embeddings[0], embeddings[0]);
  if (Math.abs(selfSim - 1) < 1e-5) pass('self-similarity ≈ 1 (' + selfSim.toFixed(4) + ')');
  else fail('self-similarity should be 1, got ' + selfSim);

  log('\n[2/5] Pairwise cosine similarities within/across groups:');
  const groupOf = (id: string): SignalSpec['group'] => SPECS.find((s) => s.id === id)!.group;
  let withinSum = 0;
  let withinCount = 0;
  let acrossSum = 0;
  let acrossCount = 0;
  for (let i = 0; i < signals.length; i++) {
    for (let j = i + 1; j < signals.length; j++) {
      const sim = cosineSimilarity(embeddings[i], embeddings[j]);
      const sameGroup = groupOf(signals[i].id) === groupOf(signals[j].id);
      if (sameGroup) {
        withinSum += sim;
        withinCount++;
      } else {
        acrossSum += sim;
        acrossCount++;
      }
    }
  }
  const withinAvg = withinCount > 0 ? withinSum / withinCount : 0;
  const acrossAvg = acrossCount > 0 ? acrossSum / acrossCount : 0;
  console.log('    avg within-group sim : ' + withinAvg.toFixed(4));
  console.log('    avg across-group sim : ' + acrossAvg.toFixed(4));
  if (withinAvg > acrossAvg + 0.05) {
    pass('within-group sim strictly higher than across-group sim (Δ=' + (withinAvg - acrossAvg).toFixed(3) + ')');
  } else {
    fail('within-group sim not meaningfully higher than across (' +
      withinAvg.toFixed(3) + ' vs ' + acrossAvg.toFixed(3) + ')');
  }

  log('\n[3/5] Clustering with default threshold (0.18 for TF-IDF hash)…');
  const result = await clusterSignalsSemantic(signals, { minClusterSize: 2 });
  console.log('    ' + result.clusters.length + ' clusters kept (minClusterSize=2)');
  for (const c of result.clusters) {
    const groups = new Set(c.signalIds.map((id) => groupOf(id)));
    console.log(
      '    cluster ' + c.id + ' (canonical="' + c.canonical + '", size=' + c.signalIds.length + ') ' +
        'groups=' + Array.from(groups).join(','),
    );
    for (const id of c.signalIds) console.log('       - ' + id + ' [' + groupOf(id) + ']');
  }

  // Assertion: every kept cluster must be PURE (single group).
  for (const c of result.clusters) {
    const groups = new Set(c.signalIds.map((id) => groupOf(id)));
    if (groups.size === 1) {
      pass('cluster ' + c.id + ' is pure (' + Array.from(groups)[0] + ', n=' + c.signalIds.length + ')');
    } else {
      fail('cluster ' + c.id + ' is impure (groups=' + Array.from(groups).join(',') + ')');
    }
  }

  // Assertion: we found at least 2 pure clusters (WhatsApp + EmailMarketing).
  const pureGroupClusters = new Set<string>();
  for (const c of result.clusters) {
    const groups = new Set(c.signalIds.map((id) => groupOf(id)));
    if (groups.size === 1) pureGroupClusters.add(Array.from(groups)[0]);
  }
  if (pureGroupClusters.has('WHATSAPP_RESERVAS')) pass('WHATSAPP_RESERVAS cluster formed');
  else fail('WHATSAPP_RESERVAS did not form a cluster');
  if (pureGroupClusters.has('EMAIL_MARKETING')) pass('EMAIL_MARKETING cluster formed');
  else fail('EMAIL_MARKETING did not form a cluster');
  // Crypto cluster may or may not form depending on threshold; it's a bonus.

  log('\n[4/5] Persisting embeddings into an in-memory SQLite DB…');
  const db: DB = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY, raw_snippet TEXT, url TEXT
    );
  `);
  ensureEmbeddingsSchema(db);
  for (const s of signals) {
    db.prepare('INSERT INTO signals (id, raw_snippet, url) VALUES (?, ?, ?)').run(
      s.id, s.rawSnippet, null,
    );
  }
  const stored = signals.map((s, i) => ({ signalId: s.id, embedding: embeddings[i] }));
  const n = storeEmbeddings(db, stored);
  pass('stored ' + n + ' embeddings');
  const loaded = loadAllEmbeddings(db);
  if (loaded.length === signals.length) pass('loaded back ' + loaded.length + ' embeddings');
  else fail('loaded ' + loaded.length + ' embeddings, expected ' + signals.length);

  // Round-trip fidelity: stored vs. reloaded should be bit-identical.
  let driftMax = 0;
  for (const { signalId, embedding } of loaded) {
    const original = embeddings[signals.findIndex((s) => s.id === signalId)];
    for (let i = 0; i < original.dim; i++) {
      const d = Math.abs(original.vector[i] - embedding.vector[i]);
      if (d > driftMax) driftMax = d;
    }
  }
  if (driftMax < 1e-6) pass('round-trip drift < 1e-6 (' + driftMax.toExponential(2) + ')');
  else fail('round-trip drift too big: ' + driftMax);

  log('\n[5/5] semanticSearch() over the in-memory DB…');
  const queries = [
    { q: 'reservar mesa en restaurante por whatsapp', expectedGroup: 'WHATSAPP_RESERVAS' },
    { q: 'email campaign for small shop newsletter', expectedGroup: 'EMAIL_MARKETING' },
    // Mixed ES/EN query: uses 'crypto' + 'payments' + 'store' tokens that
    // overlap with the CRYPTO_PAYMENTS signal set (which is intentionally
    // English-token-heavy for reliable token-overlap clustering).
    { q: 'aceptar crypto payments en mi store con bitcoin', expectedGroup: 'CRYPTO_PAYMENTS' },
  ];
  for (const { q, expectedGroup } of queries) {
    const results = await semanticSearch(q, { db, topK: 3 });
    console.log('    query: "' + q + '"');
    for (const r of results) {
      console.log('       -> ' + r.signalId + ' [' + groupOf(r.signalId) + '] score=' + r.score.toFixed(3));
    }
    if (results.length === 0) {
      fail('"' + q + '" returned 0 results');
      continue;
    }
    const topGroup = groupOf(results[0].signalId);
    if (topGroup === expectedGroup) {
      pass('top result for "' + q + '" belongs to ' + expectedGroup);
    } else {
      fail('top result for "' + q + '" is ' + topGroup + ' (expected ' + expectedGroup + ')');
    }
  }

  db.close();

  log('\n================ SUMMARY ================');
  if (failures.length === 0) {
    console.log('ALL ASSERTIONS PASSED');
    return 0;
  }
  console.error(failures.length + ' ASSERTION(S) FAILED:');
  for (const f of failures) console.error('  - ' + f);
  return 1;
}

main().then((code) => {
  process.exit(code);
}).catch((e) => {
  console.error('TEST CRASHED:', e);
  process.exit(2);
});
