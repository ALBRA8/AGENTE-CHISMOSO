/**
 * FIX-1 verification — minimal version.
 *
 * Verifies the three things the audit flagged as broken:
 *   1. clusterSignalsAuto() picks SEMANTIC strategy when given
 *      >= 8 signals + a DB + an embedding client.
 *   2. After the call, signal_embeddings table is populated.
 *   3. semanticSearch() against the same DB returns non-empty results.
 *
 * This is a smoke script (not a vitest suite). Mirrors the in-process
 * shape of an orchestrator post-collection step.
 *
 * Run: `cd /home/z/my-project/chismoso && npx tsx scripts/verify-fix-1.ts`
 */
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import {
  SignalType,
  SourceType,
  TruthLevel,
  type Signal,
} from '../src/models.js';
import { EmbeddingClient } from '../src/intelligence/embeddings.js';
import {
  clusterSignalsAuto,
  MIN_SIGNALS_FOR_SEMANTIC,
} from '../src/intelligence/clustering.js';
import {
  ensureEmbeddingsSchema,
  loadAllEmbeddings,
} from '../src/db-extensions/embeddings.sql.js';
// Imported lazily (see step 3) to avoid module-load-time interactions with
// better-sqlite3 + tsx that cause a teardown crash on this machine.
// const semanticSearch = (await import('../src/intelligence/semantic-search.js')).semanticSearch;

const FAILURES: string[] = [];
function pass(m: string) { console.log('  ✓ ' + m); }
function fail(m: string) { console.error('  ✗ ' + m); FAILURES.push(m); }

function makeSignal(id: string, topic: string, keyword: string, snippet: string): Signal {
  return {
    id,
    topic,
    keyword,
    source: 'web_search',
    sourceType: SourceType.SEARCH_WEB,
    timestamp: new Date().toISOString(),
    geography: 'global',
    metric: 'count',
    value: 1,
    normalizedValue: 1,
    direction: 'up',
    velocity: 0,
    confidence: 0.7,
    evidenceType: TruthLevel.OBSERVED,
    signalType: SignalType.MENTION_SPIKE,
    metadata: {},
    rawSnippet: snippet,
  };
}

