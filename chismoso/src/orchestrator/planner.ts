/**
 * CHISMOSO V1.0 — Research Planner (sección 23)
 *
 * El Research Planner convierte un objetivo de alto nivel en un plan
 * ejecutable de investigación. NO ejecuta — solo planifica.
 *
 * Usa el LLM para:
 *   - descomponer el objetivo en sub-temas
 *   - generar queries para cada provider
 *   - decidir cuántas iteraciones ejecutar
 *
 * Pero el plan es solo una propuesta: el orchestrator decide cuándo
 * detenerse basándose en el budget (sección 26) y la calidad de la evidencia.
 */

import type { LLMClient } from './llm.js';
import { logger } from '../logger.js';

export interface ResearchPlan {
  scope: string;
  geography: string;
  topics: string[];
  queries: Array<{ providerName: string; query: string; rationale: string }>;
  iterations: number;
}

export interface PlanInput {
  objective: string;
  geography?: string;
  maxIterations?: number;
}

const PLANNER_SYSTEM_PROMPT = `You are CHISMOSO's Research Planner.
You convert a high-level objective into a structured research plan.

Your output MUST be valid JSON with this exact shape:
{
  "scope": "string — concise scope description",
  "geography": "string — geography scope",
  "topics": ["topic1", "topic2", ...],
  "queries": [
    { "providerName": "web_search", "query": "...", "rationale": "..." },
    { "providerName": "reddit_communities", "query": "...", "rationale": "..." }
  ],
  "iterations": 1
}

Available providers:
  - web_search (general web search)
  - reddit_communities (community/forum search via site:reddit.com | site:quora.com)

Rules:
  - Generate 3-6 topics that decompose the objective.
  - For each topic, generate 1-2 queries — mix web_search and reddit_communities.
  - Prefer natural-language queries with concrete keywords (avoid pure keyword stuffing).
  - Always include geography in the query when relevant.
  - iterations should be 1 unless the objective is broad (then 2).
  - Do NOT invent providers not listed above.
  - Do NOT include markdown, comments, or text outside the JSON object.
`;

export class ResearchPlanner {
  constructor(private llm: LLMClient) {}

  async plan(input: PlanInput): Promise<ResearchPlan> {
    const geography = input.geography ?? 'global';
    const userPrompt = `OBJECTIVE:\n${input.objective}\n\nGEOGRAPHY: ${geography}\nMAX_ITERATIONS: ${input.maxIterations ?? 1}\n\nProduce the JSON research plan now.`;

    logger.info('ResearchPlanner: calling LLM', { objective: input.objective });
    const resp = await this.llm.chat([
      { role: 'system', content: PLANNER_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ]);

    const parsed = safeParsePlan(resp.content);
    if (!parsed) {
      // Plan de fallback determinista para no bloquear el pipeline.
      logger.warn('ResearchPlanner: LLM did not return valid JSON, using fallback plan', { contentLen: resp.content.length });
      return fallbackPlan(input);
    }
    logger.info('ResearchPlanner: plan ready', { topics: parsed.topics.length, queries: parsed.queries.length, iterations: parsed.iterations });
    return parsed;
  }
}

function safeParsePlan(content: string): ResearchPlan | null {
  try {
    const jsonStr = extractJson(content);
    if (!jsonStr) return null;
    const obj = JSON.parse(jsonStr);
    if (
      typeof obj.scope === 'string' &&
      Array.isArray(obj.topics) &&
      Array.isArray(obj.queries) &&
      typeof obj.iterations === 'number'
    ) {
      // Filtra queries con providers desconocidos.
      obj.queries = obj.queries.filter(
        (q: any) => q.providerName === 'web_search' || q.providerName === 'reddit_communities',
      );
      if (typeof obj.geography !== 'string') obj.geography = 'global';
      return obj as ResearchPlan;
    }
    return null;
  } catch {
    return null;
  }
}

function extractJson(s: string): string | null {
  // Busca el primer { y el último } — tolera texto alrededor.
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) return null;
  return s.slice(start, end + 1);
}

function fallbackPlan(input: PlanInput): ResearchPlan {
  const geography = input.geography ?? 'global';
  return {
    scope: input.objective,
    geography,
    topics: [input.objective.slice(0, 100)],
    queries: [
      { providerName: 'web_search', query: input.objective, rationale: 'fallback' },
      { providerName: 'reddit_communities', query: input.objective, rationale: 'fallback' },
    ],
    iterations: 1,
  };
}
