# CHISMOSO V1.0 — ARQUITECTURA TÉCNICA

> Documento de arquitectura y auditoría (sección 49 de la especificación).
> Versión: 1.0 · Estado: completo · Idioma: español técnico.
> Audiencia: ingenieros que mantengan, extiendan o auditen CHISMOSO; agentes
> posteriores (AGENTE-LEADS, NEX-SCOPE, RADAR-SECOP2) que necesiten entender
> el contrato de interoperabilidad.

CHISMOSO es un agente de inteligencia que convierte un objetivo de alto nivel
en un reporte estructurado de señales, tendencias, problemas y oportunidades
de negocio. Su cerebro es determinista; el LLM sólo propone, los engines
deciden. Toda afirmación lleva `TruthLevel`. Toda afirmación lleva evidencia
trazable a una fuente real.

```
                 ┌──────────────────────────────────────────────┐
                 │                  CLI (cli.ts)                │
                 │  investigate | demo | providers | history    │
                 └──────────────────────┬───────────────────────┘
                                        │
                                        ▼
                 ┌──────────────────────────────────────────────┐
                 │              Orchestrator                    │
                 │  (orchestrator/orchestrator.ts)             │
                 │   ┌────────────┐  ┌──────────────────────┐  │
                 │   │  Planner   │  │  ToolRegistry         │  │
                 │   │  (LLM→JSON)│  │  (4 tools)            │  │
                 │   └────────────┘  └──────────────────────┘  │
                 │   budget-bounded loop (sección 26)          │
                 └──────┬───────────────────────┬───────────────┘
                        │                       │
                        ▼                       ▼
        ┌───────────────────────┐   ┌──────────────────────────┐
        │  Providers (4)        │   │  Intelligence engines    │
        │  web_search (real)    │   │  normalizer              │
        │  reddit_communities   │   │  clustering              │
        │  web_content          │   │  cross-source            │
        │  google_trends (UNA.) │   │  trends                  │
        └───────────┬───────────┘   │  problems                │
                    │               │  opportunities           │
                    ▼               └───────────┬──────────────┘
        ┌───────────────────────┐                │
        │  RawItem → Signal +   │◄───────────────┘
        │  Evidence (normalizer)│
        └───────────┬───────────┘
                    │
                    ▼
        ┌──────────────────────────────────────────────────────┐
        │   SQLite (better-sqlite3) — 9 tablas                │
        │   signals · evidence · trends · problems ·           │
        │   opportunities · investigations · provider_runs ·  │
        │   topics · topic_observations                       │
        └──────────────────────────────────────────────────────┘
                    │
                    ▼
        ┌──────────────────────────────────────────────────────┐
        │   Report Engine (reporter.ts)                        │
        │   → Markdown (humano) + IntelligenceReport (JSON)    │
        └──────────────────────────────────────────────────────┘
```

---

## ÍNDICE