async function main(): Promise<number> {
  // 10 fake signals — 3 thematic groups (WhatsApp reservas, email
  // marketing, crypto payments). Each group has 3-4 signals.
  const signals: Signal[] = [
    makeSignal('sig_wa_1', 'reservas por whatsapp', 'whatsapp',
      'Estoy buscando una forma de gestionar las reservas por WhatsApp de mi restaurante sin tener que responder cada mensaje manualmente.'),
    makeSignal('sig_wa_2', 'whatsapp reservas', 'reservas',
      'How to set up WhatsApp reservations for a restaurant — agendar mesa por WhatsApp sin perder reservas.'),
    makeSignal('sig_wa_3', 'agendar mesa whatsapp', 'agendar',
      'Automatizar agendamiento de mesas por WhatsApp: el cliente escribe y el bot confirma la reserva.'),
    makeSignal('sig_wa_4', 'whatsapp restaurant booking', 'booking',
      'WhatsApp restaurant booking automation tools compared — reservations confirmed automatically.'),
    makeSignal('sig_em_1', 'email marketing small business', 'email',
      'Best email marketing tools for small business — newsletter sequences that convert.'),
    makeSignal('sig_em_2', 'newsletter automation shopify', 'newsletter',
      'Setting up newsletter automation in Shopify — welcome flows + abandoned cart emails.'),
    makeSignal('sig_em_3', 'email campaign tips', 'campaign',
      'Email campaign tips for ecommerce — segmentation, A/B testing, drip sequences.'),
    makeSignal('sig_cr_1', 'crypto payments store', 'crypto',
      'How to accept crypto payments in my online store with bitcoin and stablecoins.'),
    makeSignal('sig_cr_2', 'bitcoin checkout ecommerce', 'bitcoin',
      'Bitcoin checkout integrations for ecommerce — accept BTC, ETH, USDC at checkout.'),
    makeSignal('sig_cr_3', 'stablecoin payment gateway', 'stablecoin',
      'Stablecoin payment gateway for small merchants — settle in USDC with low fees.'),
  ];

  // Pre-warm the EmbeddingClient cache BEFORE opening the DB.
  // better-sqlite3's native Statement destructors crash on Node 22+ when
  // they're GC'd during async microtask checkpoints (see vitest.config.ts
  // for the codebase's own acknowledgement of this issue). By doing the
  // (synchronous-CPU) embedding work up-front, we ensure no Promise.all
  // microtasks run while DB Statements are pending collection.
  // The cache makes the later embedBatch calls inside clusterSignalsAuto
  // and clusterSignalsSemantic free.
  const embeddingClient = new EmbeddingClient();
  const warmTexts = signals.map(
    (s) => `${s.keyword} ${s.topic} ${s.rawSnippet.slice(0, 500)}`,
  );
  await embeddingClient.embedBatch(warmTexts);
  // Also pre-warm the shorter snippet form used by clusterSignalsSemantic.
  const warmTextsShort = signals.map(
    (s) => `${s.keyword} ${s.topic} ${s.rawSnippet.slice(0, 200)}`,
  );
  await embeddingClient.embedBatch(warmTextsShort);
  console.log('Pre-warmed embedding cache for ' + signals.length + ' signals.');

  const db: DB = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS signals (
      id                TEXT PRIMARY KEY,
      raw_snippet       TEXT,
      url               TEXT
    );
  `);
  for (const s of signals) {
    db.prepare('INSERT INTO signals (id, raw_snippet, url) VALUES (?, ?, ?)').run(
      s.id, s.rawSnippet, null,
    );
  }
  ensureEmbeddingsSchema(db);

  // -------------------------------------------------------------------
  // Step 1: clusterSignalsAuto picks SEMANTIC strategy.
  // -------------------------------------------------------------------
  console.log('\n[1/3] clusterSignalsAuto with ' + signals.length + ' signals (min for semantic = ' + MIN_SIGNALS_FOR_SEMANTIC + ')');
  // Reuse the pre-warmed embeddingClient so clusterSignalsAuto and the
  // clusterSignalsSemantic call inside it hit the cache.
  const result = await clusterSignalsAuto(signals, { db, embeddingClient });
  console.log('    strategy = ' + result.strategy);
  console.log('    reason   = ' + result.reason);
  console.log('    clusters = ' + result.clusters.length);
  if (result.strategy === 'semantic') pass('picked semantic strategy');
  else fail('expected semantic, got ' + result.strategy);
  if (result.clusters.length >= 1) pass('formed at least 1 cluster');
  else fail('expected at least 1 cluster, got 0');

  // -------------------------------------------------------------------
  // Step 2: signal_embeddings table now populated.
  // -------------------------------------------------------------------
  console.log('\n[2/3] signal_embeddings table populated');
  const stored = loadAllEmbeddings(db);
  console.log('    rows in signal_embeddings = ' + stored.length);
  if (stored.length === signals.length) pass('all ' + signals.length + ' signals have embeddings');
  else fail('expected ' + signals.length + ' embeddings, got ' + stored.length);

  // -------------------------------------------------------------------
  // Step 3: semanticSearch returns non-empty results.
  // -------------------------------------------------------------------
  console.log('\n[3/3] semanticSearch() returns non-empty results');
  const { semanticSearch } = await import('../src/intelligence/semantic-search.js');
  const results = await semanticSearch('restaurantes reservas whatsapp', { db, topK: 5 });
  console.log('    query: "restaurantes reservas whatsapp"');
  for (const r of results) {
    console.log('       -> ' + r.signalId + ' score=' + r.score.toFixed(3));
  }
  if (results.length > 0) pass('returned ' + results.length + ' result(s)');
  else fail('returned 0 results — embeddings pipeline broken');

  // -------------------------------------------------------------------
  // Summary.
  // -------------------------------------------------------------------
  console.log('\n================ SUMMARY ================');
  if (FAILURES.length === 0) {
    console.log('ALL ASSERTIONS PASSED');
    return 0;
  }
  console.error(FAILURES.length + ' ASSERTION(S) FAILED:');
  for (const f of FAILURES) console.error('  - ' + f);
  return 1;
}

main()
  .then((code) => {
    // Force exit to avoid better-sqlite3 + tsx teardown quirks.
    process.exit(code);
  })
  .catch((e) => {
    console.error('VERIFY CRASHED:', e);
    process.exit(2);
  });
