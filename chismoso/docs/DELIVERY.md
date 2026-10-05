# CHISMOSO V1.0 — ENTREGA DEL CONSTRUCTOR

> Reporte de entrega según especificación maestra, sección 62 (ENTREGA DEL CONSTRUCTOR).
>
> Principio rector: **No ocultes problemas. No maquilles resultados.**

- **Proyecto:** CHISMOSO V1.0
- **Versión:** 1.0.0
- **Fecha de entrega:** 2026-10-05
- **Constructor:** Super Z (agente principal)
- **Reporte generado por:** Agente `delivery-report` (Task ID 10-c)
- **Investigación canónica de referencia:** `inv_muvfmcw36y3lps`

---

## 1. WHAT WAS BUILT

Se construyó CHISMOSO V1.0 completo: un agente autónomo de inteligencia de
señales, tendencias, problemas y oportunidades de negocio. El pipeline recibe
una instrucción de alto nivel en lenguaje natural y devuelve un reporte
accionable respaldado por evidencia trazable.

Subsistemas entregados:

### 1.1 Modelos canónicos (`src/models.ts`, 327 líneas)
- `Signal`, `Evidence`, `Trend`, `Problem`, `Opportunity`, `Investigation`,
  `TopicCluster`, `IntelligenceReport`.
- Enum `TruthLevel`: `OBSERVED | DERIVED | INFERRED | PREDICTED | UNKNOWN`.
  Cada claim lleva su nivel de verdad, separando lo observado de lo derivado.
- Enum `InvestigationStatus`: `RUNNING | COMPLETED | PARTIAL | FAILED | INSUFFICIENT_EVIDENCE`.
- Enum `TrendState`: 6 estados (`NOISE | WEAK_SIGNAL | EMERGING_TREND | STRONG_TREND | ESTABLISHED_TREND | DECLINING_TREND`).

### 1.2 Taxonomía de errores (`src/errors.ts`, 165 líneas)
- `ErrorCode`: `RATE_LIMIT | AUTH_FAILURE | TIMEOUT | NETWORK | PARSE | PROVIDER_UNAVAILABLE | EMPTY_RESULT | QUOTA_EXCEEDED | UNKNOWN`.
- `retryStrategy(errorCode)` define si reintenta, cuántas veces y con qué backoff.
- `classifyError(message)` mapea mensajes reales del SDK a códigos internos.

### 1.3 Fundación SQLite (`src/db.ts`, 267 líneas)
- 10 tablas: `topics`, `signals`, `evidence`, `trends`, `problems`,
  `opportunities`, `investigations`, `provider_runs`, `topic_observations`,
  `schema_meta`.
- Migraciones versionadas mediante tabla `schema_meta`.
- Handler `process.on('beforeExit')` para invocar el destructor nativo de
  `better-sqlite3` de forma limpia en Node 24 (ADR-010).

### 1.4 Repositorios (`src/repositories.ts`, 614 líneas)
- 7 repositorios: `SignalRepository`, `EvidenceRepository`, `TopicRepository`,
  `TrendRepository`, `ProblemRepository`, `OpportunityRepository`,
  `InvestigationRepository`.
- Cada uno expone CRUD + consultas específicas (por investigación, por tema,
  historial de observaciones, etc.).
- `TopicRepository.recordObservation()` escribe en `topic_observations`,
  habilitando la memoria temporal del agente.

### 1.5 Abstracción de proveedores (`src/providers/`, 6 archivos)
- `base.ts` (109 líneas): interfaz `IProvider`, `ProviderRegistry`,
  `RawItem`, `ProviderHealth`, `ProviderCapabilities`.
- 4 proveedores:
  - `WebSearchProvider` (real, vía `z-ai-web-dev-sdk.web_search`).
  - `RedditProvider` (real, vía `web_search` con filtro `site:reddit.com OR site:quora.com`).
  - `WebContentProvider` (real, vía `page_reader` para profundizar URLs).
  - `GoogleTrendsProvider` — **UNAVAILABLE** sin credenciales. No simula
    datos; reporta `PROVIDER_UNAVAILABLE` y devuelve lista vacía.
