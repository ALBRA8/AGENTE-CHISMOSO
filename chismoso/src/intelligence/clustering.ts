/**
 * CHISMOSO V1.0 — Topic Clustering (sección 18)
 *
 * Diferentes expresiones pueden representar el mismo fenómeno.
 * Ej: "reservas por WhatsApp", "agendar por WhatsApp", "WhatsApp restaurant booking"
 * pueden agruparse en un único topic canónico.
 *
 * Para V1 usamos clustering híbrido:
 *   - normalización de keywords (lowercase, sin acentos)
 *   - agrupación por co-ocurrencia de keywords en señales cercanas
 *   - opcionalmente, el LLM propone un canonical label cuando hay
 *     sub-clusters que comparten >50% de keywords
 *
 * NO introducimos embeddings / vector DB en V1 — la especificación dice
 * explícitamente no introducir infraestructura pesada sin necesidad.
 */

import type { Signal, TopicCluster } from '../models.js';
import { generateId, nowISO } from '../models.js';
import { normalizeText, tokenize } from './normalizer.js';

export interface ClusterResult {
  clusters: TopicCluster[];
  /** map signal.id → clusterId */
  signalToCluster: Map<string, string>;
}

/**
 * Agrupa señales por similitud de keywords.
 *
 * Heurística:
 *   1. Tokeniza cada signal en keywords normalizadas.
 *   2. Para cada signal, encuentra un cluster existente tal que el
 *      solape de tokens (intersección / unión) sea >= threshold.
 *   3. Si encuentra, asigna. Si no, crea un cluster nuevo.
 *   4. El canonical del cluster es el keyword más frecuente entre sus señales.
 */
export function clusterSignals(signals: Signal[], threshold = 0.34): ClusterResult {
  const clusters: TopicCluster[] = [];
  const signalToCluster = new Map<string, string>();
  const clusterTokens = new Map<string, Map<string, number>>(); // clusterId → tokenFreq

  for (const s of signals) {
    const tokens = new Set(tokenize(`${s.keyword} ${s.topic} ${s.rawSnippet.slice(0, 200)}`));
    if (tokens.size === 0) {
      // No hay tokens para comparar — agrúpalo solo.
      const id = generateId('topic');
      const c: TopicCluster = {
        id,
        canonical: s.topic || s.keyword,
        keywords: [s.keyword],
        signalIds: [s.id],
        evidenceIds: [],
        sourcesCount: 1,
        firstSeen: s.timestamp,
        lastSeen: s.timestamp,
        observationCount: 1,
      };
      clusters.push(c);
      signalToCluster.set(s.id, id);
      clusterTokens.set(id, new Map());
      continue;
    }
    let bestCluster: TopicCluster | null = null;
    let bestScore = 0;
    for (const c of clusters) {
      const existing = clusterTokens.get(c.id)!;
      if (existing.size === 0) continue;
      let intersection = 0;
      for (const t of tokens) if (existing.has(t)) intersection++;
      // Overlap coefficient: intersection / min(|a|, |b|) — más permisivo
      // que Jaccard cuando los sets tienen tamaños muy distintos.
      const minSize = Math.min(tokens.size, existing.size);
      const score = minSize === 0 ? 0 : intersection / minSize;
      if (score > bestScore) {
        bestScore = score;
        bestCluster = c;
      }
    }
    if (bestCluster && bestScore >= threshold) {
      bestCluster.signalIds.push(s.id);
      bestCluster.keywords.push(s.keyword);
      bestCluster.sourcesCount = new Set(
        bestCluster.signalIds.map((sid) => signals.find((x) => x.id === sid)?.source).filter(Boolean) as string[],
      ).size;
      bestCluster.lastSeen = s.timestamp > bestCluster.lastSeen ? s.timestamp : bestCluster.lastSeen;
      bestCluster.firstSeen = s.timestamp < bestCluster.firstSeen ? s.timestamp : bestCluster.firstSeen;
      bestCluster.observationCount++;
      signalToCluster.set(s.id, bestCluster.id);
      const freq = clusterTokens.get(bestCluster.id)!;
      for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
    } else {
      const id = generateId('topic');
      const freq = new Map<string, number>();
      for (const t of tokens) freq.set(t, 1);
      const c: TopicCluster = {
        id,
        canonical: pickCanonical(s.topic || s.keyword, freq),
        keywords: [s.keyword],
        signalIds: [s.id],
        evidenceIds: [],
        sourcesCount: 1,
        firstSeen: s.timestamp,
        lastSeen: s.timestamp,
        observationCount: 1,
      };
      clusters.push(c);
      clusterTokens.set(id, freq);
      signalToCluster.set(s.id, id);
    }
  }

  // Refresca canonical basándose en el token más frecuente de cada cluster.
  for (const c of clusters) {
    const freq = clusterTokens.get(c.id)!;
    c.canonical = pickCanonical(c.canonical, freq);
  }

  return { clusters, signalToCluster };
}

function pickCanonical(fallback: string, freq: Map<string, number>): string {
  let best = fallback;
  let bestCount = 0;
  for (const [tok, count] of freq.entries()) {
    if (count > bestCount || (count === bestCount && tok.length > best.length)) {
      best = tok;
      bestCount = count;
    }
  }
  return normalizeText(best).split(' ')[0] || fallback;
}
