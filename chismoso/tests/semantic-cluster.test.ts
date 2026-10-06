/**
 * Unit tests — Semantic clustering + embedding math (Task EXP-4)
 *
 * Verifies:
 *   - clusterSignalsSemantic: empty input, identical signals, unrelated signals, mix.
 *   - cosineSimilarity: identical / orthogonal / opposite vectors.
 *   - semanticSearch: empty DB, seeded DB top-K similarity ranking.
 *
 * All tests use the local TF-IDF hash embedding (default EmbeddingClient) — no
 * network calls, deterministic, sub-ms per embed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChismosoDB } from '../src/db.js';
import {
  EmbeddingClient,
  cosineSimilarity,
  type EmbeddingVector,
} from '../src/intelligence/embeddings.js';
import {
  clusterSignalsSemantic,
} from '../src/intelligence/semantic-cluster.js';
import {
  semanticSearch,
} from '../src/intelligence/semantic-search.js';
import {
  ensureEmbeddingsSchema,
  storeEmbedding,
} from '../src/db-extensions/embeddings.sql.js';
import { SignalType, SourceType, TruthLevel } from '../src/models.js';
import type { Signal } from '../src/models.js';

// ---------------------------------------------------------------------------
// FACTORIES
// ---------------------------------------------------------------------------

let signalSeq = 0;
function mkSignal(snippet: string, topic = 't', keyword?: string): Signal {
  signalSeq++;
  return {
    id: `sig_sem_${signalSeq}`,
    topic,
    keyword: keyword ?? snippet.split(' ')[0],
    source: 'web_search',
    sourceType: SourceType.SEARCH_WEB,
    timestamp: new Date().toISOString(),
    geography: 'global',
    metric: 'mention_count',
    value: 1,
    normalizedValue: 1,
    direction: 'up',
    velocity: 0,
    confidence: 0.5,
    evidenceType: TruthLevel.OBSERVED,
    signalType: SignalType.MENTION_SPIKE,
    metadata: {},
    rawSnippet: snippet,
  };
}

function mkVector(values: number[]): EmbeddingVector {
  return {
    vector: new Float32Array(values),
    dim: values.length,
    model: 'tfidf-hash-v1',
  };
}

// ---------------------------------------------------------------------------
// cosineSimilarity (pure math)
// ---------------------------------------------------------------------------

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const a = mkVector([1, 0, 0, 0]);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 6);
  });

  it('returns 0.0 for orthogonal vectors', () => {
    const a = mkVector([1, 0, 0]);
    const b = mkVector([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 6);
  });

  it('returns -1.0 for opposite vectors', () => {
    const a = mkVector([1, 0, 0]);
    const b = mkVector([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 6);
  });

  it('returns 0 when either vector is zero-length (all zeros)', () => {
    const a = mkVector([0, 0, 0]);
    const b = mkVector([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('throws on dimension mismatch', () => {
    const a = mkVector([1, 2, 3]);
    const b = mkVector([1, 2]);
    expect(() => cosineSimilarity(a, b)).toThrow(/dimension mismatch/);
  });

  it('matches the textbook cosine formula for a known pair', () => {
    // [1,2,3] · [4,5,6] = 4+10+18 = 32
    // |a| = sqrt(14) ≈ 3.7417, |b| = sqrt(77) ≈ 8.7750
    // cos = 32 / (3.7417 * 8.7750) ≈ 0.9746
    const a = mkVector([1, 2, 3]);
    const b = mkVector([4, 5, 6]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(32 / (Math.sqrt(14) * Math.sqrt(77)), 5);
  });
});

// ---------------------------------------------------------------------------
// clusterSignalsSemantic
// ---------------------------------------------------------------------------

describe('clusterSignalsSemantic', () => {
  it('returns empty result for empty input', async () => {
    const r = await clusterSignalsSemantic([]);
    expect(r.clusters).toEqual([]);
    expect(r.signalToCluster.size).toBe(0);
    expect(r.embeddings.size).toBe(0);
  });

  it('groups 5 identical signals into 1 cluster', async () => {
    const sigs = Array.from({ length: 5 }, (_, i) =>
      mkSignal('restaurant reservation automation WhatsApp Colombia', 'restaurant-automation'),
    );
    const r = await clusterSignalsSemantic(sigs, { minClusterSize: 1 });
    expect(r.clusters.length).toBe(1);
    expect(r.clusters[0].signalIds.length).toBe(5);
    expect(r.signalToCluster.size).toBe(5);
    // All signals map to the same cluster id.
    const firstClusterId = r.signalToCluster.get(sigs[0].id);
    for (const s of sigs) {
      expect(r.signalToCluster.get(s.id)).toBe(firstClusterId);
    }
  });

  it('separates 5 unrelated signals into 5 distinct clusters', async () => {
    const sigs = [
      mkSignal('pizza delivery drone quadcopter', 'pizza'),
      mkSignal('cryptocurrency mining gpu rig ethereum', 'crypto'),
      mkSignal('yoga retreat mindfulness meditation ashtanga', 'yoga'),
      mkSignal('homestead permaculture chickens goats garden', 'homestead'),
      mkSignal('quantum computing qubits superposition entanglement', 'quantum'),
    ];
    const r = await clusterSignalsSemantic(sigs, { minClusterSize: 1, threshold: 0.99 });
    expect(r.clusters.length).toBe(5);
    expect(r.signalToCluster.size).toBe(5);
    const distinctClusters = new Set(r.signalToCluster.values());
    expect(distinctClusters.size).toBe(5);
  });

  it('groups a mix correctly — related signals cluster together, unrelated stay separate', async () => {
    // 3 signals about restaurant automation (should cluster together).
    // 2 signals about drone delivery (should cluster together).
    // 1 standalone signal about permaculture.
    const sigs = [
      mkSignal('restaurant reservation automation WhatsApp Colombia'),
      mkSignal('automate restaurant WhatsApp booking flow'),
      mkSignal('how to automate WhatsApp reservations at restaurant'),
      mkSignal('pizza delivery drone quadcopter aerial'),
      mkSignal('drone pizza delivery quadcopter aerial'),
      mkSignal('permaculture homestead chickens garden'),
    ];
    const r = await clusterSignalsSemantic(sigs, { minClusterSize: 2 });
    // Expected: 2 clusters (restaurant-automation, drone-delivery); permaculture
    // is a singleton and gets filtered out by minClusterSize=2.
    expect(r.clusters.length).toBe(2);
    const sizes = r.clusters.map((c) => c.signalIds.length).sort((a, b) => b - a);
    expect(sizes).toEqual([3, 2]);
    // Every signal still has a cluster id assigned (including noise).
    expect(r.signalToCluster.size).toBe(6);
  });

  it('respects threshold override (high threshold = fewer merges)', async () => {
    const sigs = [
      mkSignal('restaurant reservation automation whatsapp'),
      mkSignal('restaurant reservation automation whatsapp booking'),
      mkSignal('quantum computing qubits entanglement superposition'),
    ];
    const loose = await clusterSignalsSemantic(sigs, { threshold: 0.0, minClusterSize: 1 });
    // Threshold 0 means similarity >= 0 (always true) → everything merges.
    expect(loose.clusters.length).toBe(1);

    const strict = await clusterSignalsSemantic(sigs, { threshold: 0.99, minClusterSize: 1 });
    // Threshold 0.99 → only nearly-identical pairs merge. The quantum signal
    // definitely stays separate.
    expect(strict.clusters.length).toBeGreaterThanOrEqual(2);
  });

  it('returns embeddings for every signal', async () => {
    const sigs = [
      mkSignal('alpha beta gamma delta'),
      mkSignal('epsilon zeta eta theta'),
    ];
    const r = await clusterSignalsSemantic(sigs);
    expect(r.embeddings.size).toBe(2);
    for (const s of sigs) {
      const emb = r.embeddings.get(s.id);
      expect(emb).toBeDefined();
      expect(emb!.dim).toBeGreaterThan(0);
      expect(emb!.model).toBe('tfidf-hash-v1');
    }
  });
});

// ---------------------------------------------------------------------------
// semanticSearch (DB-backed integration)
// ---------------------------------------------------------------------------

describe('semanticSearch', () => {
  let db: ChismosoDB;

  beforeEach(() => {
    db = new ChismosoDB({ path: ':memory:' });
  });

  afterEach(() => {
    db.close();
  });

  it('returns [] when no embeddings table exists', async () => {
    const results = await semanticSearch('anything', { db: db.raw, topK: 5 });
    expect(results).toEqual([]);
  });

  it('returns [] when the embeddings table is empty', async () => {
    ensureEmbeddingsSchema(db.raw);
    const results = await semanticSearch('anything', { db: db.raw, topK: 5 });
    expect(results).toEqual([]);
  });

  it('ranks stored signals by similarity to the query (top result is most similar)', async () => {
    ensureEmbeddingsSchema(db.raw);
    const client = new EmbeddingClient();

    // Three signals with distinct topics. Store them + their embeddings.
    const stored = [
      { id: 'sig_a', snippet: 'restaurant reservation automation whatsapp' },
      { id: 'sig_b', snippet: 'pizza delivery drone quadcopter aerial' },
      { id: 'sig_c', snippet: 'yoga retreat meditation mindfulness' },
    ];
    for (const s of stored) {
      // Insert signal row (so the join works).
      db.prepare(
        `INSERT INTO signals (id, topic, keyword, source, source_type, timestamp, geography, metric, value,
           normalized_value, direction, velocity, confidence, evidence_type, signal_type, metadata_json,
           raw_snippet, url, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      ).run(
        s.id,
        'test-topic',
        s.snippet.split(' ')[0],
        'web_search',
        SourceType.SEARCH_WEB,
        new Date().toISOString(),
        'global',
        'mention_count',
        '1',
        1,
        'up',
        0,
        0.5,
        TruthLevel.OBSERVED,
        SignalType.MENTION_SPIKE,
        '{}',
        s.snippet,
        new Date().toISOString(),
      );
      const emb = await client.embed(s.snippet);
      storeEmbedding(db.raw, s.id, emb);
    }

    // Query matches the restaurant signal best.
    const results = await semanticSearch('restaurant reservation automation whatsapp booking flow', {
      db: db.raw,
      topK: 3,
    });
    expect(results.length).toBe(3);
    expect(results[0].signalId).toBe('sig_a');
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('topK limits the number of results', async () => {
    ensureEmbeddingsSchema(db.raw);
    const client = new EmbeddingClient();
    for (let i = 0; i < 10; i++) {
      const sigId = `sig_x_${i}`;
      const snippet = i % 2 === 0 ? 'restaurant automation whatsapp' : 'yoga meditation retreat';
      db.prepare(
        `INSERT INTO signals (id, topic, keyword, source, source_type, timestamp, geography, metric, value,
           normalized_value, direction, velocity, confidence, evidence_type, signal_type, metadata_json,
           raw_snippet, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      ).run(
        sigId,
        't',
        'k',
        'web_search',
        SourceType.SEARCH_WEB,
        new Date().toISOString(),
        'global',
        'mention_count',
        '1',
        1,
        'up',
        0,
        0.5,
        TruthLevel.OBSERVED,
        SignalType.MENTION_SPIKE,
        '{}',
        snippet,
        new Date().toISOString(),
      );
      const emb = await client.embed(snippet);
      storeEmbedding(db.raw, sigId, emb);
    }
    const results = await semanticSearch('restaurant automation whatsapp', { db: db.raw, topK: 3 });
    expect(results.length).toBe(3);
  });

  it('respects minScore filter', async () => {
    ensureEmbeddingsSchema(db.raw);
    const client = new EmbeddingClient();
    db.prepare(
      `INSERT INTO signals (id, topic, keyword, source, source_type, timestamp, geography, metric, value,
         normalized_value, direction, velocity, confidence, evidence_type, signal_type, metadata_json,
         raw_snippet, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      'sig_y_1',
      't',
      'k',
      'web_search',
      SourceType.SEARCH_WEB,
      new Date().toISOString(),
      'global',
      'mention_count',
      '1',
      1,
      'up',
      0,
      0.5,
      TruthLevel.OBSERVED,
      SignalType.MENTION_SPIKE,
      '{}',
      'restaurant reservation automation whatsapp booking',
      new Date().toISOString(),
    );
    const emb = await client.embed('restaurant reservation automation whatsapp booking');
    storeEmbedding(db.raw, 'sig_y_1', emb);

    // Query for something completely unrelated — score should be low/negative.
    const results = await semanticSearch('quantum computing qubits entanglement superposition', {
      db: db.raw,
      topK: 5,
      minScore: 0.99,
    });
    expect(results.length).toBe(0);
  });
});