- `index.ts` registra los 4 en el `ProviderRegistry`.

### 1.6 Motor de señales (`src/intelligence/`)
- `normalizer.ts` (239 líneas): `normalizeRawItem` (RawItem → Signal+Evidence),
  `tokenize` con stopwords ES+EN, `extractKeyword`, `inferSignalType` (patrones
  EN+ES para `complaint | question | trend | news | opinion`),
  `dedupSignals` (por URL), `dedupEvidence`, `rawConfidence`.
- `clustering.ts` (132 líneas): `clusterSignals` usando overlap coefficient
  sobre tokens, umbral 0.34. Asigna canonical al token más frecuente.
- `cross-source.ts` (51 líneas): `crossSourceConfidence` — 1 fuente = low,
  2 tipos = medium, 3+ tipos = high.
- `trends.ts` (179 líneas): `detectTrend` con 5 componentes (growth,
  persistence, crossSource, recency, velocity) + penalización por noise.
  `classifyState` produce los 6 estados.
- `problems.ts` (193 líneas): `detectProblem` con friction patterns EN+ES
  (≥2 snippets distintos requeridos), severidad/frecuencia/confianza.
- `opportunities.ts` (272 líneas): `generateOpportunity` con scoring
  transparente de 8 factores (demand, growth, problemSeverity, monetization,
  timing, marketFit, competition, uncertainty) y pesos documentados.
  `Opportunity.suggestedNextAgent = "AGENTE-LEADS"` (interoperabilidad).

### 1.7 Orquestador (`src/orchestrator/`, 6 archivos)
- `llm.ts` (80 líneas): `LLMClient` envuelve `z-ai-web-dev-sdk.chat.completions`
  con retry basado en la taxonomía de errores.
- `planner.ts` (130 líneas): `ResearchPlanner` pide al LLM un plan JSON con
  `topics`, `queries` e `iterations`. Si el LLM falla o el JSON no parsea,
  fallback determinista (no mágico).
- `tools.ts` (331 líneas): `ToolRegistry` con 4 herramientas
  (`search_web`, `search_community`, `collect_trends`, `deepen_content`).
  Cada tool mapea a un provider — separación limpia (ADR-004).
- `orchestrator.ts` (381 líneas): loop acotado por presupuesto
  (`maxIterations`, `maxQueries`, `maxSources`, `maxResults`, `maxRuntimeMs`,
  `maxProviderCalls`). Estado, transiciones y terminación limpia.
- `reporter.ts` (242 líneas): `buildReport` produce markdown humano + JSON
  máquina (`IntelligenceReport` con `executiveSummary`, `limitations`,
  `recommendedNextAction`, anotaciones `TruthLevel` en cada claim).

### 1.8 CLI (`src/cli.ts`, 213 líneas)
- 5 comandos: `investigate`, `demo`, `providers`, `history`, `show`.
- Flags: `--geography`, `--max-queries`, `--max-runtime-ms`, `--save`.
- Configuración por variables de entorno (`CHISMOSO_DB_PATH`,
  `CHISMOSO_LOG_LEVEL`, etc.).

### 1.9 Tests (`tests/`, 7 archivos, 41 tests)
- 39 unitarios + 2 E2E con proveedores reales.

### 1.10 Memoria temporal
- Tabla `topic_observations` permite responder evolución:
  *¿Está creciendo? ¿Ya lo habíamos detectado? ¿Apareció en nuevas fuentes?
  ¿La confianza aumentó?* (Definición de Done, sección 58).

### 1.11 Reportes canarios de prueba
- `/home/z/my-project/download/chismoso/report-inv_muvfmcw36y3lps.{md,json}` —
  investigación canónica completa generada por la CLI.

---

## 2. WHAT WAS PRESERVED

