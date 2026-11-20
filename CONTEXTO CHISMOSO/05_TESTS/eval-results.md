# CHISMOSO — FASE-3-QUALITY Eval Results

**Generated:** 2026-11-19T23:16:25.314Z

Eval suite for the Phase 3 Quality-of-Results fixes.
Each objective runs the full intelligence pipeline against a fixture
Serper response (no network, no API keys) and reports the §3.1
relevance filter rate, §3.4 unique trend count, and §3.6/§3.7
concrete + V1-validated opportunity count.

> ## DISCLAIMER — fixture-based results do NOT prove real-world quality
>
> The numbers in this report are produced from **fixed Serper fixtures**
> (`tests/fixtures/serper-*.json`) and a **deterministic local embedding
> model** (TF-IDF hash, no network). They measure the **internal
> consistency** of the intelligence pipeline (relevance filtering, trend
> dedup, opportunity schema validation) against canned inputs — they do
> **NOT** measure how well CHISMOSO performs against the live web.
>
> Concretely, these results do **not** prove:
> - that real Serper queries for these objectives would return similar
>   signals (fixtures were hand-curated to exercise specific pipeline
>   paths);
> - that the trend names / opportunities generated are accurate or
>   actionable against current market reality;
> - that the relevance scorer's 100%-pass rate generalises (see
>   `tests/fixtures/noise-signals.json` + `tests/relevance-noise.test.ts`
>   for the complementary negative-test that proves the scorer *does*
>   filter deliberately irrelevant signals);
> - that the TF-IDF hash embedding model behaves the same as a real
>   embedding API (semantic clustering quality depends on the embedding
>   model — see the threshold-tuning notes in
>   `chismoso/src/intelligence/semantic-cluster.ts`).
>
> To validate real-world quality, run the E2E test
> (`chismoso/tests/e2e.test.ts`) with `SERPER_API_KEY` and
> `GROQ_API_KEY` set — that test executes the canonical investigation
> against the live web. Until that is done, treat the numbers below as
> **pipeline-shape validation only**, not as evidence of real-world
> intelligence quality.

## Summary table

| Objective | Raw signals | Relevant % | Discarded | Unique trends | Dup names | Concrete opps | Weak opps | V1 valid | V1 invalid |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Restaurantes en Colombia | 10 | 100% | 0 | 4 | 0 | 1 | 0 | 1 | 0 |
| Collares para perros en Perú | 10 | 100% | 0 | 6 | 0 | 1 | 0 | 1 | 0 |
| Nicho de YouTube/TikTok para monetizar | 11 | 100% | 0 | 7 | 0 | 1 | 1 | 1 | 0 |

## Per-objective details

### Restaurantes en Colombia

- **Objective:** `Oportunidades de negocio en restaurantes en Colombia`
- **Geography:** `Colombia`
- **Raw signals (after dedup):** 10
- **Relevant signals (after §3.1 filter):** 10 (100%)
- **Discarded as irrelevant:** 0
- **Unique trends (after §3.4 dedup):** 4
- **Duplicate trend names:** 0 (must be 0)
- **Concrete opportunities (niche + segment + geography):** 1
- **Opportunities with ≥3 lead search hints:** 1
- **Weak opportunities (score <35, not delivered by orchestrator):** 0
- **OpportunityV1 schema valid:** 1
- **OpportunityV1 schema invalid:** 0

**Trend names detected:**
- `oportunidades restaurantes negocio`
- `oportunidades restaurantes negocio-2`
- `oportunidades inteligencia negocio`
- `oportunidades centralizada negocio`

### Collares para perros en Perú

- **Objective:** `Collares para perros en Perú`
- **Geography:** `Perú`
- **Raw signals (after dedup):** 10
- **Relevant signals (after §3.1 filter):** 10 (100%)
- **Discarded as irrelevant:** 0
- **Unique trends (after §3.4 dedup):** 6
- **Duplicate trend names:** 0 (must be 0)
- **Concrete opportunities (niche + segment + geography):** 1
- **Opportunities with ≥3 lead search hints:** 1
- **Weak opportunities (score <35, not delivered by orchestrator):** 0
- **OpportunityV1 schema valid:** 1
- **OpportunityV1 schema invalid:** 0

**Trend names detected:**
- `mascotas collares perros`
- `inteligentes collares perros`
- `disenadores collares perros`
- `personalizados collares perros`
- `personalizacion collares perros`
- `personalizados influencers collares`

### Nicho de YouTube/TikTok para monetizar

- **Objective:** `Nicho de YouTube/TikTok para monetizar`
- **Geography:** `global`
- **Raw signals (after dedup):** 11
- **Relevant signals (after §3.1 filter):** 11 (100%)
- **Discarded as irrelevant:** 0
- **Unique trends (after §3.4 dedup):** 7
- **Duplicate trend names:** 0 (must be 0)
- **Concrete opportunities (niche + segment + geography):** 1
- **Opportunities with ≥3 lead search hints:** 1
- **Weak opportunities (score <35, not delivered by orchestrator):** 1
- **OpportunityV1 schema valid:** 1
- **OpportunityV1 schema invalid:** 0

**Trend names detected:**
- `monetizar nicho youtube`
- `monetizar nicho youtube-2`
- `crecimiento nicho youtube`
- `angloparlantes latam nicho`
- `visualizacion nicho youtube`
- `generalistas nicho youtube`
- `directamente nicho youtube`

## Acceptance criteria

| Criterion | Status |
| :--- | :--- |
| No duplicate trend names (§3.4) | PASS |
| Concrete opportunities generated (§3.6) | PASS |
| All opportunities pass V1 schema (§3.7) | PASS |
