# CHISMOSO — FASE-3-QUALITY Eval Results

**Generated:** 2026-11-19T23:16:25.314Z

Eval suite for the Phase 3 Quality-of-Results fixes.
Each objective runs the full intelligence pipeline against a fixture
Serper response (no network, no API keys) and reports the §3.1
relevance filter rate, §3.4 unique trend count, and §3.6/§3.7
concrete + V1-validated opportunity count.

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