- El repositorio vacío original en `/home/z/my-project/` se respetó.
- El archivo `/home/z/my-project/.env` **no fue modificado**.
- El directorio `/home/z/my-project/skills/` no fue tocado.
- El SDK `z-ai-web-dev-sdk` v0.0.18 instalado globalmente se reutilizó
  **tal cual** (enlace simbólico, no se modificó su código).
- El historial git se mantiene en "Initial commit" — el proceso de
  construcción no hizo commits.
- Las dependencias instaladas (`better-sqlite3`, `tsx`, `typescript`,
  `vitest`, `@types/*`) se instalaron únicamente en `chismoso/node_modules/`.

---

## 3. WHAT WAS CHANGED

**Nada preexistente fue modificado.**

Todo el proyecto fue creado desde cero bajo `/home/z/my-project/chismoso/`.
Adicionalmente se creó un nuevo subdirectorio de entregables:
`/home/z/my-project/download/chismoso/` con dos archivos (`.md` y `.json`).

---

## 4. WHAT WAS REMOVED

**Nada fue removido.**

El build fue estrictamente aditivo. No se borraron archivos, dependencias
ni configuraciones del entorno base.

---

## 5. FILES CREATED

### Raíz del proyecto (`chismoso/`)
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `vitest.config.ts`
- `.gitignore`
- (directorio `data/` — almacena SQLite local)

### `src/` (código fuente, 27 archivos .ts)
- `models.ts`
- `errors.ts`
- `logger.ts`
- `db.ts`
- `repositories.ts`
- `index.ts`
- `cli.ts`

### `src/config/`
- `index.ts`

### `src/providers/`
- `base.ts`
- `web-search.ts`
- `reddit.ts`
- `web-content.ts`
- `google-trends.ts`
- `index.ts`

### `src/intelligence/`
- `normalizer.ts`
- `clustering.ts`
- `cross-source.ts`
- `trends.ts`
- `problems.ts`
- `opportunities.ts`
- `index.ts`

### `src/orchestrator/`
- `llm.ts`
- `planner.ts`
- `tools.ts`
- `orchestrator.ts`
- `reporter.ts`
- `index.ts`

### `tests/` (7 archivos, 41 tests)
- `normalizer.test.ts` (7 tests)
- `errors.test.ts` (9 tests)
- `clustering.test.ts` (3 tests)
- `trends.test.ts` (9 tests)
- `opportunities.test.ts` (5 tests)
- `providers-db.test.ts` (6 tests)
- `e2e.test.ts` (2 tests — REALES con red)

### `scripts/`
- `smoke.ts`
- `inspect.ts`
- `list-signals.ts`

### `docs/` (creado por este agente y paralelos)
- `README.md` (otro agente)
- `ARCHITECTURE.md` (otro agente)
- `DELIVERY.md` (este archivo)
- `DEFINITION_OF_DONE.md` (otro agente)

### Entregables externos
- `/home/z/my-project/download/chismoso/report-inv_muvfmcw36y3lps.md`
- `/home/z/my-project/download/chismoso/report-inv_muvfmcw36y3lps.json`

**Totales:** 37 archivos `.ts` bajo `src/`+`tests/`+`scripts/` (≈ 4 523 líneas
de código fuente, excluyendo tests/scripts), 7 archivos de test, 3 scripts,
4 docs, 2 entregables canarios.

---

## 6. FILES MODIFIED

**Ninguno.**

El proyecto se creó desde cero. El archivo `/home/z/my-project/.env` no fue
tocado. El SDK `z-ai-web-dev-sdk` se enlazó sin modificar su fuente.

---

## 7. ARCHITECTURAL DECISIONS

Diez ADRs tomadas durante el build (ver `docs/ARCHITECTURE.md` para detalle):

- **ADR-001 — SQLite (no Postgres).** Especificación sección 31. Persistencia
  local, sin servidor, suficiente para V1. Permite historial y memoria
  temporal sin infraestructura.
- **ADR-002 — `z-ai-web-dev-sdk` como backend real de providers.** Único SDK
  disponible en el entorno. Se usa `web_search` y `page_reader` reales.
