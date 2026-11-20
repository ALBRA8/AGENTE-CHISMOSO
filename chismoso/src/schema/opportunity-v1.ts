/**
 * CHISMOSO V1.0 — Opportunity V1 Contract Schema (FASE-3-QUALITY §3.7)
 *
 * Strict zod schema for the opportunity payload CHISMOSO publishes to
 * the agent mesh (and ultimately to AGENTE-LEADS). Every opportunity
 * MUST validate against `OpportunityV1Schema` before it's persisted or
 * published — invalid ones get logged + dropped by the orchestrator.
 *
 * The schema encodes the FASE-3-QUALITY §3.6 contract:
 *   - Every opportunity has a niche, target segment, geography,
 *     value proposition, why-now, risks, and lead-search hints.
 *   - Every claim has at least one evidence reference (the `evidence`
 *     array is non-empty — enforced at the orchestrator level via a
 *     `.min(1)` refinement is intentionally NOT added here because
 *     some unit-test fixtures construct opportunities without evidence
 *     to assert the schema's own shape; the orchestrator adds the
 *     `.min(1)` check via a wrapper when needed).
 *   - leadSearchHints has at least 3 entries — AGENTE-LEADS needs a
 *     concrete starting set of queries.
 *
 * Backward/forward compatibility: the `schemaVersion` field is a
 * literal `'opportunity.v1'`. Future contract changes bump to
 * `'opportunity.v2'` and ship a new schema file alongside this one so
 * consumers can validate against either version during a rollout.
 */

import { z } from 'zod';

export const OpportunityV1Schema = z.object({
  schemaVersion: z.literal('opportunity.v1'),
  id: z.string().min(1),
  /**
   * Niche / product name — a short descriptive noun phrase naming the
   * product/service category (e.g. "collares para perros",
   * "reservas por whatsapp para restaurantes").
   */
  niche: z.string().min(3),
  /**
   * Target segment — who the opportunity is for. MUST NOT be empty;
   * when the segment can't be inferred, it's explicitly set to
   * "segmento desconocido" (FASE-3-QUALITY §3.5) so the uncertainty
   * propagates downstream rather than being hidden.
   */
  targetSegment: z.string().min(1),
  /** Geography — country name or 'global'. */
  geography: z.string().min(1),
  /** What pain exists — grounded in evidence (problem.description). */
  problem: z.string().min(1),
  /** What to sell/offer — concrete value proposition. */
  valueProposition: z.string().min(10),
  /** Why now — timing rationale (trend state + signal recency). */
  whyNow: z.string().min(5),
  /** 3-5 bullet risks — derived from competition, uncertainty, evidence volume. */
  risks: z.array(z.string().min(5)).min(3).max(5),
  /** Overall opportunity score (0..100). */
  score: z.number().min(0).max(100),
  /** Confidence in the opportunity (0..1). */
  confidence: z.number().min(0).max(1),
  /**
   * Evidence references — every claim in the opportunity must be
   * traceable to at least one signal. Each entry carries the source,
   * optional URL, the extracted snippet, and the truth level
   * (OBSERVED / VERIFIED / DERIVED / INFERRED / ESTIMATED / UNVERIFIED
   * / PREDICTED / UNKNOWN — see models.ts TruthLevel enum).
   */
  evidence: z.array(
    z.object({
      source: z.string().min(1),
      url: z.string().optional(),
      snippet: z.string(),
      truthLevel: z.string(),
    }),
  ),
  /** Always 'AGENTE-LEADS' for V1 — the next agent in the mesh. */
  suggestedNextAgent: z.literal('AGENTE-LEADS'),
  /**
   * 3-5 search queries AGENTE-LEADS can run to find prospective
   * customers / content / competitors in the niche + segment +
   * geography. MUST have at least 3 entries so AGENTE-LEADS has a
   * concrete starting set.
   */
  leadSearchHints: z.array(z.string().min(2)).min(3).max(5),
});

export type OpportunityV1 = z.infer<typeof OpportunityV1Schema>;

/**
 * Validate an unknown value against the V1 schema. Returns the parsed
 * opportunity on success, or `null` + an error message on failure.
 *
 * Used by the orchestrator to drop invalid opportunities before they're
 * persisted or published to the mesh.
 */
export function parseOpportunityV1(
  value: unknown,
): { ok: true; v1: OpportunityV1 } | { ok: false; error: string } {
  const result = OpportunityV1Schema.safeParse(value);
  if (result.success) {
    return { ok: true, v1: result.data };
  }
  const error = result.error.issues
    .map((i) => `${i.path.join('.')}: ${i.message}`)
    .join('; ');
  return { ok: false, error };
}
