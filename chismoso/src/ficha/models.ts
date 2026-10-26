/**
 * CHISMOSO V1.0 — FichaSpec (Task IMP-CLONA-1)
 *
 * A FICHA is a ClonaKit-style structured specification that describes WHAT to
 * build, not HOW. CHISMOSO's job is discovery (signal/trend/opportunity
 * detection); it should NOT become the factory that produces the actual
 * product. But it CAN structure its output as a FichaSpec so that the next
 * agent in the ecosystem (e.g. a future AGENTE-MVP, a human developer, or
 * an AI like Cursor) can pick up the Opportunity and build it in clean-room
 * style.
 *
 * Key invariants (enforced everywhere this interface is built):
 *   - `truth_level` is ALWAYS `'DERIVED'` — a FichaSpec is a synthesis of
 *     observed signals, never a direct observation itself. This is the
 *     traceability contract between CHISMOSO's investigation layer and
 *     ClonaKit's clean-room construction layer: nothing in the FICHA may
 *     masquerade as raw evidence.
 *   - `evidence` always carries the opportunity_id + investigation_id +
 *     trend_topic + signal_count + top_evidence_urls so a builder agent
 *     that doubts a function can walk the chain back to the source signals.
 *   - The MVP functions array is 3–5 entries — fewer than 3 is not a real
 *     MVP, more than 5 belongs in `for_later`.
 */

// ---------------------------------------------------------------------------
// PRIMITIVE TYPES
// ---------------------------------------------------------------------------

/**
 * A single MVP function described in the user's own words.
 * `web_equivalent` is the closest standard web building block (e.g.
 * "WhatsApp Business API + calendar widget"). It is intentionally NOT
 * code — a builder agent that only sees this FICHA must be able to
 * implement it without consulting CHISMOSO or the original product.
 */
export interface FichaFunction {
  /** Short, human label, e.g. "Reservas WhatsApp". */
  name: string;
  /** What it does, written in the user's words from the opportunity. */
  description: string;
  /** Closest standard web building block, e.g. "WhatsApp Business API + calendar widget". */
  web_equivalent: string;
}

/**
 * A single screen / view of the future product. The ClonaKit template
 * asks for "Qué se ve" (zones of the screen) and "Qué se puede hacer"
 * (actions). We mirror those two lists directly here.
 */
export interface FichaScreen {
  /** Short, human label, e.g. "Pantalla principal" or "Reservas". */
  name: string;
  /** Zones of the screen and what's in each one. */
  what_you_see: string[];
  /** Actions and buttons, described by their function (no copied UI text). */
  what_you_can_do: string[];
}

/**
 * Traceability block linking the FichaSpec back to the CHISMOSO
 * investigation that produced it. A builder agent that doubts a
 * function can walk this chain back to the source signals.
 */
export interface FichaEvidence {
  /** ID of the Opportunity this FICHA was derived from. */
  opportunity_id: string;
  /** ID of the Investigation that produced the Opportunity. */
  investigation_id: string;
  /** Topic of the Trend that fed the Opportunity, if any. */
  trend_topic?: string;
  /** Number of signals underpinning the Opportunity (rough size of evidence base). */
  signal_count: number;
  /** Top evidence URLs (max 5) — the builder agent should NOT copy from these. */
  top_evidence_urls: string[];
}

/**
 * A ClonaKit-style FICHA specification.
 *
 * Built from a CHISMOSO Opportunity via `buildFicha()` (see builder.ts) and
 * rendered to Markdown via `renderFichaMarkdown()` (see renderer.ts).
 */
export interface FichaSpec {
  /** `ficha_<opportunity_id>` — internally-prefixed so it can never collide with an Opportunity ID. */
  id: string;
  /** Human-readable product title. */
  title: string;
  /** One-sentence description, e.g. "Una web para…". */
  one_liner: string;
  /** Optional reference product, e.g. "Inspirada en [product X]". Always advisory — never copied. */
  inspired_by?: string;
  /** Who will use the product and when. */
  target_audience: string;
  /** The problem the product solves (mirrors Opportunity.problem). */
  problem_it_solves: string;
  /** 3–5 MVP functions. */
  mvp_functions: FichaFunction[];
  /** 1–3 screens. */
  screens: FichaScreen[];
  /** What the product would store and where. */
  data: {
    /** What it stores, e.g. ["reservations", "customer names", "menu items"]. */
    what_it_stores: string[];
    /** Where: "browser (localStorage)" | "server (Postgres)" | etc. */
    where: string;
    /** Personal data summary, e.g. "none" | "emails and names of customers (RGPD)". */
    personal_data: string;
  };
  /** Out-of-MVP features for the "Para más adelante" section. */
  for_later: string[];
  /** Traceability to the CHISMOSO investigation. */
  evidence: FichaEvidence;
  /** Always 'DERIVED' — a FICHA is a synthesis, never a direct observation. */
  truth_level: 'DERIVED';
  /** ISO timestamp when the FichaSpec was generated. */
  generated_at: string;
  /** Optional confidence (0..1) mirrored from the source Opportunity. Used by the renderer's "Veracidad y limitaciones" section. */
  confidence?: number;
  /** Optional limitations surfaced in the renderer's "Veracidad y limitaciones" section. When absent, the renderer uses a sensible default list. */
  limitations?: string[];
}