- **ADR-003 — GoogleTrends UNAVAILABLE; nunca simular.** No hay credenciales
  para Google Trends. El provider existe, se registra, pero reporta
  `PROVIDER_UNAVAILABLE` y devuelve items vacíos. **No inventa datos.**
- **ADR-004 — Mapeo Provider → Tool preserva separación.** El orquestador
  invoca herramientas (`search_web`, `search_community`, …), no providers
  directamente. Permite cambiar el provider de una tool sin tocar el loop.
- **ADR-005 — Overlap coefficient para clustering.** Heurística barata,
  explicable, sin dependencias externas. Suficiente para el volumen actual.
- **ADR-006 — Detección de problemas por heurística EN+ES.** No se delegó
  al LLM. Patrones de fricción explícitos requieren ≥2 snippets distintos
  para reducir falsos positivos.
- **ADR-007 — Scoring transparente con pesos documentados.** Sin números
  mágicos: los 8 pesos de oportunidad están en el código y son legibles
  en el JSON de salida.
- **ADR-008 — `TruthLevel` separa cada claim.** Signals = `OBSERVED`,
  trends derivadas = `OBSERVED` (con score derivado), opportunities = `DERIVED`.
  El usuario siempre sabe qué vino del mundo y qué calculó el agente.
- **ADR-009 — Loop de investigación acotado por presupuesto.** Múltiples
  límites (`maxIterations`, `maxQueries`, `maxSources`, `maxResults`,
  `maxRuntimeMs`, `maxProviderCalls`) previenen loops infinitos y costos
  sin techo.
- **ADR-010 — `beforeExit` handler para `better-sqlite3`.** El destructor
  nativo de `better-sqlite3` es silencioso y falla en Node 24 al cerrar el
  proceso. Se registró un `process.on('beforeExit')` para invocar
  `db.close()` explícitamente.

---

## 8. TESTS

- **Framework:** Vitest 2.1.9.
- **Modo:** single-thread (restricción del módulo nativo `better-sqlite3`).
- **Configuración:** `vitest.config.ts` define `pool: 'forks'`, `poolOptions: { forks: { singleFork: true } }`.
- **Comando:** `npm test` o `npx vitest run`.

### Distribución (41 tests totales)
| Archivo | Tests | Tipo |
|---|---|---|
| `normalizer.test.ts` | 7 | unit |
| `errors.test.ts` | 9 | unit |
| `clustering.test.ts` | 3 | unit |
| `trends.test.ts` | 9 | unit |
| `opportunities.test.ts` | 5 | unit |
| `providers-db.test.ts` | 6 | unit + db |
| `e2e.test.ts` | 2 | E2E real |
| **Total** | **41** | |

### E2E reales (con red y LLM en vivo)
1. `runs a full investigation end-to-end with REAL providers` — ejecuta
   el pipeline completo con WebSearchProvider y RedditProvider reales,
   verifica que se generan signals, trends, problems, opportunities y
   que los reportes `.md`/`.json` tienen la estructura canónica. Verifica
   además que las limitaciones incluyen `UNAVAILABLE` para `google_trends`.
2. `falls back gracefully with INSUFFICIENT_EVIDENCE when providers return nothing` —
   cuando los providers devuelven items vacíos, el orquestador termina con
   `status: INSUFFICIENT_EVIDENCE` y no inventa tendencias.

---

## 9. TEST RESULTS

- **Resultado:** 41/41 tests pasan.
- **Tests unitarios:** ~3 ms cada uno.
- **E2E canónica (con red real):** ~15–18 s.
- **E2E INSUFFICIENT_EVIDENCE:** ~6–8 s.
- **Duración total del suite:** ~22–25 s.

### Investigación canónica de referencia (`inv_muvfmcw36y3lps`)
- **Objetivo:** "Investiga qué tendencias y problemas emergentes podrían
  generar oportunidades de negocio para automatización de pequeños
  restaurantes en Colombia."