1. [PARTE 1 — AUDIT (sección 49)](#parte-1--audit-sección-49)
   1.1 Current state
   1.2 Architecture
   1.3 Existing components
   1.4 Reusable components
   1.5 Technical debt
   1.6 Missing capabilities
   1.7 Risks
   1.8 Proposed V1 architecture (matches audit)
   1.9 Files to create / modify / preserve
2. [PARTE 2 — Referencia de componentes](#parte-2--referencia-de-componentes)
3. [PARTE 3 — Flujo de datos](#parte-3--flujo-de-datos)
4. [PARTE 4 — Decisiones arquitecturales (ADR)](#parte-4--decisiones-arquitecturales-adr)
5. [PARTE 5 — Fronteras (lo que CHISMOSO NO hace)](#parte-5--fronteras-lo-que-chismoso-no-hace)

---

## PARTE 1 — AUDIT (sección 49)

### 1.1 CURRENT STATE (estado inicial)

Antes de iniciar CHISMOSO, el directorio `/home/z/my-project/` contenía:

- `skills/` — catálogo de habilidades (z-ai-web-dev-sdk wrappers) disponibles
  para invocación por agentes.
- `z-ai-web-dev-sdk` instalado globalmente vía `bun` (versión 0.0.18),
  exponiendo:
  - `ZAI.create()` → instancia singleton del SDK.
  - `zai.functions.invoke('web_search', { query, num, recency_days })` →
    búsqueda web real.
  - `zai.functions.invoke('page_reader', { url })` → extracción de contenido
    de una URL (devuelve HTML + metadata).
  - `zai.chat.completions.create({ messages, thinking })` → LLM chat
    (compatible con la API de OpenAI).
- Node v24 disponible en el entorno (runtime).
- `better-sqlite3` disponible para instalar (driver SQLite síncrono nativo).
- `tsx` disponible para ejecutar TypeScript sin paso de compilación.
- `vitest` disponible para tests.

**No existía código de CHISMOSO. No existía base de datos. No existían
providers. No existía contract de modelos.** El directorio `chismoso/` fue
creado desde cero por el agente principal.

El punto de partida fue: «tienes un SDK que sabe buscar en la web, leer
páginas y razonar con LLM; construye un agente de inteligencia de negocio
end-to-end sin simular nada».

### 1.2 ARCHITECTURE (arquitectura en capas implementada)

CHISMOSO está organizado en **5 capas** con dependencias unidireccionales
de arriba hacia abajo. Ninguna capa inferior conoce a una superior. Esto
permite testear cada capa de forma aislada y sustituir implementaciones
sin romper el sistema.

```
┌─────────────────────────────────────────────────────────────────┐
│ CAPA 5 — INTERFAZ                                               │
│   src/cli.ts                                                     │
│   Responsabilidad: parseo de args, wiring de dependencias,       │
│   impresión de reportes. NO contiene lógica de negocio.          │
└────────────────────────────┬────────────────────────────────────┘
                             │ depende de
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ CAPA 4 — ORCHESTRATION                                          │
│   src/orchestrator/{llm,planner,tools,orchestrator,reporter}.ts │
│   Responsabilidad: planificar, ejecutar el loop, ensamblar el    │
│   reporte. Es el "cerebro" del agente.                          │
└────────────────────────────┬────────────────────────────────────┘
                             │ depende de
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ CAPA 3 — INTELLIGENCE                                           │
│   src/intelligence/{normalizer,clustering,cross-source,         │
│   trends,problems,opportunities}.ts                             │
│   Responsabilidad: normalizar, agrupar, detectar, puntuar.      │
│   Funciones puras (salvo logger) → testables sin DB.            │
└────────────────────────────┬────────────────────────────────────┘
                             │ depende de
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ CAPA 2 — PROVIDERS                                              │
│   src/providers/{base,web-search,reddit,web-content,           │
│   google-trends}.ts                                             │
│   Responsabilidad: hablar con APIs externas, devolver RawItem. │
│   No conocen Signal ni Evidence (eso es normalizer).            │
└────────────────────────────┬────────────────────────────────────┘
                             │ depende de
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ CAPA 1 — FOUNDATION                                             │
│   src/models.ts        — tipos canónicos                       │
│   src/errors.ts        — taxonomy de errores                   │
│   src/logger.ts        — observabilidad estructurada            │
│   src/db.ts            — SQLite schema + ChismosoDB             │
│   src/repositories.ts  — 7 repositorios                        │
│   src/config/index.ts  — config por env vars                   │
└─────────────────────────────────────────────────────────────────┘
```

**Propiedad clave:** toda dependencia con el exterior (ZAI SDK, better-sqlite3)
vive detrás de un adaptador en una capa inferior. Ningún engine, ni el
orchestrator, ni la CLI invocan `ZAI.create()` directamente. Esto permite
mockear el SDK en tests E2E y reemplazarlo en el futuro sin tocar lógica.

**Propiedad clave 2:** los engines de inteligencia son **funciones puras**.
`normalizeRawItem`, `clusterSignals`, `detectTrend`, `detectProblem`,
`generateOpportunity` reciben datos, devuelven datos, no tocan disco. La
persistencia vive en `repositories.ts` y es invocada por los tools /
orchestrator, no por los engines.

### 1.3 EXISTING COMPONENTS (inventario de módulos)

A continuación se lista cada módulo bajo `src/` con su responsabilidad.
La signatura pública exacta está en la PARTE 2.

| Módulo | Líneas aprox. | Responsabilidad |
|---|---|---|
| `src/models.ts` | 328 | Tipos canónicos (Signal, Evidence, Trend, Problem, Opportunity, Investigation, ProviderRun, TopicCluster, IntelligenceReport). Enums: TruthLevel, SignalType, SourceType, TrendState, InvestigationStatus, ProviderHealth. Helpers generateId(), nowISO(). DEFAULT_BUDGET. |
| `src/errors.ts` | 166 | ErrorCode enum (10 códigos), ChismosoErrorImpl class, retryStrategy() por código, classifyError() que mapea errores nativos a nuestro taxonomy. |
| `src/logger.ts` | 83 | Logger estructurado JSON a stdout. Niveles DEBUG/INFO/WARN/ERROR. Sanitiza apikey/token/secret/authorization/password. |
| `src/db.ts` | 268 | ChismosoDB class. Crea directorio si no existe. Aplica pragma WAL + foreign_keys. Ejecuta SCHEMA_V1 (9 tablas + 8 índices). Registrar handler `beforeExit` para cerrar handles abiertos (workaround segfault). |
| `src/repositories.ts` | 615 | SignalRepository, EvidenceRepository, TopicRepository, TrendRepository, ProblemRepository, OpportunityRepository, InvestigationRepository. Factory Repositories. |
| `src/providers/base.ts` | 110 | IProvider interface. RawItem, ProviderQuery, ProviderSearchResult. makeCapabilities() helper. ProviderRegistry class. |
| `src/providers/web-search.ts` | 113 | WebSearchProvider — real, usa `zai.functions.invoke('web_search', ...)`. Health check cacheado 30s. |
| `src/providers/reddit.ts` | 118 | RedditProvider — real, usa `web_search` con operador `site:reddit.com \| site:quora.com`. |
| `src/providers/web-content.ts` | 144 | WebContentProvider — real, usa `zai.functions.invoke('page_reader', ...)`. Sólo acepta queries con `urls[]`. stripHtml() interno. |
| `src/providers/google-trends.ts` | 55 | GoogleTrendsProvider — **UNAVAILABLE**. capabilities() declara status UNAVAILABLE. search() retorna siempre vacío con errorCode PROVIDER_UNAVAILABLE. NO simula datos. |
| `src/providers/index.ts` | 29 | Barrel. createDefaultProviderRegistry() registra los 4 providers. |
| `src/intelligence/normalizer.ts` | 240 | normalizeRawItem() → Signal + Evidence. inferSignalType() con patrones EN+ES. normalizeText(), tokenize() (stopwords ES+EN), extractKeyword(). rawConfidence() heurística. dedupSignals(), dedupEvidence() por url/snippet. |
| `src/intelligence/clustering.ts` | 133 | clusterSignals() — overlap coefficient ≥ 0.34. TopicCluster con canonical (token más frecuente). No usa embeddings. |
| `src/intelligence/cross-source.ts` | 52 | countDistinctSources(), countDistinctSourceTypes(), crossSourceConfidence() — 1 tipo=0.05, 2 tipos=0.22, 3+=0.35 boost. |
| `src/intelligence/trends.ts` | 180 | detectTrend() con 5 métricas (growth, persistence, crossSource, recency, velocity) - noise. classifyState() → 6 estados. TREND_WEIGHTS documentados. |
| `src/intelligence/problems.ts` | 194 | detectProblem() con FRICTION_PATTERNS (EN+ES). Requiere ≥2 snippets distintos. computeSeverity(), computeFrequency(), inferSegments(). Devuelve `null` si no hay base. |
| `src/intelligence/opportunities.ts` | 273 | generateOpportunity() con scoring transparente: demand, growth, problemSeverity, monetization, timing, marketFit, competition (neg), uncertainty (neg). OPPORTUNITY_WEIGHTS. suggestedNextAgent="AGENTE-LEADS". |
| `src/intelligence/index.ts` | ~10 | Barrel re-export. |
| `src/orchestrator/llm.ts` | 81 | LLMClient — wrap de zai.chat.completions.create(). Retry simple para RATE_LIMIT/TEMPORARY_FAILURE/TIMEOUT. |
| `src/orchestrator/planner.ts` | 131 | ResearchPlanner — usa LLM con PLANNER_SYSTEM_PROMPT, parsea JSON, filtra providers desconocidos. fallbackPlan() determinista si el LLM no responde. |
| `src/orchestrator/tools.ts` | 332 | 4 tools: search_web, search_community, collect_trends (no-op), deepen_content. ToolRegistry. createDefaultToolRegistry(). |
| `src/orchestrator/orchestrator.ts` | 382 | Orchestrator class — investigate() con loop budget-bounded. PROVIDER_TO_TOOL map. STEP 1-7. |
| `src/orchestrator/reporter.ts` | 243 | buildReport() → { markdown, machine: IntelligenceReport }. computeOverallConfidence, computeLimitations, computeNextAction, computeExecutiveSummary. |
| `src/orchestrator/index.ts` | 10 | Barrel. |
| `src/config/index.ts` | 29 | ChismosoConfig interface. DEFAULT_CONFIG por env vars: CHISMOSO_DB_PATH, CHISMOSO_LOG_LEVEL, CHISMOSO_GEOGRAPHY, CHISMOSO_OUTPUT_DIR. |
| `src/cli.ts` | 214 | CLI: investigate, demo, providers, history, show, help. Crea DB+repos+providers+tools+LLM+Orchestrator. |
| `src/index.ts` | ~5 | Entry point library. |

**Total src/: ~4,400 líneas** (excluyendo tests y scripts).

### 1.4 REUSABLE COMPONENTS (componentes reutilizados)

No se construyó infraestructura nueva cuando ya existía una solución madura:

| Componente | Origen | Uso en CHISMOSO |
|---|---|---|
| `z-ai-web-dev-sdk` v0.0.18 | Disponible global vía `bun` | Backend real de los 3 providers activos: `web_search`, `page_reader`, y `chat.completions` para el ResearchPlanner. **No se escribió ningún scraper propio, ningún cliente HTTP propio, ningún wrapper LLM propio.** |
| `better-sqlite3` | npm | Driver SQLite síncrono. Schema WAL + foreign_keys. Es la única dependencia de persistencia. |
| Node v24 | Entorno | Runtime. Se usa `node:fs`, `node:path`, `process.on('beforeExit')`. |
| `tsx` | npm | Ejecuta TypeScript sin build step. Permite `chismoso investigate ...` directo. |
| `vitest` | npm | Test runner. 41 tests (39 unit + 2 E2E). |
| `console` (built-in) | Node | Logger — JSON a stdout. Cero dependencias externas (no se usa winston ni pino). |
| `JSON.parse`/`JSON.stringify` | Built-in | Serialización de campos metadata_json, score_breakdown_json, evidence_json, signals_json. |
| Math + RegExp | Built-in | Todo el scoring y la detección de fricción son heurísticas deterministas sobre RegExp y aritmética básica. **No se usa ninguna librería de ML.** |

**Lo que NO se reutilizó y se descartó explícitamente:**

- No se usó `langchain` ni `llamaindex`: el orquestador del agente es
  código propio (300 líneas), más simple y trazable.
- No se usó `chromadb` ni `pinecone` ni `qdrant`: los embeddings no
  son necesarios para V1 (especificación sección 18).
- No se usó `express` ni `fastify`: no hay REST API en V1.
- No se usó `bull` ni `temporal` ni `inngest`: no hay colas de jobs;
  la investigación se ejecuta síncronamente en el proceso CLI.
- No se usó `typeorm` ni `prisma` ni `drizzle`: el SQL es manual en
  `repositories.ts`, 615 líneas, sin migraciones (schema CREATE IF NOT EXISTS).

### 1.5 TECHNICAL DEBT (deuda técnica honesta)

Esta sección es deliberadamente crítica. CHISMOSO V1 es funcional pero
tiene las siguientes deudas reconocidas:

1. **GoogleTrendsProvider UNAVAILABLE** (`src/providers/google-trends.ts`).
   No existe API oficial de Google Trends con credenciales disponibles en
   el entorno. El provider se registra (para que el sistema sepa que la
   categoría existe) pero `search()` siempre retorna `items: []` con
   `errorCode: PROVIDER_UNAVAILABLE`. **Limitación explícita en cada
   reporte** (`reporter.ts` → `computeLimitations()`). Para activarlo:
   configurar SerpAPI / OAuth / scraper dedicado y cambiar `capabilities().status`.

2. **No embeddings / no vector DB**. El clustering (`clustering.ts`) usa
   overlap coefficient sobre tokens superficialmente normalizados. No
   captura sinónimos ni paráfrasis. Ej: "reservas por WhatsApp" y
   "agendar por WhatsApp" pueden acabar en clusters distintos si no
   comparten tokens. **Decisión consciente** (especificación sección 18):
   no introducir infraestructura pesada sin necesidad. Deuda a saldar
   cuando el clustering heurístico deje de ser suficiente.

3. **No protocolo distribuido de agentes**. CHISMOSO no expone gRPC,
   ningún message queue, ningún handshake con AGENTE-LEADS. La
   interoperabilidad es por archivo (`.json` machine-readable) con el
   campo `suggestedNextAgent: "AGENTE-LEADS"`. Es un contrato
   semántico, no técnico.

4. **No Web UI**. La única interfaz es CLI (`src/cli.ts`). No hay
   dashboard, no hay visualización de trends en el tiempo, no hay
   exploración interactiva de evidencia. Pendiente para V2.

5. **LLM prompts hardcoded en `src/orchestrator/planner.ts`**.
   `PLANNER_SYSTEM_PROMPT` está embebido en el archivo. No hay
   mecanismo para cargar prompts desde disco, versionarlos, o A/B-testearlos.
   Si se quieren ajustar las reglas del planner, hay que editar el
   archivo y re-deployar.

6. **No rate-limit middleware**. Cada provider declara
   `limits.requestsPerMinute` en `capabilities()` pero nadie lo
   enforcea. El retry del LLM (`llm.ts`) usa `retryAfterMs` fijo.
   Si se ejecutan muchas investigaciones en paralelo, se puede agotar
   la cuota del SDK silenciosamente.

7. **`better-sqlite3` native destructor segfault workaround**.
   better-sqlite3 tiene un bug conocido: si el proceso Node termina
   y el GC colecciona un `Statement` nativo después del teardown, hay
   segfault. Workaround en `db.ts`:
   ```ts
   process.on('beforeExit', () => {
     for (const db of openDbs) { try { db.db.close(); } catch {} }
     openDbs.clear();
   });
   ```
   Y en `cli.ts`, `process.exit(0)` explícito después de cerrar la DB.
   No es elegante pero evita el crash en Node 24.

8. **`signal.topic` vs `trend.topic` mismatch**. El normalizer guarda
   `signal.topic = args.query` (la query del plan). El cluster
   genera `canonical` (token más frecuente). `trend.topic = canonical`.
   Por eso en el orchestrator hay un workaround explícito:
   ```ts
   const oppSignals = trend.signals.length > 0
     ? trend.signals
     : signals.filter((s) => s.topic === trend.topic);
   ```
   Deuda de modelado a limpiar en V2 (unificar `topic` a nivel de
   cluster, no de query).

9. **Schema sin migraciones**. `SCHEMA_V1` es un string con `CREATE TABLE
   IF NOT EXISTS`. Funciona para V1 pero no hay `schema_migrations`
   table ni mecanismo de upgrade. Si V2 añade columnas, hay que escribir
   migración manual.

10. **No tests de integración con la DB real**. Los tests E2E usan DB
    en `:memory:`. No hay test que valide el comportamiento bajo
    WAL concurrente. SQLite en WAL soporta lectores concurrentes pero
    un único writer — esto se asume pero no se testea bajo presión.

### 1.6 MISSING CAPABILITIES (lo que V1 NO hace)

Especificación: V1 entrega inteligencia; **no** entrega todo lo demás.
La lista siguiente es explícita para que ningún agente posterior asuma
que CHISMOSO cubre estas capacidades.

| Capability | Estado | Razón / referencia |
|---|---|---|
| Provider YouTube | ❌ No implementado | Especificación: NEX-SCOPE es el agente dedicado a YouTube (sección 44). CHISMOSO no debe duplicar esa capacidad. |
| Provider Instagram | ❌ No implementado | Requiere API oficial de Meta + OAuth. Fuera de alcance V1. |
| Provider X / Twitter | ❌ No implementado | Requiere API paga de X. Fuera de alcance V1. |
| Provider TikTok | ❌ No implementado | Requiere API oficial de TikTok for Developers. Fuera de alcance V1. |
| Clustering por embeddings | ❌ No implementado | Especificación sección 18: "no introducir infraestructura pesada sin necesidad". |
| Handoff distribuido a AGENTE-LEADS | ❌ No implementado | CHISMOSO sólo escribe `suggestedNextAgent: "AGENTE-LEADS"` en el reporte. No hay llamada de red (sección 43). |
| REST API | ❌ No implementado | V1 es CLI-only. |
| Web dashboard | ❌ No implementado | V1 es CLI-only. |
| Streaming de progreso | ❌ No implementado | El loop del orchestrator es síncrono. Logs a stderr mientras corre, pero no hay websocket. |
| Export a CSV / Excel | ❌ No implementado | Sólo markdown + JSON. |
| Multi-tenancy | ❌ No implementado | Una sola DB SQLite en `CHISMOSO_DB_PATH`. |
| Multi-idioma de prompts | ❌ No implementado | El planner usa prompt en inglés (mejor兼容ibilidad con LLM). Patrones de fricción son EN+ES. |
| Schedule / cron | ❌ No implementado | El usuario debe disparar manualmente `chismoso investigate`. |
| Notificación (email/Slack) | ❌ No implementado | Pendiente de V2. |
| Auth / RBAC | ❌ No implementado | No hay usuarios ni permisos. La DB local es de quien ejecuta el CLI. |

### 1.7 RISKS (riesgos)

1. **Dependencia del LLM (z-ai-web-dev-sdk chat.completions).**
   - Si el SDK está caído, `ResearchPlanner.plan()` atrapa el error y
     usa `fallbackPlan()` determinista (2 queries, 1 iteración). El
     pipeline sigue corriendo pero la calidad del plan baja drásticamente
     (queries idénticas al objetivo, sin descomposición en topics).
   - Mitigación: el planner es la única pieza que depende del LLM.
     Todo el resto (collect, normalize, cluster, detect, score, report)
     es determinista.

2. **Provider single-point-of-failure.** Solo 3 providers reales:
   `web_search`, `reddit_communities`, `web_content`. Los tres usan el
   mismo SDK subyacente (z-ai-web-dev-sdk). Si el SDK está caído, los
   tres caen simultáneamente. **No hay fallback a Bing, DuckDuckGo,
   Google Custom Search, o a una cache local.**

3. **SQLite no concurrent-safe para multi-proceso.** SQLite con WAL
   soporta múltiples lectores pero solo un writer a la vez. Si dos
   procesos CLI intentan escribir la misma DB, uno fallará con
   `SQLITE_BUSY`. **Adecuado para uso individual; inadecuado para
   servidor multi-tenant.**

4. **Calidad del normalizer.** `inferSignalType()` usa RegExp. Falsa
   clasificación (ej: un artículo que menciona "frustration" en
   contexto positivo será clasificado COMPLAINT_SPIKE). Impacto:
   ruido en `detectProblem()`. Mitigación: `detectProblem()` requiere
   ≥2 snippets distintos, lo que filtra falsos positivos aislados.

5. **LLM hallucination en el planner.** El LLM puede inventar
   `providerName` no soportados. Mitigación en `safeParsePlan()`
   (`planner.ts:98-99`): filtra queries con providers que no sean
   `web_search` o `reddit_communities`.

6. **Latencia del loop.** Cada investigación ejecuta 4-12 queries
   secuenciales (web_search, reddit_communities por cada topic del
   plan). Sin paralelismo. Budget por defecto: 5 minutos
   (`DEFAULT_BUDGET.maxRuntimeMs = 5*60*1000`). Si el SDK responde
   lento, se corta con `INSUFFICIENT_EVIDENCE` o `PARTIAL`.

7. **Token cost del LLM.** El planner se llama una vez por
   investigación con un prompt de ~600 tokens + objetivo del usuario.
   No se llama en el loop de collect. Si se amplía a multi-turn
   (re-planificación tras ver resultados), el costo escala.

8. **Evolución del schema de la SDK.** z-ai-web-dev-sdk v0.0.18 expone
   `functions.invoke('web_search', ...)` y `page_reader`. Si una
   versión futura cambia el contract, los 3 providers reales se
   rompen simultáneamente. Mitigación: `classifyError()` captura y
   etiqueta, pero no hay pinning semver en `package.json`.

9. **Pérdida de la DB = pérdida de memoria.** `topics`, `topic_observations`,
   `trends` históricos viven en SQLite. Si se borra la DB, se pierde
   la capacidad de calcular `growth` y `persistence` (que requieren
   `historicalSignals`). Mitigación: el código asume `historicalSignals=[]
   ` y degrada gracefully, pero las tendencias pierden precisión.

### 1.8 PROPOSED V1 ARCHITECTURE (lo que se construyó, matches audit)

La arquitectura propuesta en la especificación y la arquitectura
implementada **coinciden**. Resumen:

- **5 capas** con dependencias unidireccionales (Foundation → Providers →
  Intelligence → Orchestrator → CLI).
- **4 providers** registrados, 3 reales + 1 UNAVAILABLE (google_trends).
- **7 repositorios** sobre SQLite WAL.
- **6 engines de inteligencia** (normalizer, clustering, cross-source,
  trends, problems, opportunities), todos funciones puras.
- **4 tools** envueltos sobre los providers, con persistencia inline.
- **1 orchestrator** con loop budget-bounded, status tracking, manejo
  de errores por query (no aborta todo si una falla).
- **1 planner** LLM-driven con fallback determinista.
- **1 reporter** que produce markdown + JSON con TruthLevel annotations.
- **1 CLI** con 5 commands (investigate, demo, providers, history, show).

```
        ┌─────────────────────────────────────────────┐
        │ chismoso investigate "..." --geography CO  │
        └─────────────────────┬───────────────────────┘
                              │
                              ▼
        ┌─────────────────────────────────────────────┐
        │ Orchestrator.investigate(input)             │
        │   1. create Investigation (status=RUNNING) │
        │   2. planner.plan()  ──→ LLM (JSON)         │
        │      fallback → deterministic plan          │
        │   3. loop queries (budget-bounded):         │
        │        PROVIDER_TO_TOOL map → tool.execute  │
        │        tool → provider.search() → RawItem[] │
        │        → normalizeRawItem() → Signal+Evidence│
        │        → dedup → persist + ProviderRun       │
        │   4. clusterSignals()                       │
        │   5. por cluster: detectTrend + detectProblem│
        │   6. por trend(+problem): generateOpportunity│
        │   7. buildReport() → markdown + JSON        │
        │   8. set status (COMPLETED/PARTIAL/...)     │
        │   9. persist Investigation                   │
        └─────────────────────┬───────────────────────┘
                              │
                              ▼
        ┌─────────────────────────────────────────────┐
        │ stdout: markdown                            │
        │ --save → report-<id>.md + report-<id>.json  │
        └─────────────────────────────────────────────┘
```

### 1.9 FILES TO CREATE / MODIFY / PRESERVE (inventario real)

#### Created (creados en V1.0)

```
/home/z/my-project/chismoso/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .gitignore
├── src/
│   ├── index.ts                     (entry point library)
│   ├── models.ts                    (328 líneas)
│   ├── errors.ts                    (166 líneas)
│   ├── logger.ts                    (83 líneas)
│   ├── db.ts                         (268 líneas)
│   ├── repositories.ts              (615 líneas)
│   ├── cli.ts                       (214 líneas)
│   ├── config/
│   │   └── index.ts                  (29 líneas)
│   ├── providers/
│   │   ├── base.ts                   (110 líneas)
│   │   ├── web-search.ts            (113 líneas)
│   │   ├── reddit.ts                 (118 líneas)
│   │   ├── web-content.ts            (144 líneas)
│   │   ├── google-trends.ts          (55 líneas)
│   │   └── index.ts                  (29 líneas)
│   ├── intelligence/
│   │   ├── normalizer.ts             (240 líneas)
│   │   ├── clustering.ts             (133 líneas)
│   │   ├── cross-source.ts           (52 líneas)
│   │   ├── trends.ts                 (180 líneas)
│   │   ├── problems.ts               (194 líneas)
│   │   ├── opportunities.ts          (273 líneas)
│   │   └── index.ts                  (~10 líneas)
│   └── orchestrator/
│       ├── llm.ts                    (81 líneas)
│       ├── planner.ts                (131 líneas)
│       ├── tools.ts                   (332 líneas)
│       ├── orchestrator.ts            (382 líneas)
│       ├── reporter.ts                (243 líneas)
│       └── index.ts                  (10 líneas)
├── tests/
│   ├── normalizer.test.ts
│   ├── errors.test.ts
│   ├── clustering.test.ts
│   ├── trends.test.ts
│   ├── opportunities.test.ts
│   ├── providers-db.test.ts
│   └── e2e.test.ts                   (canonical investigation real)
├── scripts/
│   ├── smoke.ts
│   ├── inspect.ts
│   └── list-signals.ts
└── docs/
    └── ARCHITECTURE.md               (este archivo)
```

#### Created by canonical run (output artifacts)

```
/home/z/my-project/chismoso/data/chismoso.db          (SQLite, persistente)
/home/z/my-project/download/chismoso/
├── report-inv_muvfmcw36y3lps.md                      (167 líneas)
└── report-inv_muvfmcw36y3lps.json                     (machine-readable)
```

#### Modify (no modificados en V1 — listados para V2)

Ningún archivo del entorno fue modificado fuera de `chismoso/`. No se
tocó `skills/`, no se tocó el runtime bun, no se instalaron paquetes
globales adicionales. **V1 es completamente auto-contenido en
`chismoso/`.**

#### Preserve (preservar en V2)

- `src/models.ts` — el contract de tipos es la interfaz pública del
  agente. Cualquier cambio debe ser backward-compatible o requerir bump.
- `src/errors.ts` — el `ErrorCode` enum es usado por todos los providers
  y tools. No renombrar valores existentes.
- `src/db.ts` `SCHEMA_V1` — las 9 tablas son contract de persistencia.
  Añadir columnas OK; renombrar/eliminar tablas requiere migración.
- El campo `suggestedNextAgent: "AGENTE-LEADS"` en `Opportunity` es el
  punto de interoperabilidad con el siguiente agente del pipeline.
- El campo `TruthLevel` en cada `Signal`/`Evidence`/`Trend`/
  `Opportunity` es no-negociable. Toda afirmación debe llevarlo.

---

## PARTE 2 — REFERENCIA DE COMPONENTES

### 2.1 `src/models.ts` — Modelos canónicos

**Propósito.** Define los tipos que cruzan todo el sistema. Es la única
fuente de verdad para la forma de los datos. Sigue la semántica de la
especificación (secciones 5, 6, 13, 14, 15, 19, 20, 26, 27, 32) pero
ajusta tipos para TypeScript (ej: `value: number | string` en lugar de
`any`).

**API pública clave:**
- `enum TruthLevel { OBSERVED, DERIVED, INFERRED, PREDICTED, UNKNOWN }`
- `enum SignalType { SEARCH_SPIKE, MENTION_SPIKE, QUESTION_SPIKE, COMPLAINT_SPIKE, CONTENT_GROWTH, ENGAGEMENT_GROWTH, NEW_PRODUCT, NEW_BEHAVIOR, PRICE_CHANGE, DEMAND_SIGNAL, PROBLEM_SIGNAL, MARKET_SIGNAL }`
- `enum SourceType { SEARCH_WEB, GOOGLE_TRENDS, REDDIT_COMMUNITIES, YOUTUBE, SOCIAL_MEDIA, WEB_CONTENT }`
- `enum TrendState { NOISE, WEAK_SIGNAL, EMERGING_TREND, STRONG_TREND, ESTABLISHED_TREND, DECLINING_TREND }`
- `enum InvestigationStatus { RUNNING, COMPLETED, PARTIAL, FAILED, INSUFFICIENT_EVIDENCE }`
- `enum ProviderHealth { OK, DEGRADED, UNAVAILABLE, AUTH_REQUIRED, RATE_LIMITED }`
- Interfaces: `Signal`, `Evidence`, `Trend`, `Problem`, `Opportunity`,
  `Investigation`, `InvestigationBudget`, `ProviderRun`, `TopicCluster`,
  `ProviderCapabilities`, `IntelligenceReport`.
- `DEFAULT_BUDGET = { maxIterations: 3, maxQueries: 12, maxSources: 5, maxResults: 60, maxRuntimeMs: 5*60*1000, maxProviderCalls: 15 }`.
- `generateId(prefix)` — IDs deterministic (timestamp base36 + random 6 chars).
- `nowISO()` — ISO timestamp.

**Dependencias:** ninguna (archivo puro de tipos).

**Anti-patterns evitados:**
- No hay tipos `any` sueltos; `metadata: Record<string, unknown>` en su
  lugar.
- No hay herencia — interfaces planas, composición sobre herencia.
- No hay validación runtime — los tipos son contract; los repositorios
  serializan con `JSON.stringify` asumiendo que la forma ya está validada
  por el constructor.

### 2.2 `src/errors.ts` — Taxonomía de errores

**Propósito.** Normaliza los errores de toda la red y del SDK en 10
códigos. El comportamiento (retry / fallback / abort) se decide por
código, no por catch-all.

**API pública:**
- `enum ErrorCode { OK, TEMPORARY_FAILURE, AUTH_FAILURE, RATE_LIMIT, EMPTY_RESULT, INVALID_INPUT, TIMEOUT, PROVIDER_UNAVAILABLE, PARSE_ERROR, QUOTA_EXCEEDED, UNKNOWN }`.
- `class ChismosoErrorImpl extends Error implements ChismosoError` con
  `toJSON()`.
- `retryStrategy(code): { retryable, maxRetries, baseDelayMs, backoffMultiplier }`.
  - RATE_LIMIT: retry, max 2, 2000ms base, ×2.
  - TEMPORARY_FAILURE: retry, max 2, 800ms, ×1.5.
  - TIMEOUT: retry, max 1, 1500ms, ×2.
  - Resto: no retry.
- `classifyError(err, providerName?)` — mapea errores nativos a
  ChismosoError mirando el mensaje (case-insensitive). Detecta: rate,
  timeout, auth (401/403), quota, empty, fetch/network.

**Dependencias:** `models.ts` (importa types pero no lógica).

**Anti-patterns evitados:**
- No se hace `retry on any error`. Los errores no-retryables abortan
  inmediatamente.
- `retryAfterMs` es sugerencia, no obligación — el caller decide.
- `classifyError()` nunca lanza; siempre devuelve un `ChismosoErrorImpl`.

### 2.3 `src/logger.ts` — Observabilidad estructurada

**Propósito.** Logger JSON a stdout sin dependencias externas. Niveles
DEBUG/INFO/WARN/ERROR. **Sanitiza credenciales** antes de imprimir.

**API pública:**
- `enum LogLevel { DEBUG, INFO, WARN, ERROR }`.
- `setLogLevel(level)`, `getLogLevel()`.
- `logger.{debug|info|warn|error}(msg, ctx?)` — `ctx` es un objeto
  arbitrario que se serializa con sanitización.
- `SENSITIVE_KEYS = ['apikey', 'api_key', 'token', 'password', 'secret', 'authorization', 'auth']`.
  Cualquier key cuyo lowercased name esté en la lista se reemplaza con
  `[REDACTED]`.

**Dependencias:** ninguna.

**Anti-patterns evitados:**
- No se usa `console.log` directamente fuera del logger.
- No se imprimen objetos sin sanitizar — siempre pasan por `sanitize()`.
- `ERROR` va a `stderr` (`console.error`), resto a `stdout` (`console.log`).

### 2.4 `src/db.ts` + `src/repositories.ts` — Persistencia

**Propósito.** `db.ts` encapsula better-sqlite3 con WAL, foreign_keys,
y crea el schema V1 (9 tablas + 8 índices). `repositories.ts` expone
7 repositorios que serializan/deserializan modelos desde/hacia SQLite.

**API pública `ChismosoDB`:**
- `constructor(config: DBConfig)` — crea directorio, abre DB, aplica
  pragmas, ejecuta schema, registra en `openDbs` para cleanup.
- `prepare(sql): Statement`.
- `transaction<T>(fn): (...args) => T`.
- `close()` — cierra y se desregistra.
- `get raw(): DB` — acceso al better-sqlite3 subyacente para queries
  ad-hoc.

**Schema V1 (9 tablas):**
- `schema_meta` (key/value, versión 1.0).
- `topics` (id, canonical, keywords_json, sources_count, first_seen,
  last_seen, observation_count, created_at, updated_at).
- `signals` (id, topic, keyword, source, source_type, timestamp,
  geography, metric, value, normalized_value, direction, velocity,
  confidence, evidence_type, signal_type, metadata_json, raw_snippet,
  url, investigation_id, created_at). 4 índices.
- `evidence` (id, source, source_type, url, observed_at, collected_at,
  geographic_scope, topic, raw_value, normalized_value, confidence,
  evidence_type, metadata_json, investigation_id, created_at). 2 índices.
- `trends` (id, topic, description, state, confidence, sources_count,
  signals_count, first_seen, last_seen, observation_count, growth,
  velocity, persistence, cross_source_confirmation, score,
  score_breakdown_json, evidence_json, signals_json, created_at,
  updated_at, investigation_id). 1 índice.
- `problems` (id, description, topic, severity, frequency, confidence,
  segments_json, first_seen, last_seen, observation_count,
  evidence_json, signals_json, created_at, investigation_id).
- `opportunities` (id, title, description, problem, problem_ref,
  target_segment, geography, demand, growth, problem_severity,
  monetization, timing, market_fit, competition, uncertainty, score,
  score_breakdown_json, confidence, suggested_next_agent, trend_ref,
  evidence_json, created_at, investigation_id). 1 índice por score DESC.
- `investigations` (id, query, scope, started_at, completed_at, status,
  providers_json, queries_json, signals_found, evidence_found,
  trends_found, problems_found, opportunities_found, errors_json,
  duration_ms, iterations, budget_json, provider_runs_json). 1 índice
  por status.
- `provider_runs` (id autoincrement, investigation_id, provider_name,
  started_at, completed_at, query, results_count, error, error_code,
  duration_ms).
- `topic_observations` (id autoincrement, topic, observed_at,
  sources_count, signals_count, evidence_count, confidence, note).
  2 índices (topic + time).

**API pública `Repositories`:**
- `SignalRepository.insert(s, investigationId?)`, `.insertMany(signals, invId)`,
  `.findByTopic(topic)`, `.findByInvestigation(invId)`,
  `.countSince(topic, sinceISO)`, `.countBySourceType(sinceISO)`,
  `.distinctKeywords(topic)`.
- `EvidenceRepository.insert(e, invId?)`, `.findByTopic(topic, limit)`,
  `.findByInvestigation(invId)`.
- `TopicRepository.upsert(cluster)`, `.findByCanonical(canonical)`,
  `.recordObservation(topic, sources, signals, evidence, conf, note?)`,
  `.getHistory(topic, limit)`.
- `TrendRepository.insert(t, invId?)`, `.findByTopic(topic)`,
  `.latest(limit)`, `.findByInvestigation(invId)`.
- `ProblemRepository.insert(p, invId?)`, `.findByInvestigation(invId)`.
- `OpportunityRepository.insert(o, invId?)`, `.findTop(limit)`,
  `.findByInvestigation(invId)`.
- `InvestigationRepository.insert(inv)`, `.update(inv)`,
  `.recordProviderRun(invId, run)`, `.listProviderRuns(invId)`,
  `.get(id)`.

**Dependencias:** `better-sqlite3`, `node:fs`, `node:path`, `logger.ts`,
`models.ts`.

**Anti-patterns evitados:**
- Los repositorios **no** contienen lógica de negocio. Sólo serializan
  y deserializan.
- Los `INSERT` usan parámetros posicionales (`?`) — no concatenación
  de strings. SQL injection no es posible por esta capa.
- Los `INSERT INTO signals (...) VALUES (?,?,?,?,...)` con 20 columnas
  son explícitos — no se usa `INSERT *`.
- `insertMany` envuelve todo en `transaction()` para atomicidad.

### 2.5 `src/providers/` — Capa de providers

#### 2.5.1 `base.ts` — Abstracción

**Propósito.** Define `IProvider`, el contract que todo provider
implementa. Define `RawItem` (el formato bruto pre-normalización) y
`ProviderRegistry` (descubrimiento + selección).

**API pública:**
- `interface ProviderQuery { query, num?, geography?, recencyDays? }`.
- `interface RawItem { providerName, sourceType, title?, snippet, url?, hostName?, date?, rawMetadata? }`.
- `interface ProviderSearchResult { providerName, items, error?, errorCode?, durationMs, query }`.
- `interface IProvider { capabilities(), canHandle(query), health(), search(query) }`.
- `makeCapabilities(name, type, capabilities, status, authentication, limits)` — helper.
- `class ProviderRegistry` — `register(provider)`, `list()`, `get(name)`,
  `availableFor(query)`, `allHealth()`.

**Anti-patterns evitados:**
- El registry **no conoce** las clases concretas de providers — sólo la
  interfaz `IProvider`. Permite test con mocks.

#### 2.5.2 `web-search.ts` — Real

**Propósito.** Provider real que usa `zai.functions.invoke('web_search',
{ query, num, recency_days })`. Cubre la categoría SEARCH_WEB.

**API pública:** implementa `IProvider`.
- `capabilities()` → `{ name: 'web_search', type: SEARCH_WEB, capabilities: ['search', 'collect', 'normalize'], status: OK, authentication: 'none', limits: { requestsPerMinute: 30, maxResultsPerCall: 20 } }`.
- `canHandle()` → siempre true (acepta cualquier query textual).
- `health()` → cachea estado 30s, hace sanity check de `ZAI.create()`.
- `search(q)` → invoca `web_search`, mapea `r` a `RawItem` con
  `{ providerName, sourceType, title: r.name, snippet: r.snippet, url: r.url, hostName: r.host_name, date: r.date, rawMetadata: { rank, favicon } }`.

**Dependencias:** `z-ai-web-dev-sdk`, `base.ts`, `errors.ts`, `logger.ts`,
`models.ts`.

#### 2.5.3 `reddit.ts` — Real (comunidades)

**Propósito.** Provider real que usa `web_search` con operador `site:`.
No es un wrapper de la API oficial de Reddit — es un patrón de búsqueda
recortada a `reddit.com | quora.com`.

**API pública:** implementa `IProvider`.
- `capabilities()` → `{ name: 'reddit_communities', type: REDDIT_COMMUNITIES, status: OK, limits: { requestsPerMinute: 20, maxResultsPerCall: 20 } }`.
- `buildCommunityQuery(query)` — prepend `(site:reddit.com | site:quora.com)`
  si la query no incluye `site:`.
- `search(q)` → llama a `web_search` con la query modificada.

**Anti-patterns evitados:** No se simulan resultados de Reddit. Si
`web_search` no devuelve nada de esos dominios, `items: []`.

#### 2.5.4 `web-content.ts` — Real (profundización)

**Propósito.** Provider real que usa `zai.functions.invoke('page_reader',
{ url })`. **No es de descubrimiento** — profundiza URLs ya candidatas.

**API pública:** implementa `IProvider`.
- `capabilities()` → `{ name: 'web_content', type: WEB_CONTENT, status: OK, limits: { requestsPerMinute: 15, maxResultsPerCall: 5 } }`.
- `canHandle(q)` → solo si `q.urls` es array no vacío.
- `search(q)` → `Promise.allSettled` sobre `urls.slice(0, 5)`, cada uno
  llama a `page_reader`. Para cada resultado, hace `stripHtml()` sobre
  `data.html` y guarda `snippet` (1000 chars) + `rawMetadata.fullText`
  (5000 chars).
- `WebContentQuery extends ProviderQuery { urls: string[] }`.

**Anti-patterns evitados:** `Promise.allSettled` (no `Promise.all`) —
un URL que falle no aborta todo el batch.

#### 2.5.5 `google-trends.ts` — UNAVAILABLE

**Propósito.** Provider registrado pero **UNAVAILABLE**. Cubre la
categoría GOOGLE_TRENDS del enum pero no devuelve datos. NO simula.

**API pública:** implementa `IProvider`.
- `capabilities()` → `{ name: 'google_trends', type: GOOGLE_TRENDS, status: UNAVAILABLE, authentication: 'oauth', limits: { requestsPerMinute: 5, maxResultsPerCall: 10 } }`.
- `canHandle()` → true (declara interés).
- `health()` → siempre `ProviderHealth.UNAVAILABLE`.
- `search(q)` → retorna siempre:
  ```ts
  { providerName: 'google_trends', items: [], error: 'GoogleTrendsProvider UNAVAILABLE — no credentials configured', errorCode: ErrorCode.PROVIDER_UNAVAILABLE, durationMs: 0, query: q.query }
  ```

**Razón:** no existe API oficial de Google Trends con credenciales
disponibles. Para activarlo: implementar `search()` con SerpAPI / OAuth
y cambiar `capabilities().status` a `OK`. El resto del sistema no
requiere cambios.

### 2.6 `src/intelligence/` — Engines de inteligencia

#### 2.6.1 `normalizer.ts`

**Propósito.** Convierte `RawItem` → `Signal + Evidence`. Limpia la
heterogeneidad entre fuentes.

**API pública:**
- `inferSignalType(snippet, sourceType): SignalType` — patrones EN+ES,
  clasifica en QUESTION_SPIKE / COMPLAINT_SPIKE / NEW_PRODUCT /
  PROBLEM_SIGNAL / CONTENT_GROWTH / DEMAND_SIGNAL / MENTION_SPIKE.
- `normalizeText(s)` — lowercase, NFD, sin acentos, sin puntuación,
  espacios colapsados.
- `tokenize(s): string[]` — divide, filtra stop-words ES+EN y
  palabras <3 chars.
- `extractKeyword(snippet, topicHint?)` — keyword más frecuente.
- `rawConfidence(item): number` — 0..0.95, suma puntos por URL
  válida, title >10, snippet >100, fecha con año, sourceType
  conocido.
- `normalizeRawItem(item, ctx): { signal, evidence }` — genera IDs,
  asigna `evidenceType = OBSERVED`, `metric = 'mention_count'`,
  `value = 1`, `direction = 'up'`, `velocity = 0`.
- `dedupSignals(signals)` / `dedupEvidence(evidence)` — por URL o
  por snippet (200 chars).

**Dependencias:** `providers/base.ts` (RawItem), `models.ts`.

**Anti-patterns evitados:** No se llama a la DB. Función pura.

#### 2.6.2 `clustering.ts`

**Propósito.** Agrupa señales por similitud de keywords. Produce
`TopicCluster` con canonical label.

**API pública:**
- `clusterSignals(signals, threshold = 0.34): ClusterResult` — retorna
  `{ clusters: TopicCluster[], signalToCluster: Map<string, string> }`.
- Threshold 0.34 = overlap coefficient mínimo para unir a un cluster
  existente.

**Algoritmo:**
1. Para cada signal, tokeniza `keyword + topic + rawSnippet.slice(0,200)`.
2. Para cada cluster existente, calcula `intersection / min(|a|, |b|)`
   (overlap coefficient, **no** Jaccard — ver ADR-005).
3. Si best score ≥ threshold, asigna al cluster y actualiza tokens.
4. Si no, crea cluster nuevo.
5. Al final, refresca `canonical` con el token más frecuente.

**Dependencias:** `models.ts`, `normalizer.ts` (tokenize, normalizeText).

**Anti-patterns evitados:**
- No embeddings (especificación sección 18).
- No se re-clasifica señales ya asignadas (single-pass greedy).

#### 2.6.3 `cross-source.ts`

**Propósito.** Confidence boost por diversidad de fuentes.

**API pública:**
- `countDistinctSources(signals)` — `new Set(signals.map(s => s.source)).size`.
- `countDistinctSourceTypes(signals)` — `new Set(signals.map(s => s.sourceType)).size`.
- `crossSourceConfidence(signals): number` — `0..0.95`:
  - base = `min(0.5, signals.length * 0.07)` (volumen moderado).
  - boost por tipos: 1 tipo=0.05, 2 tipos=0.22, 3+ tipos=0.35.
  - total = `min(0.95, base + boost)`.
- `sourcesPresent(signals): SourceType[]`.

**Dependencias:** `models.ts`.

#### 2.6.4 `trends.ts`

**Propósito.** Determina si un cluster es tendencia y en qué estado.

**API pública:**
- `TREND_WEIGHTS = { growth: 0.25, persistence: 0.2, crossSource: 0.25, recency: 0.15, velocity: 0.15 }`.
- `detectTrend(input: TrendInput): TrendResult` — retorna `{ trend: Trend }`.
  - `input.historicalSignals` (opcional) permite calcular growth y
    persistence temporal.
  - Sin historial: growth=1, persistence baja.
  - Recency: señales en últimos 30 días.
  - Noise: fracción de señales con snippet <30 chars.
  - Score = clamp(0, 1, Σ(weights × metrics) - 0.15 × noise) × 100.
- `classifyState(opts)` → 6 estados:
  - `signalsCount < 3` o `score < 0.25` → NOISE.
  - `score < 0.45` → WEAK_SIGNAL.
  - `persistence > 0.6 && score > 0.7 && growth < 0.8` → ESTABLISHED_TREND.
  - `growth > 1.2 && persistence > 0.4 && score < 0.6` → DECLINING_TREND.
  - `sourcesCount >= 3 && sourceTypesCount >= 2 && score > 0.7` → STRONG_TREND.
  - `sourcesCount >= 2 && score > 0.5` → EMERGING_TREND.
  - default → WEAK_SIGNAL.

**Dependencias:** `models.ts`, `cross-source.ts`, `logger.ts`.

**Anti-patterns evitados:**
- Pesos documentados en constante, no magic numbers inline.
- Score siempre acompañado de `scoreBreakdown` para auditoría.

#### 2.6.5 `problems.ts`

**Propósito.** Detecta problemas emergentes con evidencia de fricción
repetida. Sentimiento negativo ≠ problema (sección 19).

**API pública:**
- `FRICTION_PATTERNS` — array de RegExp EN+ES (preguntas, quejas,
  wishes, necesidad). Case-insensitive, sin acentos.
- `detectProblem(input: ProblemInput): ProblemResult` — retorna
  `{ problem: Problem | null, reasons: string[] }`.
  - Pool 1: señales con `signalType` en `{COMPLAINT_SPIKE, QUESTION_SPIKE, PROBLEM_SIGNAL}`.
  - Pool 2: cualquier signal cuyo snippet matchee `FRICTION_PATTERNS`.
  - Unión de pools.
  - Si `<2` candidatos → `problem: null`.
  - Si `<2` snippets distintos → `problem: null` (evita duplicados).
  - `computeSeverity()` = `0.6 × intensity + 0.4 × volume`.
  - `computeFrequency()` = `min(100, signals.length / 20 × 100)`.
  - `inferSegments()` — regex sobre sustantivos de segmento
    (restaurant, pyme, retail, startup, etc.).

**Dependencias:** `models.ts`, `logger.ts`.

**Anti-patterns evitados:**
- Devuelve `null` explícitamente si no hay base — CHISMOSO no inventa
  problemas.
- `reasons[]` explica por qué se detectó o no — auditoría.

#### 2.6.6 `opportunities.ts`

**Propósito.** Convierte (trend, problem, signals) en una oportunidad
accionable con score transparente.

**API pública:**
- `OPPORTUNITY_WEIGHTS = { demand: 0.18, growth: 0.18, problemSeverity: 0.16, monetization: 0.14, timing: 0.12, marketFit: 0.12, competition: -0.05, uncertainty: -0.09 }`.
- `generateOpportunity(input: OpportunityInput): OpportunityResult` —
  retorna `{ opportunity, weak }`.
  - `demand` = `0.4 × vol + 0.4 × trendScore + 0.2 × crossSource`.
  - `growth` = trend.growth × 100, o fallback por recencia.
  - `problemSeverity` = problem.severity, o 30 si solo hay trend.
  - `monetization` = problem.severity × 0.6 + bonus por keywords de
    pago, penalizado si menciona "free/gratis".
  - `timing` = base 50 + bonus por EMERGING/STRONG, penalización por
    DECLINING/NOISE, bonus por recencia (14 días).
  - `marketFit` = 40 + (community_signals/total × 50).
  - `competition` = 30 + matches de "alternative|competitor|vs" × 8.
  - `uncertainty` = 100 - max(trend.confidence, problem.confidence) × 100,
    +15 si <5 signals, -10 si >20.
  - `score100` = clamp100(raw / 1.04). Normalización por suma de
    pesos absolutos.
  - `confidence` = `0.6 × trend.confidence + 0.4 × problem.confidence`.
  - `suggestedNextAgent = "AGENTE-LEADS"`.
  - `weak = score100 < 35 || confidence < 0.3`.

**Dependencias:** `models.ts`, `logger.ts`.

**Anti-patterns evitados:**
- Pesos documentados en constante exportable. No magic numbers.
- `scoreBreakdown` siempre en el output — el reporte explica el score.
- Nunca afirma "esta oportunidad generará dinero" (sección 22).

### 2.7 `src/orchestrator/` — Orquestación

#### 2.7.1 `llm.ts`

**Propósito.** Wrap de `zai.chat.completions.create()`. Retry simple.

**API pública:**
- `interface ChatMessage { role: 'system'|'user'|'assistant'; content: string }`.
- `interface LLMResponse { content, raw, durationMs, tokens? }`.
- `class LLMClient` con `chat(messages, opts?: { thinking?: boolean })`.
  - Si error es RATE_LIMIT / TEMPORARY_FAILURE / TIMEOUT: 1 retry con
    `retryAfterMs ?? 1500`.
  - Si no: throw `Error('LLM unavailable: ...')`.

**Dependencias:** `z-ai-web-dev-sdk`, `logger.ts`, `errors.ts`.

#### 2.7.2 `planner.ts`

**Propósito.** Convierte un objetivo en un plan JSON ejecutable. NO
ejecuta — solo planifica.

**API pública:**
- `interface ResearchPlan { scope, geography, topics: string[], queries: Array<{ providerName, query, rationale }>, iterations }`.
- `class ResearchPlanner` con `plan(input: PlanInput): Promise<ResearchPlan>`.
- `PLANNER_SYSTEM_PROMPT` — prompt en inglés que pide JSON con topics,
  queries (mix de web_search + reddit_communities), iterations 1-2.
- `safeParsePlan(content)` — extrae JSON, valida shape, **filtra
  queries con providers desconocidos** (sólo permite `web_search` y
  `reddit_communities`).
- `fallbackPlan(input)` — determinista: 2 queries (web_search +
  reddit_communities) idénticas al objetivo, 1 iteración.

**Dependencias:** `llm.ts`, `logger.ts`.

**Anti-patterns evitados:**
- El planner no decide cuándo detenerse — el orchestrator lo hace con
  budget.
- El planner no llama a providers.

#### 2.7.3 `tools.ts`

**Propósito.** 4 tools — las "manos" del agente. El LLM NO llama
providers directamente; llama tools, y los tools encapsulan provider +
normalizer + dedup + persistencia + ProviderRun.

**API pública:**
- `interface ToolContext { investigationId, geography, repositories, providerRegistry }`.
- `interface ToolDefinition<Args, Resp> { name, description, execute(args, ctx) }`.
- `class ToolRegistry` — `register(tool)`, `get(name)`, `list()`, `describe()`.
- `createDefaultToolRegistry()` — registra los 4 tools.
- 4 tools implementados:
  - `searchWebTool` (`search_web`) — llama `web_search`, normaliza,
    dedup, persiste signals+evidence, registra ProviderRun.
  - `searchCommunityTool` (`search_community`) — llama `reddit_communities`.
  - `collectTrendsTool` (`collect_trends`) — no-op, devuelve
    `{ available: false, reason: 'GoogleTrendsProvider UNAVAILABLE in V1' }`.
  - `deepenContentTool` (`deepen_content`) — requiere `urls: string[]`,
    llama `web_content`, persiste.

**Dependencias:** `providers/base.ts`, `repositories.ts`, `models.ts`,
`intelligence/normalizer.ts`, `logger.ts`, `errors.ts`.

**Anti-patterns evitados:**
- Cada tool registra su propio ProviderRun (observabilidad).
- Cada tool hace dedup antes de persistir (no duplicar señales ya
  vistas en la misma investigación).

#### 2.7.4 `orchestrator.ts`

**Propósito.** El cerebro. Recibe un objetivo, ejecuta el pipeline
completo, retorna el reporte. Budget-bounded.

**API pública:**
- `interface OrchestratorConfig { db, repositories, providerRegistry, toolRegistry, llm, budget? }`.
- `interface InvestigateInput { objective, geography?, budget? }`.
- `interface InvestigateResult { investigation, signals, evidence, trends, problems, opportunities, report }`.
- `class Orchestrator` con `investigate(input): Promise<InvestigateResult>`.

**Flujo interno** (más detalle en PARTE 3):
1. Crea `Investigation` con status RUNNING, budget merged.
2. `planner.plan()` → ResearchPlan. Si falla, marca FAILED y persiste.
3. Loop budget-bounded:
   - `PROVIDER_TO_TOOL = { web_search: 'search_web', reddit_communities: 'search_community', google_trends: 'collect_trends', web_content: 'deepen_content' }`.
   - Por cada query del plan: lookup tool, ejecutar, acumular
     counters (`totalQueries`, `totalProviderCalls`, `Date.now() - startTime`).
   - Corta si se excede `maxQueries`, `maxProviderCalls`, o
     `maxRuntimeMs`.
4. Carga signals + evidence por `investigationId` desde DB.
5. `clusterSignals(signals)`.
6. Por cluster: `detectTrend(historicalSignals=signals.findByTopic(c.canonical))`,
   `detectProblem()`. Persiste trend y problem. Actualiza topic +
   recordObservation (memoria).
7. Por trend (con matching problem, o STRONG_TREND/ESTABLISHED_TREND):
   `generateOpportunity()`. Si no weak, persiste.
8. Carga providerRuns desde DB (los tools los persistieron durante el
   loop).
9. `buildReport()` → markdown + JSON.
10. Determina status:
    - `signals.length === 0` → INSUFFICIENT_EVIDENCE.
    - `errors.length > 0 && opportunities.length === 0` → PARTIAL.
    - else → COMPLETED.
11. Persiste Investigation.

**Dependencias:** todas las capas inferiores + `logger.ts`.

#### 2.7.5 `reporter.ts`

**Propósito.** Convierte Investigation + signals + evidence + trends +
problems + opportunities en dos formatos: markdown humano y JSON
machine-readable.

**API pública:**
- `interface ReportInput { investigation, signals, evidence, trends, problems, opportunities }`.
- `interface ReportOutput { machine: IntelligenceReport, markdown: string }`.
- `buildReport(input): ReportOutput`.

**Componentes internos:**
- `computeOverallConfidence()` — promedio de confidences de trends,
  problems, opportunities.
- `computeLimitations()` — genera array explícito: signals<5,
  single provider, missing web_search, missing reddit, errors>0,
  no trends, no problems, **GoogleTrendsProvider UNAVAILABLE**.
- `computeNextAction()` — si no hay opps ni problems → sugerir
  expandir scope; si hay problems sin opps → sugerir deepen; si hay
  opps → handoff a AGENTE-LEADS con el top opportunity.
- `computeExecutiveSummary()` — string de 1 párrafo con conteos,
  providers, distribution de estados.
- `renderMarkdown(report)` — Markdown con secciones:
  Question, Resumen ejecutivo, Confidence, Tendencias, Problemas,
  Oportunidades, Signals, Sources, Limitations, Recommended next
  action. Cada opportunity lleva `TruthLevel: DERIVED`. Cada trend
  lleva `TruthLevel: OBSERVED`.

**Dependencias:** `models.ts`.

### 2.8 `src/config/index.ts` — Configuración

**Propósito.** Centraliza config por env vars.

**API pública:**
- `interface ChismosoConfig { dbPath, logLevel, defaultGeography, outputDir }`.
- `DEFAULT_CONFIG` con env vars:
  - `CHISMOSO_DB_PATH` (default `/home/z/my-project/chismoso/data/chismoso.db`).
  - `CHISMOSO_LOG_LEVEL` (default `INFO`).
  - `CHISMOSO_GEOGRAPHY` (default `global`).
  - `CHISMOSO_OUTPUT_DIR` (default `/home/z/my-project/download/chismoso`).
- `resolveConfig(overrides?)`.
- `resolveOutputPath(cfg, filename)`.

### 2.9 `src/cli.ts` — Interfaz CLI

**Propósito.** Punto de entrada `chismoso <command>`. Parseo de args,
wiring de dependencias, impresión de reportes.

**Comandos:**
- `chismoso investigate "<objective>" [--geography=...] [--max-queries=N]
  [--max-runtime-ms=N] [--save]` — crea DB, repos, providerRegistry,
  toolRegistry, LLMClient, Orchestrator. Ejecuta `investigate()`.
  Si `--save`, escribe `report-<id>.md` y `report-<id>.json` en
  `outputDir`. Imprime markdown a stdout. `process.exit(0)` explícito.
- `chismoso demo` — ejecuta el objetivo canónico de la especificación
  (sección 58): "Investiga qué tendencias y problemas emergentes
  podrían generar oportunidades de negocio para automatización de
  pequeños restaurantes en Colombia."
- `chismoso providers` — lista capabilities + health de los 4 providers
  en JSON.
- `chismoso history [--topic=<topic>]` — si topic, lista history de
  topic_observations; si no, lista últimos 20 trends.
- `chismoso show <investigationId>` — recupera investigation completa
  + trends + problems + opportunities + signals count + evidence count.

**Anti-patterns evitados:**
- La CLI no contiene lógica de negocio — todo delega a Orchestrator.
- `process.exit(0)` explícito después de `db.close()` para evitar
  segfault de better-sqlite3.

---

## PARTE 3 — FLUJO DE DATOS

Esta sección camina paso a paso por la investigación canónica real
(`inv_muvfmcw36y3lps`) que generó los reportes de referencia en
`/home/z/my-project/download/chismoso/`.

### 3.1 Trigger

Usuario ejecuta:
```bash
chismoso investigate \
  "Investiga qué tendencias y problemas emergentes podrían generar oportunidades de negocio para automatización de pequeños restaurantes en Colombia." \
  --geography=Colombia \
  --save
```

### 3.2 CLI parsea args y construye dependencias

`src/cli.ts:81-104`:
```ts
const objective = args[1];           // el string largo
const geography = argValue(args, '--geography') ?? cfg.defaultGeography;  // 'Colombia'
const maxQueries = argInt(args, '--max-queries');   // undefined → default
const maxRuntimeMs = argInt(args, '--max-runtime-ms'); // undefined → default
const saveReports = args.includes('--save');        // true

const db = new ChismosoDB({ path: cfg.dbPath });  // abre SQLite
const repos = new Repositories(db);                 // 7 repos instanciados
const providerRegistry = createDefaultProviderRegistry();  // 4 providers
const toolRegistry = createDefaultToolRegistry();          // 4 tools
const llm = new LLMClient();                        // wrap de ZAI chat
const orchestrator = new Orchestrator({
  db, repositories: repos, providerRegistry, toolRegistry, llm,
  budget: { maxQueries, maxRuntimeMs },
});
```

### 3.3 Orchestrator.investigate() crea el Investigation

`orchestrator.ts:93-116`:
```ts
const investigationId = generateId('inv');   // ej: inv_muvfmcw36y3lps
const investigation: Investigation = {
  id: investigationId,
  query: input.objective,
  scope: geography,                            // 'Colombia'
  startedAt,
  status: InvestigationStatus.RUNNING,
  providersUsed: [], queriesExecuted: [],
  signalsFound: 0, evidenceFound: 0, trendsFound: 0,
  problemsFound: 0, opportunitiesFound: 0,
  errors: [], iterations: 0,
  budget,                                      // DEFAULT_BUDGET mergeado
  providerRuns: [],
};
```

### 3.4 ResearchPlanner.plan() llama al LLM

`planner.ts:65-83`:
```ts
const userPrompt = `OBJECTIVE:\n${input.objective}\n\nGEOGRAPHY: Colombia\nMAX_ITERATIONS: 1\n\nProduce the JSON research plan now.`;
const resp = await this.llm.chat([
  { role: 'system', content: PLANNER_SYSTEM_PROMPT },
  { role: 'user', content: userPrompt },
]);
const parsed = safeParsePlan(resp.content);
```

El LLM responde con JSON válido (típicamente):
```json
{
  "scope": "Tendencias y problemas en automatización de pequeños restaurantes en Colombia",
  "geography": "Colombia",
  "topics": [
    "sistemas de reservas para restaurantes",
    "automatización de pedidos",
    "pagos digitales en restaurantes",
    "gestión de inventario"
  ],
  "queries": [
    { "providerName": "web_search", "query": "automatización restaurantes pequeños Colombia 2025", "rationale": "..." },
    { "providerName": "reddit_communities", "query": "pequeños restaurantes Colombia automatización", "rationale": "..." },
    { "providerName": "web_search", "query": "sistemas reservas restaurantes Colombia", "rationale": "..." },
    { "providerName": "reddit_communities", "query": "restaurantes Colombia problemas operativos", "rationale": "..." }
  ],
  "iterations": 1
}
```

`safeParsePlan()` valida el shape y filtra queries con providers no
soportados. `investigation.providersUsed = ['web_search',
'reddit_communities']` (dedup).

### 3.5 Loop: por cada query, lookup tool + execute

`orchestrator.ts:165-209`:
```
PROVIDER_TO_TOOL = {
  web_search:          'search_web',
  reddit_communities:  'search_community',
  google_trends:       'collect_trends',
  web_content:         'deepen_content',
}

for iter = 0 .. plan.iterations-1 (max maxIterations):
  for q in plan.queries:
    check budget (maxQueries, maxProviderCalls, maxRuntimeMs)
    toolName = PROVIDER_TO_TOOL[q.providerName]
    tool = toolRegistry.get(toolName)
    tool.execute(args, ctx)
```

### 3.6 Tool.execute() → provider.search() → normalizer → persist

`tools.ts:113-168` (searchWebTool):
```ts
const run: ProviderRun = { providerName: 'web_search', startedAt: nowISO(), query: args.query, resultsCount: 0 };
const t0 = Date.now();
const res = await provider.search({ query: args.query, num: 10, geography: 'Colombia' });
run.completedAt = nowISO();
run.durationMs = Date.now() - t0;
run.resultsCount = res.items.length;
run.error = res.error;
run.errorCode = res.errorCode;
ctx.repositories.investigations.recordProviderRun(ctx.investigationId, run);

if (res.items.length === 0) return { ... };

const normCtx: NormalizeContext = {
  topic: args.query,                    // ej: "automatización restaurantes pequeños Colombia 2025"
  geography: 'Colombia',
  investigationId: ctx.investigationId,
};
const normalized = res.items.map((it) => normalizeRawItem(it, normCtx));
let signals = normalized.map((n) => n.signal);
let evidence = normalized.map((n) => n.evidence);
signals = dedupSignals(signals);        // por URL o snippet
evidence = dedupEvidence(evidence);
ctx.repositories.signals.insertMany(signals, ctx.investigationId);
for (const e of evidence) ctx.repositories.evidence.insert(e, ctx.investigationId);
```

**Resultado del canonical run (inv_muvfmcw36y3lps):** 25 señales reales
persistidas, provenientes de deliverect.com, doordash.com,
docusign.com, mastercardservices.com, reddit.com — visibles en el JSON
del reporte bajo `evidence` y `signals`.

### 3.7 Después del loop: cargar signals + evidence desde DB

`orchestrator.ts:214-217`:
```ts
const signals = this.cfg.repositories.signals.findByInvestigation(investigationId);
const evidence = this.cfg.repositories.evidence.findByInvestigation(investigationId);
investigation.signalsFound = signals.length;     // 25
investigation.evidenceFound = evidence.length;   // 25
```

### 3.8 clusterSignals() agrupa por overlap coefficient

`orchestrator.ts:219-220`:
```ts
const { clusters, signalToCluster } = clusterSignals(signals);
```

Cada signal se tokeniza (`keyword + topic + rawSnippet.slice(0,200)`),
se calcula overlap coefficient contra clusters existentes, threshold 0.34.
Se generan N clusters. En el canonical run, 6 clusters resultaron en
6 trends.

### 3.9 Por cluster: detectTrend() + detectProblem()

`orchestrator.ts:225-261`:
```ts
for (const c of clusters) {
  const clusterSignals = c.signalIds.map(sid => signals.find(s => s.id === sid)).filter(Boolean);
  const clusterEvidence = evidence.filter(e => clusterSignals.some(s => s.url === e.url));
  const historical = this.cfg.repositories.signals.findByTopic(c.canonical);   // memoria

  const { trend } = detectTrend({ topic: c.canonical, canonical: c.canonical, signals: clusterSignals, evidence: clusterEvidence, historicalSignals: historical });
  trends.push(trend);
  this.cfg.repositories.trends.insert(trend, investigationId);

  const { problem } = detectProblem({ topic: c.canonical, canonical: c.canonical, signals: clusterSignals, evidence: clusterEvidence });
  if (problem) {
    problems.push(problem);
    this.cfg.repositories.problems.insert(problem, investigationId);
  }

  // memoria: topic_observations
  this.cfg.repositories.topics.recordObservation(c.canonical, c.sourcesCount, c.signalIds.length, clusterEvidence.length, trend.confidence, trend.state);

  // upsert topics
  const existing = this.cfg.repositories.topics.findByCanonical(c.canonical);
  if (existing) { existing.observationCount += 1; ... upsert(existing); }
  else { upsert({ id: c.id, canonical: c.canonical, keywords: ..., ... }); }
}
```

**Resultado canonical:** 6 trends detectados, 1 problem detectado
(severity 40, frequency 65, confidence 90%).

### 3.10 Por trend + matching problem: generateOpportunity()

`orchestrator.ts:287-312`:
```ts
for (const trend of trends) {
  const matchingProblem = problems.find(p => p.topic === trend.topic);
  const oppSignals = trend.signals.length > 0 ? trend.signals : signals.filter(s => s.topic === trend.topic);
  const oppEvidence = trend.evidence.length > 0 ? trend.evidence : evidence.filter(e => e.topic === trend.topic);

  if (!matchingProblem && trend.state !== 'STRONG_TREND' && trend.state !== 'ESTABLISHED_TREND') {
    continue;   // no problem + no strong trend → no opportunity
  }

  const { opportunity, weak } = generateOpportunity({ trend, problem: matchingProblem, signals: oppSignals, evidence: oppEvidence, geography });
  if (!weak) {
    opportunities.push(opportunity);
    this.cfg.repositories.opportunities.insert(opportunity, investigationId);
  } else {
    logger.info('Skipping weak opportunity', { title: opportunity.title, score: opportunity.score });
  }
}
```

**Resultado canonical:** 2 oportunidades generadas (scores 49 y 42),
ambas con `suggestedNextAgent: "AGENTE-LEADS"`.

### 3.11 Cargar providerRuns desde DB

`orchestrator.ts:319`:
```ts
investigation.providerRuns = this.cfg.repositories.investigations.listProviderRuns(investigationId);
```

Los tools persistieron cada `ProviderRun` durante el loop. Ahora se
cargan para incluirlos en el reporte.

### 3.12 buildReport() → markdown + JSON

`orchestrator.ts:321-328`:
```ts
const report = buildReport({
  investigation, signals, evidence, trends, problems, opportunities,
});
```

`reporter.ts:37-64`:
- `computeOverallConfidence(trends, problems, opportunities)` — promedio.
- `computeLimitations(inv, signals, trends, problems)` — array explícito
  incluyendo `'GoogleTrendsProvider is UNAVAILABLE in V1 — search-trend signals are missing.'`.
- `computeNextAction(opportunities, problems)` — handoff a AGENTE-LEADS.
- `computeExecutiveSummary(input, confidence)` — string de un párrafo.
- `renderMarkdown(machine: IntelligenceReport)` — Markdown con
  TruthLevel annotations.

### 3.13 Determinar status final + persistir Investigation

`orchestrator.ts:335-345`:
```ts
if (signals.length === 0) status = INSUFFICIENT_EVIDENCE;
else if (errors.length > 0 && opportunities.length === 0) status = PARTIAL;
else status = COMPLETED;
investigation.completedAt = nowISO();
investigation.durationMs = Date.now() - new Date(startedAt).getTime();
this.cfg.repositories.investigations.insert(investigation);
```

**Resultado canonical:** status COMPLETED, 25 signals, 6 trends, 1
problem, 2 opportunities.

### 3.14 CLI imprime markdown + guarda archivos

`cli.ts:119-131`:
```ts
if (saveReports) {
  mkdirSync(cfg.outputDir, { recursive: true });
  const id = result.investigation.id;
  writeFileSync(resolveOutputPath(cfg, `report-${id}.md`), result.report.markdown);
  writeFileSync(resolveOutputPath(cfg, `report-${id}.json`), JSON.stringify(result.report.machine, null, 2));
  console.error(`[chismoso] Reports saved to ${cfg.outputDir}/report-${id}.{md,json}`);
}
console.log(result.report.markdown);
db.close();
process.exit(0);
```

**Output canonical:**
- `/home/z/my-project/download/chismoso/report-inv_muvfmcw36y3lps.md` (167 líneas).
- `/home/z/my-project/download/chismoso/report-inv_muvfmcw36y3lps.json` (machine-readable).

### 3.15 Diagrama de flujo completo

```
CLI investigate "..." --geography=Colombia --save
  │
  ├── new ChismosoDB(path)            ── SQLite WAL + SCHEMA_V1
  ├── new Repositories(db)            ── 7 repos
  ├── createDefaultProviderRegistry()── 4 providers (3 real + 1 UNAVAILABLE)
  ├── createDefaultToolRegistry()     ── 4 tools
  ├── new LLMClient()                ── wraps ZAI chat.completions
  ├── new Orchestrator({...all above, budget})
  │
  └── orchestrator.investigate({objective, geography})
        │
        ├── create Investigation(id=inv_muvfmcw36y3lps, status=RUNNING)
        │
        ├── planner.plan()
        │     │
        │     ├── llm.chat([system=PLANNER_SYSTEM_PROMPT, user=objective])
        │     └── safeParsePlan(JSON) → ResearchPlan{topics, queries, iterations}
        │
        ├── for each query in plan.queries (budget-bounded):
        │     │
        │     ├── lookup tool via PROVIDER_TO_TOOL
        │     ├── tool.execute(args, ctx)
        │     │     │
        │     │     ├── provider.search(query)        ── ZAI web_search / page_reader
        │     │     ├── → RawItem[]
        │     │     ├── normalizeRawItem(item, ctx)   ── RawItem → Signal + Evidence
        │     │     ├── dedupSignals() + dedupEvidence()
        │     │     ├── signals.insertMany()
        │     │     ├── evidence.insert()  × N
        │     │     └── investigations.recordProviderRun()  ── observability
        │     │
        │     └── accumulate counters (queries, providerCalls, runtime)
        │
        ├── load signals + evidence by investigationId
        │
        ├── clusterSignals(signals)
        │     └── TopicCluster[]  (overlap coefficient ≥ 0.34)
        │
        ├── for each cluster:
        │     ├── detectTrend({signals, historicalSignals=signals.findByTopic(canonical)})
        │     │     └── Trend{state, score, scoreBreakdown}
        │     ├── detectProblem({signals})
        │     │     └── Problem | null  (requiere ≥2 distinct friction snippets)
        │     ├── trends.insert(trend)
        │     ├── problems.insert(problem)  si no null
        │     ├── topics.recordObservation(canonical, ...)   ── memory
        │     └── topics.upsert(...)
        │
        ├── for each trend (con matching problem, o STRONG/ESTABLISHED):
        │     ├── generateOpportunity({trend, problem, signals, evidence})
        │     │     └── Opportunity{score, scoreBreakdown, suggestedNextAgent="AGENTE-LEADS"}
        │     ├── if !weak: opportunities.insert(opportunity)
        │     └── else: log skip
        │
        ├── load providerRuns from DB
        │
        ├── buildReport({investigation, signals, evidence, trends, problems, opportunities})
        │     ├── computeOverallConfidence
        │     ├── computeLimitations (incl. GoogleTrendsProvider UNAVAILABLE)
        │     ├── computeNextAction (handoff a AGENTE-LEADS)
        │     └── renderMarkdown()
        │
        ├── determine status: COMPLETED | PARTIAL | INSUFFICIENT_EVIDENCE | FAILED
        │
        ├── investigations.insert(investigation)
        │
        └── return InvestigateResult
  │
  ├── print markdown to stdout
  ├── writeFileSync(report-<id>.md)
  ├── writeFileSync(report-<id>.json)
  ├── db.close()
  └── process.exit(0)   ── workaround segfault
```

---

## PARTE 4 — DECISIONES ARQUITECTURALES (ADR)

### ADR-001: SQLite sobre Postgres

**Contexto.** Especificación sección 31: "SQLite es suficiente para V1."

**Decisión.** Usar `better-sqlite3` con WAL + foreign_keys. Schema V1
con 9 tablas. No introducir Postgres.

**Razón.**
- Single-writer es aceptable para V1 (CLI, un usuario a la vez).
- Zero configuración de red (no servidor, no puerto, no auth).
- Archivo único `chismoso.db` portable y debuggable con `sqlite3` CLI.
- better-sqlite3 es síncrono: código más simple que `pg` async.
- Especificación explícita: no over-engineer.

**Consecuencias.**
- (+) Setup instantáneo. No requiere Docker.
- (+) Tests con `:memory:` son rapidísimos.
- (−) No soporta multi-proceso concurrente.
- (−) No soporta replicación.
- Mitigación: cuando se necesite multi-tenant, migrar a Postgres es
  cuestión de cambiar `db.ts` y `repositories.ts` — los modelos y
  engines no cambian.

### ADR-002: z-ai-web-dev-sdk como backend real de providers

**Contexto.** Necesitamos providers que busquen en la web y lean
páginas. El entorno tiene `z-ai-web-dev-sdk` instalado globalmente.

**Decisión.** Los 3 providers reales (`web_search`,
`reddit_communities`, `web_content`) usan
`zai.functions.invoke('web_search' | 'page_reader', ...)` como backend.
No se escribió ningún scraper propio, ningún cliente HTTP propio.

**Razón.**
- El SDK ya resuelve rate limiting, retries, y parsing de resultados.
- Mantiene consistencia con el resto del entorno (skills).
- Reduce superficie de bug.

**Consecuencias.**
- (+) Menos código que mantener.
- (+) Backend unificado — si el SDK mejora, CHISMOSO mejora.
- (−) Single point of failure: los 3 providers dependen del mismo SDK.
- (−) Si el SDK cambia su contract (v0.0.18 → future), los 3 se rompen.
- Mitigación: `classifyError()` captura y etiqueta; fallback en planner.

### ADR-003: GoogleTrendsProvider marcado UNAVAILABLE — nunca simula

**Contexto.** Especificación secciones 10, 37, 39: no simular datos.
Google Trends no tiene API oficial pública con credenciales disponibles.

**Decisión.** El provider se **registra** (para que el sistema sepa que
la categoría `SourceType.GOOGLE_TRENDS` existe) pero:
- `capabilities().status = ProviderHealth.UNAVAILABLE`.
- `search()` retorna siempre `{ items: [], errorCode: PROVIDER_UNAVAILABLE }`.
- No genera datos sintéticos. No devuelve "ejemplos".
- El reporte lo declara explícitamente en `computeLimitations()`.

**Razón.**
- Especificación explícita anti-ficticia.
- Datos simulados corrompen el scoring — el usuario no puede distinguir
  evidencia real de placeholder.
- El planner no incluye queries con `google_trends` en el plan (filtrado
  en `safeParsePlan`).

**Consecuencias.**
- (+) Honestidad epistémica.
- (+) Cuando se configure una API real (SerpAPI, OAuth), basta con
  implementar `search()` y cambiar `status`. El resto del sistema no
  cambia.
- (−) CHISMOSO V1 no detecta `SEARCH_SPIKE` directamente (ese signalType
  requiere Google Trends). Se detecta `DEMAND_SIGNAL` por patrones
  textuales en web_search, que es una aproximación.

### ADR-004: Provider-to-Tool mapping en Orchestrator

**Contexto.** Tenemos providers (hablan con APIs) y tools (encapsulan
provider + normalizer + persistencia). El planner LLM propone queries
con `providerName`. ¿Cómo se conectan?

**Decisión.** Mapeo explícito en `orchestrator.ts:158-163`:
```ts
const PROVIDER_TO_TOOL: Record<string, string> = {
  web_search: 'search_web',
  reddit_communities: 'search_community',
  google_trends: 'collect_trends',
  web_content: 'deepen_content',
};
```
El planner propone `providerName`; el orchestrator lo traduce a
`toolName` y busca en `ToolRegistry`.

**Razón.**
- Preserva la separación: el planner no conoce tools, sólo providers.
- Si un provider cambia de nombre, basta con actualizar el map.
- Si un tool encapsula múltiples providers (ej: futuro `multi_search`),
  el map apunta al tool correcto.

**Consecuencias.**
- (+) Planner LLM no necesita saber de ToolRegistry.
- (−) Una indirección más en el código.
- Mitigación: el map es explícito y visible.

### ADR-005: Overlap coefficient (no Jaccard) para clustering

**Contexto.** `clustering.ts` agrupa señales por similitud de tokens.
Dos métricas candidatas:
- Jaccard: `|A ∩ B| / |A ∪ B|`.
- Overlap coefficient: `|A ∩ B| / min(|A|, |B|)`.

**Decisión.** Usar overlap coefficient con threshold 0.34.

**Razón.**
- Las señales tienen snippets de longitud muy variable (50-2000 chars).
  Tokens resultantes: 5-50.
- Si una signal corta (5 tokens) coincide 4/5 con un cluster grande
  (40 tokens), Jaccard = 4/41 = 0.097 (no alcanzaría threshold). Overlap
  = 4/5 = 0.8 (sí lo alcanzaría).
- Queremos que señales cortas pero nítidamente on-topic se unan al
  cluster correcto. Overlap es más permisivo con sets de tamaño desigual.

**Consecuencias.**
- (+) Mejor recall en clustering.
- (−) Peor precision: señales genéricas cortas podrían unirse a clusters
  incorrectos.
- Mitigación: threshold 0.34 es relativamente alto. Y la regla de
  `pickCanonical` (token más frecuente) previene que un cluster derive
  a un canonical erróneo.

### ADR-006: Heuristic problem detection con friction patterns explícitos

**Contexto.** Especificación sección 19: detectar problemas. Opciones:
(a) LLM-driven sentiment analysis, (b) heurística RegExp.

**Decisión.** Heurística con `FRICTION_PATTERNS` — array de RegExp EN+ES
en `problems.ts`. NO LLM.

**Razón.**
- Determinismo: misma input → misma output. Testeable.
- Trazabilidad: cada match es auditable.
- Cost: cero tokens LLM.
- Cobertura: EN+ES para V1.

**Consecuencias.**
- (+) Tests reproducibles.
- (+) Performance predecible.
- (−) Falsos positivos: "frustration" en contexto positivo.
- (−) Falsos negativos: fricción expresada en lenguaje no cubierto.
- Mitigación: `detectProblem` requiere `≥2` snippets distintos. Esto
  filtra falsos positivos aislados. Falsos negativos son aceptables
  (CHISMOSO prefiere no afirmar problema que afirmar sin base).

### ADR-007: Opportunity scoring con pesos documentados

**Contexto.** El Opportunity score es la métrica más visible del
reporte. ¿Cómo evitar magic numbers?

**Decisión.** `OPPORTUNITY_WEIGHTS` en `opportunities.ts:50-59` es
`const` exportable:
```ts
export const OPPORTUNITY_WEIGHTS = {
  demand: 0.18,
  growth: 0.18,
  problemSeverity: 0.16,
  monetization: 0.14,
  timing: 0.12,
  marketFit: 0.12,
  competition: -0.05,
  uncertainty: -0.09,
} as const;
```

Cada componente (`demand`, `growth`, etc.) se calcula con una función
dedicada y documentada. `scoreBreakdown` se persiste en DB y se imprime
en el reporte.

**Razón.**
- Transparencia: el usuario puede auditar por qué una oportunidad tiene
  score X.
- Ajustabilidad: cambiar un peso no requiere tocar lógica.
- Especificación sección 22: no afirmar "generará mucho dinero"; sí
  explicar "la evidencia sugiere... con score Y por breakdown Z".

**Consecuencias.**
- (+) Auditabilidad.
- (+) Tuneable sin reescribir código.
- (−) Los pesos son arbitrarios (no calibrados contra datos reales de
  éxito de startups).
- Mitigación: V2 podría calibrar contra histórico de oportunidades
  exitosas. Por ahora, los pesos son declaración de prioridades.

### ADR-008: TruthLevel enum en cada claim

**Contexto.** Especificación sección 5: principio de verdad. Cada
afirmación debe llevar su grado de certeza.

**Decisión.** `enum TruthLevel { OBSERVED, DERIVED, INFERRED, PREDICTED, UNKNOWN }`
en `models.ts`. Aplicado en:
- `Signal.evidenceType` y `Evidence.evidenceType` → siempre `OBSERVED` en
  V1 (los providers sólo devuelven cosas que una fuente realmente
  muestra).
- `Trend` en el reporte → marcado `TruthLevel.OBSERVED` (se compone de
  signals observadas).
- `Opportunity` en el reporte → marcado `TruthLevel.DERIVED` (síntesis
  de signals + trend + problem).

**Razón.**
- Evita que el usuario confunda "lo que vimos" con "lo que inferimos".
- Permite al downstream agent (AGENTE-LEADS) saber qué tan fuerte es
  la base de cada claim.
- `INFERRED` y `PREDICTED` están reservados para V2 (cuando el LLM
  proponga hipótesis y proyecciones).

**Consecuencias.**
- (+) Honestidad epistémica en cada afirmación.
- (+) Auditabilidad: un `OBSERVED` puede trazarse a un `url`.
- (−) Overhead de modelado.
- (−) En V1 casi todo es `OBSERVED` o `DERIVED`; `INFERRED`/`PREDICTED`
  no se usan todavía.

### ADR-009: Budget-bounded investigation loop

**Contexto.** Especificación sección 26: el agente debe ser autónomo
pero acotado. Sin budget, un loop de investigación podría correr
indefinidamente.

**Decisión.** `InvestigationBudget` con 6 dimensiones:
```ts
maxIterations: 3,        // cuántas veces re-ejecutar el plan
maxQueries: 12,         // total queries a providers
maxSources: 5,          // sources distintos
maxResults: 60,         // items totales
maxRuntimeMs: 300_000,  // 5 minutos
maxProviderCalls: 15,   // llamadas individuales a providers
```

El orchestrator checkea antes de cada iteración del loop. Si se
excede, acumula error en `investigation.errors` y rompe el loop.

**Razón.**
- Previene costos descontrolados.
- Garantiza terminación.
- Permite al usuario override por CLI: `--max-queries=N`, `--max-runtime-ms=N`.

**Consecuencias.**
- (+) Predictibilidad de cost.
- (+) Status `PARTIAL` o `INSUFFICIENT_EVIDENCE` indican al usuario
  que se cortó por budget.
- (−) Una investigación grande podría no completarse en 5 min.
- Mitigación: el usuario puede subir `--max-runtime-ms` y `--max-queries`.

### ADR-010: better-sqlite3 beforeExit handler para evitar segfault

**Contexto.** better-sqlite3 v11 en Node 24 tiene un bug: si el proceso
termina y el GC colecciona un `Statement` nativo después del teardown
del environment, hay segfault.

**Decisión.** En `db.ts:261-267`:
```ts
const openDbs = new Set<ChismosoDB>();
process.on('beforeExit', () => {
  for (const db of openDbs) {
    try { db.db.close(); } catch { /* ignore */ }
  }
  openDbs.clear();
});
```
Y en `cli.ts:130`, `process.exit(0)` explícito después de `db.close()`.

**Razón.**
- Es el workaround documentado en issues de better-sqlite3.
- `beforeExit` se dispara antes del teardown, cuando aún es seguro
  llamar métodos nativos.

**Consecuencias.**
- (+) No más segfault al final del CLI.
- (−) Workaround frágil: si Node cambia el orden de los hooks, podría
  romper.
- Mitigación: en V2, evaluar migrar a `node:sqlite` (built-in Node 24+)
  o a `libsql` (sin bindings nativos).

---

## PARTE 5 — FRONTERAS (lo que CHISMOSO NO hace)

Esta sección refuerza los límites del alcance de CHISMOSO. Es **tan
importante como la lista de capacidades** porque define los handoffs
con los agentes vecinos.

### 5.1 CHISMOSO ≠ AGENTE-LEADS (sección 43)

AGENTE-LEADS es el siguiente agente del pipeline. CHISMOSO **no** hace
lead discovery, no enriquece companies, no arma listas de prospectos.
CHISMOSO **sólo**:

- Detecta oportunidades potenciales con score y evidencia.
- Escribe `suggestedNextAgent: "AGENTE-LEADS"` en cada `Opportunity`.
- Genera un `IntelligenceReport` JSON consumible por AGENTE-LEADS.

**El handoff es por archivo, no por red.** No hay llamada gRPC, no hay
HTTP, no hay message queue. AGENTE-LEADS debe leer
`report-<id>.json` y decidir si continúa.

### 5.2 CHISMOSO ≠ NEX-SCOPE (sección 44)

NEX-SCOPE es el agente dedicado a YouTube. CHISMOSO **no** analiza
videos, no transcribe audio, no cuenta views, no detecta comment
sentiment en YouTube. Aunque el enum `SourceType.YOUTUBE` existe en
`models.ts`, no hay provider registrado para ese sourceType en V1.

### 5.3 CHISMOSO ≠ RADAR-SECOP2 (sección 45)

RADAR-SECOP2 es el agente de inteligencia de contratación pública
(SECOP II en Colombia). CHISMOSO **no** consulta SECOP, no parsea
contratos, no detecta oportunidades de licitación.

### 5.4 CHISMOSO ≠ news aggregator

CHISMOSO **no** es un agregador de noticias. No suscribe a RSS feeds,
no monitorea medios en tiempo real, no envía digests diarios. Las
señales que recolecta son de oportunidades de negocio, no de
current events.

### 5.5 CHISMOSO ≠ generic chatbot

CHISMOSO **no** responde preguntas arbitrarias. El único punto de
entrada es `investigate "<objective>"`, que dispara el pipeline
determinista. No hay conversación multi-turn, no hay memoria de
sesión entre invocaciones (sólo memoria de topics históricos en DB).

### 5.6 No content generation

CHISMOSO **no** genera contenido para marketing. No escribe posts de
blog, no redacta emails, no crea copy para anuncios. Sólo produce
reportes de inteligencia.

### 5.7 No email marketing / no CRM

CHISMOSO **no** envía emails, no gestiona contactos, no sincroniza con
HubSpot/Salesforce. No hay integración con Sendgrid, Mailchimp, ni
similares.

### 5.8 No scraping de leads

CHISMOSO **no** extrae datos personales de LinkedIn, no scrapea
directorios empresariales para construir listas de leads. Esos son
trabajos de AGENTE-LEADS con consentimiento y compliance propios.

### 5.9 No trading / no financial advice

CHISMOSO **no** recomienda acciones, no analiza mercados financieros,
no predice precios. Las "oportunidades de negocio" son de producto/
servicio, no de inversión financiera.

### 5.10 Resumen de fronteras

```
┌──────────────────────────────────────────────────────────────────┐
│                       CHISMOSO V1.0                              │
│   Entrada:  "Investiga X en geografía Y"                         │
│   Salida:   IntelligenceReport { markdown, JSON }                │
│             Opportunity.suggestedNextAgent = "AGENTE-LEADS"     │
│                                                                  │
│   NO hace:  lead discovery, company enrichment, YouTube deep,  │
│             SECOP, news aggregation, chatbot, content marketing,│
│             email/CRM, lead scraping, trading advice.           │
└──────────────────────────────────────────────────────────────────┘
                              │
                              │ handoff por archivo JSON
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│              AGENTE-LEADS (agente siguiente)                    │
│   Lee report-<id>.json, decide si continúa.                     │
└──────────────────────────────────────────────────────────────────┘
```

---

## APÉNDICE A — Glosario

- **Signal:** observación normalizada de un fenómeno (ej: "hubo 3
  menciones de 'reservas por WhatsApp' en Reddit Colombia en 7 días").
- **Evidence:** el raw item que respalda una signal (URL + snippet +
  timestamp).
- **Trend:** cluster de signals que cumple ciertos criterios (state,
  score, sources).
- **Problem:** fricción recurrente observada (≥2 snippets distintos
  que matchean friction patterns).
- **Opportunity:** síntesis de trend + problem + heurísticas de
  mercado, con score transparente.
- **Investigation:** unidad de trabajo. Una llamada a
  `orchestrator.investigate()` = una investigation.
- **ProviderRun:** registro de una llamada a un provider (query,
  duración, results count, error).
- **TruthLevel:** grado de certeza de una afirmación (OBSERVED,
  DERIVED, INFERRED, PREDICTED, UNKNOWN).
- **Budget:** acotamiento de recursos (iteraciones, queries, runtime,
  provider calls).

## APÉNDICE B — Referencias a la especificación

| Sección spec | Implementación CHISMOSO |
|---|---|
| 5 — Principio de verdad | `TruthLevel` enum en `models.ts` |
| 6 — ADN de evidencia | `Evidence` interface + `evidence` table |
| 7 — Tendencias y problemas | `Trend`, `Problem` interfaces + engines |
| 9 — Source types | `SourceType` enum |
| 10 — No simular | `GoogleTrendsProvider` UNAVAILABLE |
| 11 — Provider abstraction | `IProvider` en `providers/base.ts` |
| 12 — Error taxonomy | `errors.ts` |
| 13 — Signal | `Signal` interface + `normalizer.ts` |
| 14 — Signal types | `SignalType` enum |
| 15 — Trend detection | `trends.ts` |
| 16 — Cross-source | `cross-source.ts` |
| 18 — Topic clustering | `clustering.ts` (no embeddings) |
| 19 — Problem detection | `problems.ts` (heuristic, no LLM) |
| 20-22 — Opportunity | `opportunities.ts` (transparent scoring) |
| 23 — Research planner | `planner.ts` |
| 26 — Autonomy budget | `DEFAULT_BUDGET` |
| 27-28 — Reports | `reporter.ts` (markdown + JSON) |
| 30 — Interoperability | `suggestedNextAgent: "AGENTE-LEADS"` |
| 31 — SQLite | `db.ts` |
| 32 — Observability | `logger.ts` + `provider_runs` table |
| 33 — Provider health | `ProviderHealth` enum |
| 37, 39 — No ficticio | `GoogleTrendsProvider` no simula |
| 40 — CLI | `cli.ts` |
| 41 — LLM | `llm.ts` |
| 42 — Tools | `tools.ts` |
| 43 — AGENTE-LEADS | Handoff por JSON |
| 44 — NEX-SCOPE | No implementado (out of scope) |
| 45 — RADAR-SECOP2 | No implementado (out of scope) |
| 46, 59 — Fronteras | PARTE 5 de este documento |
| 47 — Orchestrator | `orchestrator.ts` |
| 49 — Audit | PARTE 1 de este documento |
| 57 — Definition of Done | Cumplido (ver worklog FASE 9) |
| 58 — Demo canónico | `chismoso demo` |

---

**Fin del documento.**
CHISMOSO V1.0 — arquitectura completa, auditada, lista para extensión.