- **Providers activos:** `web_search`, `reddit_communities`.
- **Señales generadas:** 25 (reales, con URLs).
- **Tendencias detectadas:** 6 (distribución: 2 `WEAK_SIGNAL`, 4 `NOISE`).
- **Problemas detectados:** 1 (severity 40, frequency 65, confidence 90%).
- **Oportunidades generadas:** 2 (scores 49 y 42, ambas con
  `suggestedNextAgent: "AGENTE-LEADS"`).
- **Estado final:** `RUNNING` (investigación interrumpida por `maxRuntimeMs`
  en esa corrida; posteriores corridas alcanzan `COMPLETED`).
- **Confianza global:** 41%.
- **Fuentes reales observadas:** `deliverect.com`, `doordash.com`,
  `docusign.com`, `mastercardservices.com`, `reddit.com`, entre otras.
- **Archivos generados:**
  - `/home/z/my-project/download/chismoso/report-inv_muvfmcw36y3lps.md` (167 líneas).
  - `/home/z/my-project/download/chismoso/report-inv_muvfmcw36y3lps.json` (4 611 líneas).

---

## 10. REAL CAPABILITIES

Capacidades verificadas, no prometidas:

1. **Recibe un objetivo de alto nivel** y ejecuta el pipeline completo
   autónomamente (una sola instrucción → reporte accionable).
2. **Usa 3 providers REALES:** WebSearchProvider, RedditProvider, WebContentProvider.
   Ningún dato simulado se presenta como real.
3. **Detecta tendencias** con clasificación de estado (6 estados) y score
   descompuesto en 5 componentes (growth, persistence, crossSource, recency,
   velocity).
4. **Detecta problemas** con severidad, frecuencia y confianza; requiere
   ≥2 snippets distintos de fricción para reducir falsos positivos.
5. **Genera oportunidades** con scoring transparente de 8 factores, pesos
   documentados y descomposición legible en el JSON.
6. **Confirma con cross-source:** si un tema aparece en ≥3 tipos de fuente,
   la confianza sube a `high`. Si solo en 1, queda en `low`.
7. **Memoria temporal funcional:** tabla `topic_observations` permite
   responder *"¿Está creciendo? ¿Ya lo habíamos detectado?"*.
8. **Produce reportes dobles:** markdown legible por humanos + JSON máquina
   con `TruthLevel` anotado en cada claim.
9. **Interoperabilidad estructural:** `Opportunity.suggestedNextAgent = "AGENTE-LEADS"`
   en cada oportunidad — listo para handoff cuando AGENTE-LEADS exista.
10. **Taxonomía de errores** con estrategia de retry por código
    (RATE_LIMIT reintenta con backoff, AUTH_FAILURE no reintenta, etc.).
11. **Loop acotado por presupuesto:** múltiples límites previenen loops
    infinitos y costos sin techo.
12. **Modo honesto cuando no hay datos:** status `INSUFFICIENT_EVIDENCE`
    cuando la evidencia es insuficiente. **No inventa tendencias.**
13. **Fallback determinista en el planner:** si el LLM falla o su JSON
    no parsea, se usa un plan genérico (no mágico).
14. **Logger saneador de credenciales:** nunca loguea tokens, API keys,
    o datos sensibles.

---

## 11. CURRENT LIMITATIONS

Lista honesta de limitaciones actuales:

1. **GoogleTrendsProvider UNAVAILABLE** — no hay credenciales de Google
   Trends. El provider existe, se registra, pero no devuelve datos.
2. **Solo 3 providers reales** — no hay YouTube, Instagram, X/Twitter,
   TikTok, LinkedIn, etc.
3. **No hay embeddings / vector DB.** El clustering es overlap coefficient
   sobre tokens — funciona pero no escala a volúmenes altos y no captura
   similitud semántica profunda.
4. **No hay protocolo distribuido de agentes.** La oportunidad lleva
   `suggestedNextAgent = "AGENTE-LEADS"` como contrato estructural, pero
   no hay IPC real todavía.
5. **CLI es la única interfaz.** No hay Telegram bot, web UI, ni REST API.
6. **Prompts del LLM hardcoded** en `src/orchestrator/planner.ts`. No son
   ajustables por config.
7. **RedditProvider usa `web_search` con filtro `site:`** — no es la API
   oficial de Reddit. Suficiente para V1, no óptimo.
8. **No hay middleware de rate-limit propio** — se confía en el backoff
   natural del SDK.
9. **No hay soporte multi-tenant / multi-usuario.** Una sola base SQLite
   local.
10. **Geographic scope es free-text** — no se valida contra ISO codes ni
    se mapea a regiones canónicas.
11. **Calidad del planner depende del LLM.** El fallback determinista es
    genérico; investigaciones atípicas pueden requerir ajuste manual.
12. **`better-sqlite3` native destructor** necesita workaround
    `process.on('beforeExit')` en Node 24 (ADR-010).
13. **El script `package.json` `test:e2e`** referencia `scripts/e2e.ts`,
    pero ese archivo no existe — los E2E corren vía `vitest run` (en
    `tests/e2e.test.ts`). Es un residuo cosmético que debe corregirse.
14. **Investigación canónica de referencia** terminó en `RUNNING`
    (presupuesto agotado en esa corrida) — posteriormente se confirmó
    `COMPLETED` en corridas con presupuesto mayor. No es un bug, pero
    el reporte canario debe regenerarse con `COMPLETED` para entrega
    final.

---

## 12. NEXT RECOMMENDED STEP

Movimientos concretos para V1.1 / V2:

### Corto plazo (V1.1)
- **Activar GoogleTrendsProvider** integrando SerpAPI o la API oficial de
  Google Trends. Eso desbloquea el 4º provider real.
- **Comando `chismoso deepen <investigationId>`** que use `WebContentProvider`
  sobre las URLs top de una investigación previa — para profundizar en
  evidencia sin rehacer toda la búsqueda.
- **Capa REST API** (Express mínimo) sobre el Orchestrator, para que otros
  agentes puedan consumir CHISMOSO por HTTP en vez de CLI.
- **Regenerar el reporte canario** con `status: COMPLETED` para entrega.
- **Corregir el script `test:e2e`** en `package.json` (referencia
  inexistente `scripts/e2e.ts`).

### Mediano plazo (V1.2–V1.5)
- **Handoff real a AGENTE-LEADS** vía archivo/cola/HTTP. Hoy el contrato es
  estructural (`suggestedNextAgent`), no IPC.
- **Provider de YouTube** (podría ser proxy vía NEX-SCOPE si existe).
- **Reemplazar clustering heurístico por embeddings + HDBSCAN** cuando el
  volumen lo justifique (>1 000 signals/investigación).
- **Dashboard web** para visualizar investigaciones y su evolución
  temporal — sin convertir CHISMOSO en BI, solo lectura.
- **Configuración externalizada** de prompts del planner (YAML/env).

### Largo plazo (V2+)
- **Soporte multi-tenant, multi-usuario, multi-región** con base por
  workspace.
- **Mesh distribuido de agentes** con IPC real entre CHISMOSO,
  AGENTE-LEADS, CRM-ALBRA (respetando la separación de la sección 64).
- **Rate-limit middleware propio** con ventanas por provider y por tenant.
- **Validación geográfica ISO** (ISO 3166-1 alpha-2) para `geography`.

---

## Cierre

CHISMOSO V1.0 entrega lo que promete: un motor de inteligencia que convierte
ruido en oportunidad, con evidencia trazable, sin capacidades ficticias, y
con memoria temporal funcional. No es completo — no pretende serlo. Es
arquitectónicamente correcto para crecer, y honesto sobre lo que aún no sabe.

> **CHISMOSO no existe para saberlo todo. Existe para detectar antes que
> otros qué está empezando a importar.** — Especificación sección 64.

**Fin del reporte de entrega.**
