# CHISMOSO V1.0 — Shared Worklog

This is the single shared worklog for all agents working on CHISMOSO.
Each agent must read this before starting and append a new section after finishing.

---
Task ID: 0-9
Agent: main (Super Z)
Task: Construir CHISMOSO V1.0 — agente de inteligencia de señales, tendencias, problemas y oportunidades de negocio. Fases 0 a 9 completas.

Work Log:
- FASE 0: Audit entorno — verificado z-ai-web-dev-sdk v0.0.18 (web_search, page_reader, chat.completions), Node v24, better-sqlite3 funcional.
- FASE 1: Foundation — src/models.ts (modelos canónicos: Signal, Evidence, Trend, Problem, Opportunity, Investigation, TruthLevel enum), src/errors.ts (error taxonomy con retryStrategy), src/logger.ts (sanitiza credenciales), src/db.ts (SQLite schema V1: topics, signals, evidence, trends, problems, opportunities, investigations, provider_runs, topic_observations), src/repositories.ts (7 repos: Signal, Evidence, Topic, Trend, Problem, Opportunity, Investigation).
- FASE 2: Provider abstraction — src/providers/base.ts (IProvider interface, ProviderRegistry, RawItem), 4 providers: WebSearchProvider (real, web_search), RedditProvider (real, web_search con site:reddit.com|quora.com), WebContentProvider (real, page_reader para profundizar URLs), GoogleTrendsProvider (correctamente marcado UNAVAILABLE, NO simula datos).
- FASE 3: Signal Engine — src/intelligence/normalizer.ts (normalizeRawItem, dedupSignals, dedupEvidence, inferSignalType con patrones EN+ES, tokenize con stopwords ES+EN), src/intelligence/clustering.ts (clusterSignals con overlap coefficient, threshold 0.34).
- FASE 4: Intelligence — src/intelligence/cross-source.ts (crossSourceConfidence: 1 fuente=low, 2 tipos=medium, 3+=high), src/intelligence/trends.ts (detectTrend con growth/persistence/crossSource/recency/velocity/noise, classifyState: NOISE/WEAK_SIGNAL/EMERGING_TREND/STRONG_TREND/ESTABLISHED_TREND/DECLINING_TREND), src/intelligence/problems.ts (detectProblem con friction patterns EN+ES, requiere >=2 distinct snippets).
- FASE 5: Opportunity Engine — src/intelligence/opportunities.ts (generateOpportunity con scoring transparente: demand/growth/problemSeverity/monetization/timing/marketFit/competition/uncertainty, weights documentados, Opportunity incluye suggestedNextAgent="AGENTE-LEADS").
- FASE 6: Orchestrator — src/orchestrator/llm.ts (LLMClient wraps ZAI chat.completions con retry), src/orchestrator/planner.ts (ResearchPlanner usa LLM para generar plan JSON con topics + queries + iterations, fallback determinista si LLM falla), src/orchestrator/tools.ts (4 tools: search_web, search_community, collect_trends, deepen_content; ToolRegistry), src/orchestrator/orchestrator.ts (loop controlado por budget: maxIterations, maxQueries, maxSources, maxResults, maxRuntimeMs, maxProviderCalls; status: RUNNING/COMPLETED/PARTIAL/FAILED/INSUFFICIENT_EVIDENCE), src/orchestrator/reporter.ts (buildReport genera markdown + machine-readable IntelligenceReport con executiveSummary, limitations, recommendedNextAction, TruthLevel annotations).
- FASE 7: Report Engine — markdown human-readable + JSON machine-readable (sección 27/28 spec). TruthLevel separa OBSERVED (signals) vs DERIVED (opportunities). Limitations explícitas incluyendo GoogleTrendsProvider UNAVAILABLE.
- FASE 8: CLI — src/cli.ts con commands: investigate (con --geography, --max-queries, --max-runtime-ms, --save), demo, providers, history, show. Config por env vars (CHISMOSO_DB_PATH, CHISMOSO_LOG_LEVEL, etc.).
- FASE 9: Testing — 41 tests pasan (39 unit + 2 E2E con datos reales). Cubren: normalizer, errors, clustering, cross-source, trends, problems, opportunities, providers-db, E2E canonical investigation con proveedores reales.
- Verificación manual CLI: investigación canónica ejecutada con éxito — 25 señales reales (deliverect, doordash, docusign, mastercardservices, reddit), 6 trends, 1 problema (severity 40, frequency 65, confidence 90%), 2 oportunidades (scores 49 y 42, sugeridas a AGENTE-LEADS), reportes .md y .json guardados en /home/z/my-project/download/chismoso/.

Stage Summary:
- CHISMOSO V1.0 funcional end-to-end.
- 3 providers REALES (web_search, reddit_communities, web_content) + 1 correctamente UNAVAILABLE (google_trends).
- 41/41 tests pasan.
- Pipeline completo: OBJECTIVE → PLAN (LLM) → COLLECT (real providers) → NORMALIZE → DEDUP → CLUSTER → TREND DETECTION → PROBLEM DETECTION → CROSS-SOURCE CONFIRMATION → OPPORTUNITY ENGINE → SCORING → REPORT (markdown + JSON) → STORE (SQLite) → INTEROPERABILITY (suggested_next_agent=AGENTE-LEADS).
- Cumple Definition of Done (sección 57): arquitectura separada, sin capacidades ficticias, evidencia trazable, memoria funcional (topic_observations), autonomía (una instrucción de alto nivel ejecuta todo el pipeline), retries/fallbacks/timeouts normalizados, tests unit + E2E.
- Pendiente: documentación final (README, ARCHITECTURE, DELIVERY, DEFINITION_OF_DONE) — delegada a subagentes paralelos.

Files produced:
- /home/z/my-project/chismoso/ (project root)
  - src/models.ts, errors.ts, logger.ts, db.ts, repositories.ts, index.ts, cli.ts
  - src/providers/{base,web-search,reddit,web-content,google-trends,index}.ts
  - src/intelligence/{normalizer,clustering,cross-source,trends,problems,opportunities,index}.ts
  - src/orchestrator/{llm,planner,tools,orchestrator,reporter,index}.ts
  - src/config/index.ts
  - tests/{normalizer,errors,clustering,trends,opportunities,providers-db,e2e}.test.ts
  - scripts/{smoke,inspect,list-signals}.ts
  - package.json, tsconfig.json, vitest.config.ts, .gitignore
- /home/z/my-project/download/chismoso/report-inv_muvfmcw36y3lps.{md,json} (sample canonical investigation report)

---
Task ID: 10-a
Agent: technical-writer (README)
Task: Write user-facing README.md for CHISMOSO V1.0

Work Log:
- Leí /home/z/my-project/worklog.md para entender el estado del proyecto (Fases 0-9 completas, 41/41 tests, pendiente documentación).
- Inspeccioné la estructura del proyecto bajo /home/z/my-project/chismoso/ — 26 archivos fuente (src/ + tests/ + scripts/).
- Leí package.json (v1.0.0, Node >=20, MIT implícito, deps: z-ai-web-dev-sdk + better-sqlite3).
- Leí src/cli.ts para extraer el contract exacto de los comandos (investigate/demo/providers/history/show/help) y los flags (--geography, --max-queries, --max-runtime-ms, --save).
- Leí src/models.ts para obtener los enums canónicos (SignalType con 12 valores, TruthLevel con 5, TrendState, InvestigationStatus, ProviderHealth) y los schemas de Signal, Evidence, Trend, Problem, Opportunity, IntelligenceReport.
- Leí src/orchestrator/orchestrator.ts para verificar el flujo del pipeline y el budget (maxQueries, maxRuntimeMs, maxProviderCalls).
- Leí src/intelligence/opportunities.ts para obtener los pesos exactos del scoring (demand 0.18, growth 0.18, problemSeverity 0.16, monetization 0.14, timing 0.12, marketFit 0.12, competition -0.05, uncertainty -0.09) y la regla de oro de la sección 22.
- Leí src/providers/index.ts y google-trends.ts para confirmar: 3 providers OK reales + 1 UNAVAILABLE (no simula, retorna PROVIDER_UNAVAILABLE).
- Leí src/index.ts y config/index.ts para construir el ejemplo de uso como librería con los exports públicos reales.
- Leí el sample report /home/z/my-project/download/chismoso/report-inv_muvfmcw36y3lps.md (100 líneas) para reproducir el formato real del reporte Markdown en la sección "Salida del reporte".
- Escribí /home/z/my-project/chismoso/README.md en español con 18 secciones completas: title+tagline, badges, ¿Qué es CHISMOSO?, Instalación, Uso del CLI, Variables de entorno, Uso como librería, Arquitectura (con diagrama ASCII), Providers disponibles, Tipos de señal, Modelo de evidencia, Scoring de oportunidades, Testing, Salida del reporte, Interoperabilidad, Limitaciones conocidas V1, Roadmap V2, Licencia MIT.
- Validé longitud: 576 líneas (dentro del rango 400-600).

Stage Summary:
- File created: /home/z/my-project/chismoso/README.md
- Lines: 576
- Sections: Title+tagline, Badges/Status, ¿Qué es CHISMOSO?, Instalación, Uso del CLI, Variables de entorno, Uso como librería, Arquitectura (ASCII diagram), Providers disponibles, Tipos de señal, Modelo de evidencia, Scoring de oportunidades, Testing, Salida del reporte, Interoperabilidad, Limitaciones conocidas (V1), Roadmap V2, Licencia MIT, Estado del proyecto

---
Task ID: 10-c
Agent: delivery-report (DELIVERY.md)
Task: Write constructor's delivery report per spec section 62

Work Log:
- Leí worklog.md, listé todos los archivos bajo src/, tests/, scripts/ y raíz de chismoso/.
- Leí spec sección 57 (CRITERIOS DE TERMINACIÓN) y sección 62 (ENTREGA DEL CONSTRUCTOR) — formato 12 puntos.
- Verifiqué el reporte canario real en /home/z/my-project/download/chismoso/report-inv_muvfmcw36y3lps.{md,json} (167 + 4611 líneas, datos reales).
- Conté tests con ripgrep: 41 tests en 7 archivos (normalizer=7, errors=9, clustering=3, trends=9, opportunities=5, providers-db=6, e2e=2).
- Conté archivos: 37 .ts bajo src/tests/scripts, 4523 líneas de código fuente.
- Creé directorio /home/z/my-project/chismoso/docs/.
- Escribí DELIVERY.md en español con las 12 secciones exactas del spec sección 62, modo brutalmente honesto.
- Incluí los 10 ADRs, los 14 puntos de capacidades reales, las 14 limitaciones actuales honestas, y los pasos siguientes por plazo (corto/mediano/largo).
- Verifiqué coherencia con worklog: 25 signals, 6 trends, 1 problema, 2 oportunidades, status RUNNING→COMPLETED, providers web_search+reddit_communities.

Stage Summary:
- File created: /home/z/my-project/chismoso/docs/DELIVERY.md
- Lines: 459

---
Task ID: 10-b
Agent: architecture-doc (ARCHITECTURE.md)
Task: Write detailed ARCHITECTURE.md with audit per spec section 49

Work Log:
- Leí worklog.md (contexto completo FASE 0-9) y todo el árbol src/ de chismoso.
- Leí los archivos clave en paralelo: models.ts, errors.ts, db.ts, repositories.ts, providers/{base,web-search,reddit,web-content,google-trends}.ts, intelligence/{normalizer,clustering,cross-source,trends,problems,opportunities}.ts, orchestrator/{llm,planner,tools,orchestrator,reporter}.ts, cli.ts, config/index.ts, logger.ts.
- Verifiqué que el directorio docs/ existía (vacío) y que el canonical report inv_muvfmcw36y3lps.md estuviera disponible como referencia real.
- Escribí ARCHITECTURE.md en español técnico con 5 partes: (1) AUDIT sección 49 con 9 subsecciones (current state, architecture, components, reusable, debt, missing, risks, proposed, files), (2) Referencia por módulo con propósito/API/dependencias/anti-patterns, (3) Flujo de datos paso a paso usando inv_muvfmcw36y3lps, (4) 10 ADRs (SQLite, z-ai-web-dev-sdk, GoogleTrends UNAVAILABLE, PROVIDER_TO_TOOL map, overlap coefficient, heuristic problem detection, transparent scoring, TruthLevel, budget-bounded, beforeExit workaround), (5) Fronteras explícitas (≠AGENTE-LEADS, ≠NEX-SCOPE, ≠RADAR-SECOP2, ≠news aggregator, ≠chatbot, no content/email/CRM/scraping/trading).
- Incluí diagramas ASCII (arquitectura en capas, flujo del orchestrator, handoff AGENTE-LEADS) y referencias a archivos/líneas reales del código.
- Añadí apéndices: glosario + mapeo secciones spec → implementación.

Stage Summary:
- File created: /home/z/my-project/chismoso/docs/ARCHITECTURE.md
- Lines: 1936

---
Task ID: 10-d
Agent: qa-verification (DEFINITION_OF_DONE.md)
Task: Independently verify Definition of Done per spec section 57 and write verification report

Work Log:
- Read /home/z/my-project/worklog.md y secciones 37, 39, 57 y 58 del master spec.
- Inspeccioné estructura de /home/z/my-project/chismoso/ (src/providers, src/intelligence, src/orchestrator, src/config, src/cli.ts, src/models.ts, src/db.ts, src/repositories.ts, src/errors.ts, tests/).
- Ejecuté `npx vitest run --reporter=verbose 2>&1 | tee /tmp/chismoso-test-output.txt` — 41/41 tests pasan, 7 archivos, 22.52s.
- Verifiqué los 8 criterios de la sección 57 (Architecture, Truthfulness, Evidence, Memory, Intelligence, Autonomy, Reliability, Testing) con evidencia concreta (rutas de archivo, líneas, tests, valores en reporte JSON).
- Verifiqué TEST DE REALIDAD (sección 39): GoogleTrendsProvider UNAVAILABLE con items=[] + PROVIDER_UNAVAILABLE; segundo test E2E es permisivo pero el código subyacente sí implementa INSUFFICIENT_EVIDENCE.
- Verifiqué NO INVENTAR DATOS (sección 37): rg "mock|fake|dummy|fixture|simulat" en src/ retorna un único match que es documentación explícita de NO simulación; ningún provider inventa datos; URLs provienen exclusivamente del SDK.
- Inspeccioné el reporte canónico /home/z/my-project/download/chismoso/report-inv_muvfmcw36y3lps.json: 25 signals reales, 6 trends, 1 problem (severity 40, freq 65, conf 0.9), 2 opportunities (scores 49 y 42, evidence.length=13 y 1, suggestedNextAgent=AGENTE-LEADS).
- Identifiqué 5 hallazgos menores no bloqueantes: (1) executiveSummary muestra Status: RUNNING por orden de buildReport; (2) Signal.timestamp a veces no es ISO estricto; (3) segundo test E2E permisivo; (4) classifyError no mapea 422 "No search results" a EMPTY_RESULT; (5) segfault de better-sqlite3 en teardown (conocido, no afecta tests).
- Escribí /home/z/my-project/chismoso/docs/DEFINITION_OF_DONE.md en español con: resumen ejecutivo, tabla de tests, 8 secciones de verificación con estado PASS/PARTIAL/FAIL + evidencia, tabla TEST DE REALIDAD, tabla NO INVENTAR DATOS con resultados de grep, verificación del pipeline canónico de sección 58, hallazgos y recomendación final.

Stage Summary:
- File created: /home/z/my-project/chismoso/docs/DEFINITION_OF_DONE.md
- Tests run: 41
- Tests passed: 41
- Tests failed: 0
- Overall verdict: PASS — CHISMOSO V1.0 está listo para entrega con 5 hallazgos menores no bloqueantes documentados.

---
Task ID: EXP-1
Agent: temporal-memory-scheduler
Task: Implement continuous scheduler + topic evolution history + chart component

Work Log:
- Leí worklog.md (contexto FASE 0-9), db.ts (tabla topic_observations ya existe), repositories.ts (recordObservation + getHistory ya existen), orchestrator.ts (ya llama recordObservation tras clustering en línea 254), cli.ts (estructura de arg-parsing switch).
- Verifiqué que `better-sqlite3` NO estaba en el root Next.js project (sólo en chismoso/node_modules). Lo instalé con `bun add better-sqlite3` + `bun add -d @types/better-sqlite3` en el root.
- Probé acceso read-only al DB desde el root: 11 tablas, 5 topic_observations, 2 topics.
- Creé `/home/z/my-project/chismoso/src/scheduler/index.ts`: interface WatchConfig, DEFAULT_WATCH_PATH, DEFAULT_WATCH_CONFIG (3 topics LATAM: restaurantes Colombia, automatización pymes LATAM, IA para pequeños negocios; interval 1h; maxQueries 6), clase TopicScheduler (start/stop, tick reentrancy guard, failure isolation por topic), loadWatchConfig (merge con defaults), saveDefaultWatchConfig (no sobreescribe sin force), fileAppendedLogger (duplica logs a archivo).
- Creé `/home/z/my-project/chismoso/src/scheduler/run.ts`: standalone entry. Carga config, instancia Orchestrator igual que cli.ts (mismos imports), arranca TopicScheduler. SIGINT/SIGTERM detienen gracefully. Logs a `data/scheduler.log`.
- Modifiqué `/home/z/my-project/chismoso/src/cli.ts`: añadí imports del scheduler, añadido branch `if (cmd === 'watch') return runWatchCommand(args, cfg);` ANTES del fallback 'Unknown command'. Añadida función `runWatchCommand` que soporta `--init`, `--interval=Ms`, `--topic="..."`. Añadido `watch` a printHelp. NO se tocaron los branches existentes investigate/demo/providers/history/show/help. Reemplacé el workaround `require('node:fs')` por un import directo `existsSync`.
- Creé `/home/z/my-project/src/app/api/topics/route.ts`: GET /api/topics. Lee SQLite en modo readonly, usa subquery correlacionada para latest_confidence. Response: `{ topics: [{ canonical, lastSeen, observationCount, sourcesCount, latestConfidence }] }`.
- Creé `/home/z/my-project/src/app/api/topics/[topic]/route.ts`: GET /api/topics/[topic]. DecodeURIComponent del segmento, parameter binding (no SQL injection), LIMIT configurable (?limit=30 default, cap 200), reverse a chronological order para el chart. Response: `{ topic, history: [{ observed_at, sources_count, signals_count, evidence_count, confidence, note }] }`.
- Creé `/home/z/my-project/src/components/topics-evolution.tsx`: client component. Props: `topic: string`, `className?`. Fetch con cache:'no-store'. SVG viewBox 0 0 300 120, violet #8b5cf6 polyline + soft area fill + endpoint dot + first/last date labels. Badge de latest confidence (color por umbral 60/30). Refresh button (icon Button con RefreshCw/Loader2). Card shadcn/ui + TrendingUp/RefreshCw/Loader2 de lucide-react.
- Verificación: `cd /home/z/my-project/chismoso && npx tsc --noEmit` → exit 0. `cd /home/z/my-project && bun run lint` → exit 0. Curl a los endpoints devuelve JSON correcto. `chismoso watch --init` crea config válida.
- Escribí work record en `/home/z/my-project/agent-ctx/EXP-1-temporal-memory-scheduler.md`.

Stage Summary:
- Files created:
  - /home/z/my-project/chismoso/src/scheduler/index.ts
  - /home/z/my-project/chismoso/src/scheduler/run.ts
  - /home/z/my-project/src/app/api/topics/route.ts
  - /home/z/my-project/src/app/api/topics/[topic]/route.ts
  - /home/z/my-project/src/components/topics-evolution.tsx
  - /home/z/my-project/agent-ctx/EXP-1-temporal-memory-scheduler.md
- Files modified:
  - /home/z/my-project/chismoso/src/cli.ts (añadido `watch` command, imports del scheduler, existsSync a node:fs)
  - /home/z/my-project/package.json + bun.lock (mejor-sqlite3 + types instalados en root)
- CLI syntax:
  - `chismoso watch` — arranca scheduler con data/watch.json (la crea si falta)
  - `chismoso watch --init` — crea config por defecto y sale
  - `chismoso watch --interval=3600000` — override intervalo (ms)
  - `chismoso watch --topic="restaurantes Colombia"` — replace topics (acepta múltiples --topic=)
  - `npx tsx src/scheduler/run.ts` — entry standalone equivalente
- API endpoints:
  - `GET /api/topics` → `{ topics: [{ canonical, lastSeen, observationCount, sourcesCount, latestConfidence }] }`
  - `GET /api/topics/[topic]?limit=N` (default 30, cap 200) → `{ topic, history: [{ observed_at, sources_count, signals_count, evidence_count, confidence, note }] }` (chronological order)
- Component: `<TopicsEvolution topic="restaurantes" />` — client component, fetch automático, SVG line chart (violet) de signals_count, badge de latest confidence, refresh button. Import: `import { TopicsEvolution } from '@/components/topics-evolution'`.
- Verification: chismoso `npx tsc --noEmit` PASS, Next.js `bun run lint` PASS, curl tests PASS en dev server.

---
Task ID: EXP-5
Agent: streaming-sse
Task: Implement SSE streaming for live investigation progress

Work Log:
- Leí worklog.md (contexto FASE 0-9), orchestrator.ts, route.ts existente, page.tsx (runInvestigation + logTail).
- Inspeccioné logger.ts (logger.info → console.log → stdout; logger.error → console.error → stderr) y cli.ts (console.error('[chismoso] ...') para los milestones "Starting investigation:" y "Reports saved to").
- Inspeccioné web-search.ts, reddit.ts, web-content.ts, trends.ts, problems.ts, opportunities.ts para extraer los nombres de campos exactos de cada JSON milestone (count, durationMs, query, topic, state, score, severity, frequency, confidence, weak, evidenceCount, clusters, signals, trends, problems, opportunities, status, investigationId).
- Cree /home/z/my-project/src/app/api/investigate/stream/route.ts:
  - runtime='nodejs', dynamic='force-dynamic', maxDuration=300.
  - POST handler: lee JSON body {objective, geography?, maxQueries?, maxRuntimeMs?}.
  - GET handler: lee query params (necesario porque EventSource solo soporta GET).
  - Ambos comparten runInvestigationStream() que spawn `npx tsx src/cli.ts investigate ...` en /home/z/my-project/chismoso con CHISMOSO_LOG_LEVEL=INFO.
  - Retorna Response(ReadableStream) con Content-Type: text/event-stream.
  - ReadableStream con start(controller): spawn child, attach stdout/stderr handlers, parseo de líneas, emisión de eventos SSE, safety timeout (maxRuntimeMs + 30s), close handler que envía 'done' y cierra el stream.
  - Cada línea (stdout o stderr) se emite como event:log {line, ts, stream}.
  - JSON lines en stdout se parsean y se extrae el campo msg; cli.ts [chismoso] markers en stderr se matchean con regex.
  - Milestone detection (regex sobre msg o línea cruda): Starting investigation, WebSearchProvider returned, RedditProvider returned, WebContentProvider returned, Clustering complete, Trend detected, Problem detected, Opportunity generated, Investigation completed, Reports saved to.
  - Eventos typed: stage, provider_done, trend, problem, opportunity, saved, done, error.
- Creé /home/z/my-project/src/components/investigation-stream.tsx:
  - 'use client' component con props {objective, geography, maxQueries, maxRuntimeMs?, onComplete?, onError?}.
  - Auto-start en mount: abre EventSource a /api/investigate/stream?objective=...&geography=...&maxQueries=N&maxRuntimeMs=N.
  - Listeners para cada tipo de evento (log, stage, provider_done, trend, problem, opportunity, saved, done, error).
  - Distingue 'error' custom (con data, MessageEvent) vs 'error' nativo EventSource (sin data, readyState CLOSED).
  - Cap de 500 eventos en memoria para evitar overflow con markdown lines.
  - Auto-scroll al fondo en cada nuevo evento (ref + scrollTop = scrollHeight).
  - Card con header mostrando status (RUNNING/COMPLETED/ERROR/IDLE) + currentStage badge + ícono animado.
  - Panel scrollable max-h-96 overflow-y-auto con bg muted/30 + font-mono text-xs.
  - Color coding por evento: stage→violet, provider_done→emerald, trend→sky, problem→amber, opportunity→emerald-bold, saved→emerald, done→emerald header, error→red, log→muted.
  - Íconos lucide-react: Loader2 (spin), CheckCircle2, AlertTriangle, TrendingUp, Target, Database, Server, Save, Activity, FileText.
  - Llama onComplete({investigationId}) cuando llega event:done, onError(msg) cuando event:error.
- Fix lint: moví los setState iniciales (setEvents([]), setIsRunning(true), etc.) del cuerpo del effect al callback 'open' del EventSource para evitar react-hooks/set-state-in-effect (cascading renders).
- Verificación: `bun run lint` pasa limpio (0 errores, 0 warnings).
- Verificación E2E con curl: GET /api/investigate/stream?objective=...&maxQueries=1&maxRuntimeMs=30000 emitió correctamente stage:spawning → log → stage:started → provider_done (web_search count=9, 1880ms) → stage:clustering → trend → stage:completed (status=PARTIAL) → saved (investigationId=inv_muvhedlrbx9whu) → done (code=0, investigationId=inv_muvhedlrbx9whu). Confirmado: todos los eventos SSE se emiten en orden con payloads correctos.

Stage Summary:
- Files created:
  - /home/z/my-project/src/app/api/investigate/stream/route.ts (SSE endpoint, GET + POST)
  - /home/z/my-project/src/components/investigation-stream.tsx (React client component)
- API contract (eventos SSE emitidos):
  - event: stage        data: {stage:"spawning"|"started"|"clustering"|"completed", objective?, geography?, clusters?, signals?, status?, trends?, problems?, opportunities?, durationMs?, investigationId?}
  - event: log          data: {line, ts, stream:"stdout"|"stderr"}
  - event: provider_done data: {provider:"web_search"|"reddit_communities"|"web_content", count, durationMs, query?}
  - event: trend        data: {topic, state, score, sources, signals}
  - event: problem      data: {topic, severity, frequency, confidence, signals}
  - event: opportunity  data: {title, score, confidence, weak, evidenceCount}
  - event: saved        data: {investigationId, path}
  - event: error        data: {message, code}
  - event: done         data: {code, investigationId}
- Component usage in page.tsx (one-line import + usage):
  - import { InvestigationStream } from '@/components/investigation-stream';
  - Render condicional cuando user clic "Investigate":
    {streaming && (<InvestigationStream objective={objective} geography={geography} maxQueries={maxQueries} maxRuntimeMs={180_000} onComplete={({investigationId}) => { fetchReport(investigationId); setStreaming(false); }} onError={(msg) => { setError(msg); setStreaming(false); }} />)}
  - El parent debe manejar un flag `streaming` (true al iniciar, false en onComplete/onError). onComplete entrega {investigationId} para fetchear el reporte completo desde /api/investigations/[id].

---
Task ID: EXP-4
Agent: embeddings-semantic
Task: Implement embedding-based clustering + semantic search

Work Log:
- Leí worklog.md (contexto FASE 0-9 + EXP-1, EXP-5), clustering.ts (overlap coefficient), normalizer.ts (tokenize), orchestrator/llm.ts (uso de z-ai-web-dev-sdk), models.ts (Signal, TopicCluster).
- Inspeccioné el SDK types en /home/z/.bun/install/global/node_modules/z-ai-web-dev-sdk/dist/index.d.ts — confirmé que z-ai-web-dev-sdk v0.0.18 expone: chat.completions, audio, images, video, async, functions. NO expone `embeddings` API. Decidí usar el fallback local TF-IDF hash (documentado en el header del archivo embeddings.ts).
- Creé /home/z/my-project/chismoso/src/intelligence/embeddings.ts: EmbeddingClient con dim=256, signed hashing (Weinberger 2009 hashing trick), L2-normalización, cache Map<text, EmbeddingVector>, embedBatch paralelo. Funciones exportadas: cosineSimilarity, euclideanDistance, defaultEmbeddingClient. Warning one-shot cuando useSDK=true (por si el SDK futuro añade embeddings).
- Creé /home/z/my-project/chismoso/src/db-extensions/embeddings.sql.ts: tabla `signal_embeddings(signal_id PK, embedding_blob BLOB, dim, model, created_at)`, índice por model. Funciones: ensureEmbeddingsSchema (CREATE IF NOT EXISTS), embeddingsTableExists (para readonly conns), storeEmbedding + storeEmbeddings (transaction bulk), loadEmbedding + loadAllEmbeddings, pruneOrphanEmbeddings. Float32Array ↔ Buffer con slice de ArrayBuffer para evitar aliasing por byteOffset != 0.
- Creé /home/z/my-project/chismoso/src/intelligence/semantic-cluster.ts: clusterSignalsSemantic con union-find (path halving + union by rank) sobre pares con cosine sim > threshold. DEFAULT_THRESHOLD=0.18 (calibrado para TF-IDF hash: within-group avg 0.46, across-group avg 0.006; gap cómodo entre 0.05 y 0.40). DEFAULT_MIN_CLUSTER_SIZE=2 (singletons = noise pero quedan en signalToCluster). Drop-in compatible con clusterSignals (mismo TopicCluster shape, mismo canonical heuristic con tokenize de normalizer).
- Creé /home/z/my-project/chismoso/src/intelligence/semantic-search.ts: semanticSearch(query, {db, topK, minScore, embeddingClient}) — carga todos los embeddings de signal_embeddings, embeda el query, computa cosine sim, filtra por modelo (skip si modelo mismatch), hidrata snippet+url de signals, top-K. Top-K default 10, max 50.
- Creé /home/z/my-project/src/app/api/semantic-search/route.ts: POST handler self-contained (sin imports cross-project). Inlined TF-IDF hash algorithm byte-idéntico a embeddings.ts para que embeddings escritos por el orchestrator sean buscables. Abre DB readonly; si signal_embeddings no existe → 200 con results:[] (estado pre-warmup, no error). topK 1..50 capped. Validación: 400 missing_query, 400 topK_out_of_range. Squash de scores negativos a 0.
- Creé /home/z/my-project/chismoso/scripts/test-embeddings.ts: 10 fake signals en 3 grupos temáticos (WHATSAPP_RESERVAS, EMAIL_MARKETING, CRYPTO_PAYMENTS). Verifica: (1) embeddings dim=256, (2) self-sim ≈ 1, (3) within-group avg sim > across-group avg sim, (4) clusters puros por grupo, (5) round-trip SQLite con drift < 1e-6, (6) semanticSearch top-1 correcto para 3 queries temáticas.
- Creé /home/z/my-project/chismoso/scripts/seed-embeddings.ts: utilidad one-shot para poblar signal_embeddings desde las signals existentes en el DB real. Ejecutado: 53 signals embedadas y persistidas en /home/z/my-project/chismoso/data/chismoso.db.
- Verificación: `cd chismoso && npx tsc --noEmit` → exit 0. `cd /home/z/my-project && bun run lint` → exit 0. test-embeddings.ts → ALL ASSERTIONS PASSED. API real: POST /api/semantic-search con query="inteligencia artificial pymes automatizar" → top-3 signals de IA/pymes (score 0.57, 0.39, 0.36), todos de itsitio.com, revista-360grados.com, eltiempo.com. Latencia 8ms por query (DB readonly, 53 embeddings).
- Escribí work record en /home/z/my-project/agent-ctx/EXP-4-embeddings-semantic.md.

Stage Summary:
- Files created:
  - /home/z/my-project/chismoso/src/intelligence/embeddings.ts
  - /home/z/my-project/chismoso/src/intelligence/semantic-cluster.ts
  - /home/z/my-project/chismoso/src/intelligence/semantic-search.ts
  - /home/z/my-project/chismoso/src/db-extensions/embeddings.sql.ts
  - /home/z/my-project/chismoso/scripts/test-embeddings.ts
  - /home/z/my-project/chismoso/scripts/seed-embeddings.ts
  - /home/z/my-project/src/app/api/semantic-search/route.ts
  - /home/z/my-project/agent-ctx/EXP-4-embeddings-semantic.md
- Embedding strategy: LOCAL TF-IDF HASH (dim=256, signed hashing, L2-normalized). Razón: z-ai-web-dev-sdk v0.0.18 NO expone embeddings API (verificado en dist/index.d.ts — solo chat, audio, images, video, async, functions.web_search, functions.page_reader). El fallback es determinista, gratis, rápido (<1ms por snippet), offline, y captura token co-occurrence mejor que el overlap coefficient. Documentado en el header de embeddings.ts. Cuando el SDK exponga embeddings reales, basta reemplazar computeEmbedding sin tocar consumidores (interfaz idéntica).
- Threshold: 0.18 para TF-IDF hash (DEFAULT_THRESHOLD en semantic-cluster.ts). Calibrado empíricamente: within-group avg sim 0.46, across-group avg sim 0.006 → gap de separación amplio entre 0.05 y 0.40. Para embeddings reales (OpenAI/Cohere), subir a ~0.65. Receta de tuning documentada en el header del archivo.
- Semantic search API contract:
  - POST /api/semantic-search
  - Body: { "query": string, "topK"?: number (1..50, default 10) }
  - 200: { "results": [{ "signalId": string, "score": number (0..1), "snippet": string, "url"?: string }] }
  - 200 con results:[] si la tabla signal_embeddings no existe todavía (pre-warmup state, no error)
  - 400: { "error": "missing_query" | "topK_out_of_range" | "invalid_json", "message": string }
  - 500: { "error": "search_failed", "message": string, "results": [] }
- Test results (test-embeddings.ts):
  - 10/10 assertions pass
  - 3 clusters puros formados: WHATSAPP_RESERVAS (4 signals, canonical="whatsapp"), EMAIL_MARKETING (3 signals, canonical="email"), CRYPTO_PAYMENTS (3 signals, canonical="payments")
  - Within-group avg sim 0.46, across-group avg sim 0.006 (Δ=0.45)
  - Round-trip SQLite drift < 1e-6 (bit-identical)
  - semanticSearch top-1 correcto para 3/3 queries temáticas
- API real (con 53 embeddings seedados):
  - "inteligencia artificial pymes automatizar" → top-3: "pymes preparación IA" (0.57), "66% pymes IA Colombia" (0.39), "100k capacitación IA" (0.36) — todos relevantes
  - "automatización restaurantes pedidos" → top-1: "restaurantes implementando IA y automatización" (0.50) — match exacto
  - Latencia 6-10ms por query

---
Task ID: EXP-6
Agent: anomaly-detection
Task: Implement anomaly detection + proactive alerts

Work Log:
- Leí worklog.md (contexto FASE 0-9 + EXP-1, EXP-4, EXP-5), chismoso/src/db.ts (tabla topic_observations), chismoso/src/repositories.ts (TopicRepository.getHistory y recordObservation), chismoso/src/models.ts (modelos canónicos).
- Inspeccioné DB existente: 7 topics con observaciones (automatizacion 4, inteligencia 4, restaurantes 4, experiencias 2, funcionalidades 1, manufacturers 1, restaurant 1). Default minSamples=5 → respuesta correcta = lista vacía con nota de insuficiencia histórica.
- Creé /home/z/my-project/chismoso/src/anomaly/stats.ts: 6 helpers puros (mean, stddev sample n-1, zscore, ewma single-value, percentile linear interp, linearRegressionSlope OLS). Todos defensivos ante arrays vacíos/1-elemento (retornan 0 en vez de lanzar).
- Creé /home/z/my-project/chismoso/src/anomaly/index.ts: AnomalyDetector class con detectAll(), detectForTopic(topic), onAnomaly(cb). Config default: windowDays=30, minSamples=5, zscoreThreshold=2.0, ewmaAlpha=0.3. Lógica de detección: (1) load 60 obs via repos.topics.getHistory, (2) skip si < minSamples, (3) baseline = older half, current = most recent, (4) mean+stddev de signals_count baseline, (5) z-score > threshold → volume_spike/drop, (6) rolling EWMA slope last 7 obs vs baseline slope — direction change OR magnitude > 3x → velocity_change, (7) source_types nuevos en current vs baseline (vía signals table) → source_diversification, (8) confidence delta > 0.1 en últimas 5 obs → confidence_drift, (9) severity por |z|: >3 high, >2.5 medium, >2 low, (10) recommendedAction por type+severity (e.g. volume_spike+high → "Ejecutar una investigación completa sobre este tema ahora"). IDs determinísticos `anm_<type>__<topic>__<observedAt>` para dedupe cross-run. Re-exports stats helpers desde el barrel.
- Modifiqué /home/z/my-project/chismoso/src/cli.ts: añadidos imports AnomalyDetector + readFileSync (merged con imports existentes de 'node:fs'). Añadido branch `if (cmd === 'anomalies') return runAnomaliesCommand(args, cfg)` ANTES del fallback 'Unknown command'. Añadida función `runAnomaliesCommand` con flags --topic, --watch, --interval (default 5min). Modo --watch: loop con setInterval, filtra anomalías cuyo `id` ya está en lastSeenIds O cuyo observedAt <= lastSeenObservedAt, persiste estado en data/anomalies.state.json (cap 5000 IDs para evitar growth ilimitado), SIGINT/SIGTERM persisten estado y salen graceful. Añadidas loadAnomalyState/saveAnomalyState helpers. Añadida help text + subcommands al printHelp. NO se tocaron branches existentes (investigate, demo, providers, history, show, watch, mesh).
- Creé /home/z/my-project/src/lib/anomaly-detector.ts: port server-side del detector para Next.js. Lee DB via better-sqlite3 readonly (sin spawn subprocess). Misma lógica de detección byte-idéntica al chismoso (los IDs son los mismos). Comment header explícito: "chismoso es fuente de verdad — este es un port". Acepta config overrides (minSamples, zscoreThreshold) para los endpoints.
- Creé /home/z/my-project/src/app/api/anomalies/route.ts: GET handler, runtime='nodejs', dynamic='force-dynamic'. Query params: ?topic, ?minSamples, ?zscoreThreshold. Response: { ranAt, topic, count, anomalies: Anomaly[], config }. 500 con error message si detection falla.
- Creé /home/z/my-project/src/app/api/alerts/route.ts: GET handler, thin wrapper. Filtra a severity medium+high (a menos que ?severity=low). Sort por sevRank (high=0, medium=1, low=2) luego por |zscore| desc. Response: { ranAt, count, alerts: Anomaly[], config }. Mismos query params que /api/anomalies.
- Creé /home/z/my-project/src/components/anomaly-alerts.tsx: 'use client' component. Props: className?, alertsOnly? (cambia endpoint a /api/alerts), pollIntervalMs? (default 30000). Fetch en mount + setInterval. Refresh button "Revisar ahora". Empty state con pulsing dot (animate-ping bg-emerald-400) + "Sin anomalías detectadas. Vigilando…". Anomaly cards con: icon (TrendingUp/Activity/Bell/AlertTriangle según type), topic bold, type badge color-coded (spike=rose, drop=sky, velocity=amber, diversification=violet, confidence_drift=cyan), severity badge (high=rose, medium=amber, low=slate), description 1 línea, recommendedAction italic, observedAt relativo ("5m ago"), z/baseline/currentValue stats. Lista scrollable max-h-96. Tipos Anomaly duplicados localmente (no importados de @/lib/anomaly-detector) para evitar arrastrar better-sqlite3 al client bundle — comment explícito de sync.
- Verificación: `cd chismoso && npx tsc --noEmit` → exit 0. `cd /home/z/my-project && bun run lint` → exit 0. CLI `chismoso anomalies` retorna `{"count":0,"anomalies":[]}` (válido: DB tiene <5 obs/topic). CLI `--watch --interval=1000` smoke test 3s: detecta 0 anomalías, persiste state file correctamente, SIGTERM graceful. CLI `chismoso providers` y `chismoso history` siguen funcionando (no se rompió nada). curl GET /api/anomalies → 200 JSON. curl GET /api/alerts → 200 JSON. Smoke test con thresholds bajos (?minSamples=2&zscoreThreshold=0.1) confirma que el detector dispara volume_drop para automatizacion (z=-0.27) y restaurantes (z=-2.12). Verificación con DB in-memory seeded: 4 anomalías detectadas (confidence_drift + volume_spike + velocity_change + confidence_drift) con severities y recommendedActions correctas.
- Escribí work record en /home/z/my-project/agent-ctx/EXP-6-anomaly-detection.md.

Stage Summary:
- Files created:
  - /home/z/my-project/chismoso/src/anomaly/stats.ts (6 stats helpers puros)
  - /home/z/my-project/chismoso/src/anomaly/index.ts (AnomalyDetector class)
  - /home/z/my-project/src/lib/anomaly-detector.ts (port server-side para Next.js)
  - /home/z/my-project/src/app/api/anomalies/route.ts (GET handler)
  - /home/z/my-project/src/app/api/alerts/route.ts (GET handler, medium+high filter)
  - /home/z/my-project/src/components/anomaly-alerts.tsx (React client component)
  - /home/z/my-project/agent-ctx/EXP-6-anomaly-detection.md (work record)
- Files modified:
  - /home/z/my-project/chismoso/src/cli.ts (añadido `anomalies` command + runAnomaliesCommand + load/saveAnomalyState + help text + imports)
- Anomaly types: volume_spike, volume_drop, velocity_change, source_diversification, confidence_drift (5 tipos, según spec)
- CLI: `chismoso anomalies [--topic=<name>] [--watch] [--interval=Ms]`
- API:
  - GET /api/anomalies?topic=&minSamples=&zscoreThreshold= → { ranAt, topic, count, anomalies, config }
  - GET /api/alerts?severity=low → { ranAt, count, alerts, config } (filtrado medium+high por defecto)
- Test results:
  - chismoso tsc → 0 errors
  - Next.js lint → 0 errors
  - CLI `chismoso anomalies` → `{"count":0,"anomalies":[]}` (válido, DB insuficiente historia)
  - CLI `--watch --interval=1000` smoke test → loops, persiste state file, SIGTERM graceful
  - GET /api/anomalies → 200 JSON con config default
  - GET /api/alerts → 200 JSON con config default
  - Smoke test minSamples=2 + zscoreThreshold=0.1 → detecta 2 volume_drop (automatizacion z=-0.27, restaurantes z=-2.12) ✓
  - In-memory seeded test → 4 anomalías (confidence_drift + volume_spike z=24.14 + velocity_change 8.1x + confidence_drift) ✓

---
Task ID: EXP-2
Agent: multi-agent-mesh
Task: Implement multi-agent mesh with SQLite queue + webhook delivery + external signals inbox

Work Log:
- Leí worklog.md (contexto FASE 0-9 + EXP-1 + EXP-5), models.ts (campo `Opportunity.suggestedNextAgent`), db.ts (schema V1 con WAL), repositories.ts (OpportunityRepository.findByInvestigation), orchestrator.ts (persiste oportunidades en STEP 6).
- Diseñé el mesh como outbox+inbox simple en SQLite — sin broker externo, sin tocar `orchestrator.ts`. La única integración con el orchestrator es POST-investigate vía `autoPublishOpportunities()` invocado desde `cli.ts`.
- Creé `/home/z/my-project/chismoso/src/mesh/db.ts`: clase `MeshDB` que abre una CONEXIÓN SEPARADA better-sqlite3 al mismo `data/chismoso.db` (WAL soporta readers/writers concurrentes). Migración idempotente con `CREATE TABLE IF NOT EXISTS` para 4 tablas: `mesh_outbox`, `external_signals`, `mesh_subscribers`, `mesh_meta`. Índices en `(agent_target, delivered_at)`, `created_at`, `consumed_at`, `received_at`.
- Creé `/home/z/my-project/chismoso/src/mesh/webhook.ts`: función `deliverWebhook()` — POSTa JSON con header `X-Chismoso-Signature: sha256=<hmac-sha256 del body>` si se provee secret, AbortController con timeout 10s, retorna `{ok, status, error?}`. 2xx = ok.
- Creé `/home/z/my-project/chismoso/src/mesh/index.ts`: clase `AgentMesh` con publishOpportunity (idempotente: deduplica por `(opportunityId, agentTarget)`), pendingFor (no marca delivered), ack(ids) (marca delivered), deliverPending (barre pending, llama deliverWebhook por cada subscriber activo, incrementa delivery_attempts y captura last_error en fallo), ingestExternalSignal, unconsumedExternalSignals, markConsumed, listExternalSignals, getConfig/setConfig (en tabla `mesh_meta` key=enabled), listSubscribers/upsertSubscriber/removeSubscriber, status() con conteos. Tipos exportados: `OpportunityEvent`, `ExternalSignalEvent`, `MeshConfig`, `MeshConfigSubscriber`, `DeliveryStats`.
- Creé `/home/z/my-project/chismoso/src/mesh/auto-publish.ts`: función `autoPublishOpportunities(repos, mesh, investigationId)` — lee `repos.opportunities.findByInvestigation(investigationId)` y publica cada opportunity. NO modifica orchestrator.ts. Respeta el flag `enabled` del MeshConfig (no-op si está disabled).
- Modifiqué `/home/z/my-project/chismoso/src/cli.ts`:
  - Añadí imports de `AgentMesh` y `autoPublishOpportunities`.
  - En el branch `investigate`, DESPUÉS de `orchestrator.investigate()` exitoso y ANTES de `console.log(result.report.markdown)`, instancio `AgentMesh` y llamo `autoPublishOpportunities(repos, mesh, result.investigation.id)`. Si publicó >0, imprime `[chismoso] Published N opportunities to mesh outbox`. Try/catch/finally para no romper el flow si el mesh falla.
  - Añadí branch `if (cmd === 'mesh') return runMeshCommand(args, cfg)` ANTES del fallback 'Unknown command'. NO se tocaron los branches existentes.
  - Añadí función `runMeshCommand` con subcomandos: status, publish (--opportunity-id=), deliver, subscribe (--agent= --url= [--secret=]), list (--pending --agent= [--limit=]), signals ([--limit=]), config, enable, disable.
  - Actualicé printHelp() con la sección "Mesh subcommands".
- Creé `/home/z/my-project/src/app/api/mesh/_mesh-db.ts`: helper compartido para las rutas Next.js. Abre better-sqlite3 directamente al DB, ejecuta el mismo schema idempotente. Tipos: `MeshOpportunityEvent`, `MeshExternalSignal`, `MeshSubscriberRow`, `MeshStatus`. Funciones: `fetchPendingEvents`, `ackEvents`, `ingestExternalSignal`, `fetchExternalSignals`, `listSubscribers`, `getMeshConfig`, `setMeshConfig`, `getMeshStatus`. (Patrón idéntico al de `/api/topics/route.ts` — no importa AgentMesh desde el paquete chismoso para mantener las rutas thin y desacopladas del runtime de chismoso.)
- Creé `/home/z/my-project/src/app/api/mesh/events/route.ts`: GET ?agent=X&limit=N retorna pending events (NO marca delivered — el cliente debe ack). POST `{ids:string[]}` actúa como ack alternativo.
- Creé `/home/z/my-project/src/app/api/mesh/events/ack/route.ts`: POST `{ids:string[]}` → `{ok:true, acked:N}`.
- Creé `/home/z/my-project/src/app/api/mesh/external-signals/route.ts`: POST `{source_agent, signal_type, payload}` ingiere señal externa → `{ok, id, received_at}`. GET ?limit=N&unconsumed=1 lista señales.
- Creé `/home/z/my-project/src/app/api/mesh/config/route.ts`: GET retorna MeshConfig (secrets sanitizados — sólo `hasSecret: boolean`). PUT `{enabled, subscribers:[{agentName, webhookUrl, secret?, eventsFilter?}]}` reemplaza la config completa (valida URLs http(s)://).
- Verificación: `cd /home/z/my-project/chismoso && npx tsc --noEmit` → exit 0. `cd /home/z/my-project && bun run lint` → exit 0.
- E2E test: habilité mesh con PUT /api/mesh/config, subscribí AGENTE-LEADS a https://example.com/webhook, ingrese una señal de NEX-SCOPE vía POST /api/mesh/external-signals. Corrí `chismoso investigate "automatización de facturación para pymes Colombia"` — produjo 1 opportunity, auto-publish hook disparó `[chismoso] Published 1 opportunities to mesh outbox`. `chismoso mesh status` mostró pendingOutbox incrementado. GET /api/mesh/events?agent=AGENTE-LEADS retornó JSON con eventos. POST /api/mesh/events/ack marcó 1 delivered. `chismoso mesh deliver` intentó 5 webhooks (falló 405 porque example.com no acepta POST, pero delivery_attempts y last_error se registraron correctamente).
- Escribí work record en `/home/z/my-project/agent-ctx/EXP-2-multi-agent-mesh.md`.

Stage Summary:
- Files created:
  - /home/z/my-project/chismoso/src/mesh/db.ts
  - /home/z/my-project/chismoso/src/mesh/webhook.ts
  - /home/z/my-project/chismoso/src/mesh/index.ts
  - /home/z/my-project/chismoso/src/mesh/auto-publish.ts
  - /home/z/my-project/src/app/api/mesh/_mesh-db.ts
  - /home/z/my-project/src/app/api/mesh/events/route.ts
  - /home/z/my-project/src/app/api/mesh/events/ack/route.ts
  - /home/z/my-project/src/app/api/mesh/external-signals/route.ts
  - /home/z/my-project/src/app/api/mesh/config/route.ts
  - /home/z/my-project/agent-ctx/EXP-2-multi-agent-mesh.md
- Files modified:
  - /home/z/my-project/chismoso/src/cli.ts (añadido `mesh` command + imports + auto-publish hook en investigate + help)
- Tables added to SQLite (data/chismoso.db): mesh_outbox, external_signals, mesh_subscribers, mesh_meta
- API: 4 endpoints (7 verbos):
  - GET /api/mesh/events?agent=X&limit=N
  - POST /api/mesh/events (body {ids} — alt ack)
  - POST /api/mesh/events/ack (body {ids})
  - GET /api/mesh/external-signals?limit=N&unconsumed=1
  - POST /api/mesh/external-signals (body {source_agent, signal_type, payload})
  - GET /api/mesh/config
  - PUT /api/mesh/config (body {enabled, subscribers})
- CLI: `chismoso mesh <subcommand>` — status / publish / deliver / subscribe / list / signals / config / enable / disable
- Auto-publish hook: wired into `chismoso investigate` (after orchestrator.investigate succeeds, before markdown report). Idempotent (dedupes by opportunity_id+agent_target). Respects MeshConfig.enabled flag.
- Verification: chismoso `npx tsc --noEmit` PASS, Next.js `bun run lint` PASS, E2E curl tests PASS.

---
Task ID: EXP-3
Agent: react-loop
Task: Implement ReAct loop with LLM tool-use for adaptive investigation

Work Log:
- Read the required files: orchestrator.ts (template), llm.ts (LLM client), tools.ts (ToolRegistry + 4 tools), models.ts (Investigation/Budget/Status/InvestigateResult), index.ts (barrel), cli.ts (existing commands).
- Found that the three files in my domain (`orchestrator/react.ts`, `orchestrator/index.ts`, `cli.ts`) were already present and wired up — verified they correctly implement the ReAct spec.
- Verified `react.ts` (705 lines) implements: PLAN (Reuses ResearchPlanner for first 2 queries) → EXECUTE (search_more / deepen via ToolRegistry) → OBSERVE (reads signals+evidence from DB) → EVALUATE (LLM chat with strict-JSON prompt, sanitization of queries/urls, force-stop on near-exhausted budget) → ANALYZE (same clusterSignals → detectTrend → detectProblem → generateOpportunity → buildReport flow as Orchestrator). Same InvestigateResult shape — drop-in replacement.
- Verified `react.ts` reuses `OrchestratorConfig` (TYPE-ONLY import), uses the same `PROVIDER_TO_TOOL` map, records every iteration in `investigation.errors` as `react_iter_N: action — reason — +sig +ev (total S/E)`, enforces all 4 budget dimensions (maxIterations / maxQueries / maxProviderCalls / maxRuntimeMs) both pre-execution and post-iteration.
- Verified `cli.ts` `investigate-react` branch (lines 96–153) accepts the same args as `investigate` (--geography, --max-queries, --max-runtime-ms, --save), surfaces the `react_iter_*` log entries as a grouped block on stderr, saves reports to disk when --save is passed, and explicitly calls `db.close()` + `process.exit(0)` to avoid the better-sqlite3 native destructor crash. The existing `investigate`, `demo`, `providers`, `history`, `show`, `watch`, `mesh`, `anomalies` commands are untouched.
- Ran `cd /home/z/my-project/chismoso && npx tsc --noEmit` → exit 0 (no type errors).
- Ran `cd /home/z/my-project && bun run lint` → exit 0 (no lint errors).
- Ran the end-to-end verification command from the spec multiple times: `npx tsx src/cli.ts investigate-react "Investiga oportunidades de automatización para pequeños restaurantes en Colombia." --geography=Colombia --max-queries=4 --max-runtime-ms=120000 --save`. The ReAct loop is intermittently crashed by a known better-sqlite3 + tsx + Node v24 + concurrent Next.js dev-server issue (SIGABRT during `Statement::~Statement()` cleanup) — I confirmed this is a pre-existing environmental issue that ALSO affects the original `investigate` command (3/3 runs crashed identically), NOT a regression introduced by ReActOrchestrator. When the run succeeds, the loop works correctly.

Stage Summary:
- Files: /home/z/my-project/chismoso/src/orchestrator/react.ts (exists/verified), /home/z/my-project/chismoso/src/orchestrator/index.ts (already re-exports ./react.js), /home/z/my-project/chismoso/src/cli.ts (investigate-react branch present, all other commands intact).
- Iterations: Successful run (EXIT=0) produced 2 ReAct iterations: iter_1 (search_more, +6sig/+6ev) and iter_2 (search_more, +17sig/+17ev, total 23/23). The LLM in iter_2 observed thin POS-focused evidence and chose search_more with fresh queries targeting different angles — demonstrating the adaptive loop.
- Status: COMPLETED (signals=23 > 0 and opportunities=4 > 0).
- Counts: 23 signals · 23 evidence · 4 trends (3 WEAK_SIGNAL + 1 NOISE) · 3 problems · 4 opportunities.
- Duration: 41406ms (within 120s budget).
- Reports saved: /home/z/my-project/download/chismoso/report-inv_muvixwil17ncad.{md,json} (16KB markdown + 269KB JSON).
- Full agent context written to: /home/z/my-project/agent-ctx/EXP-3-react-loop.md.

---
Task ID: AUDIT-PERF
Agent: performance-auditor
Task: Audit CHISMOSO V1.1 for performance issues

Work Log:
- Leí /home/z/my-project/worklog.md (primeras 60 líneas) para entender el contexto del proyecto (Fases 0-9 completas, documentación delegada a subagentes).
- Listé /home/z/my-project/chismoso/src/ (39 archivos) y /home/z/my-project/src/ (60+ archivos, UI Next.js + 50 shadcn/ui components).
- Intenté `sqlite3 chismoso.db ".indexes"` y ".schema" — sqlite3 CLI no instalado. Cambié a inspección directa de SCHEMA_V1 en chismoso/src/db.ts:32-214 y MESH_SCHEMA en src/app/api/mesh/_mesh-db.ts:21-60.
- Confirmé que /home/z/my-project/chismoso/data/ NO existe — causa raíz de los 500 errores en /api/mesh/config observados en dev.log:17,24.
- Confirmé que /home/z/my-project/chismoso/dist/ NO existe — chismoso nunca fue compilado, cada llamada CLI paga JIT overhead de tsx.
- Leí dev.log (32 líneas) — timing real: /api/providers 3.3s (frío) → 771ms (caliente); /api/mesh/config 500 (bug); /api/investigations 628ms → 27ms.
- Audit completos de repositories.ts (todos los findBy* methods verificados contra índices existentes — 8 índices faltantes identificados).
- Audit completos de los 8 API routes (topics, topics/[topic], anomalies, alerts, investigate, investigate/stream, investigations, investigations/[id], semantic-search, mesh/config, mesh/events, mesh/events/ack, mesh/external-signals, providers) — todos abren NUEVA conexión better-sqlite3 por request.
- Audit React: page.tsx (1305 líneas, 17 useState), TopicsEvolution (buen uso de useMemo), AnomalyAlerts (polling 30s correctamente limpiado en unmount), InvestigationStream (EventSource correctamente cerrado en unmount, PERO key={i} anti-pattern + slice O(n) por evento >500).
- Audit SSE stream: flushing inmediato por línea (bueno), pero NO hay handler para req.signal.abort — procesos huérfanos por hasta maxRuntimeMs+30s.
- Audit bundle: 12 dependencias pesadas en package.json que no son importadas por la UI de chismoso (recharts, react-markdown, framer-motion, @dnd-kit/*, @tanstack/*, etc.).
- Escribí /home/z/my-project/agent-ctx/AUDIT-PERF.md (21 findings, top 5 quick wins).

Stage Summary:
- Findings: 21 total — 4 Critical, 8 High, 6 Medium, 3 Low
- Top quick wins:
  1. Pre-compile chismoso a dist/ y cambiar spawn de `npx tsx` a `node dist/cli.js` (ahorra ~2-3s por llamada CLI) — CRITICAL
  2. Crear src/lib/db-chismoso.ts como singleton global better-sqlite3 (ahorra 10-50ms por request) — HIGH
  3. Agregar 8 índices faltantes en signals.timestamp, trends.created_at, *_investigation_id (5 índices), evidence(topic, collected_at) — HIGH
  4. Cachear /api/providers por 5 min en variable module-level (elimina spawn de 770ms-3.3s por page load) — HIGH
  5. Registrar req.signal.abort handler en /api/investigate y /investigate/stream para matar child processes al disconnect — HIGH
- File: /home/z/my-project/agent-ctx/AUDIT-PERF.md

---
Task ID: IMP-2
Agent: ssrf-protection
Task: Add SSRF protection + URL validation + path traversal hardening

Work Log:
- Read worklog.md (skim), webhook.ts, web-content.ts, investigations/[id]/route.ts, topics/[topic]/route.ts to understand existing surface area and trust boundaries.
- Created chismoso/src/mesh/url-validator.ts — validateOutboundUrl() implementing SSRF guard: non-http(s) protocols, localhost (127/8, ::1, 0/8), private IPs (10/8, 172.16/12, 192.168/16, 169.254/16 incl. cloud metadata 169.254.169.254), CGNAT 100.64/10, IPv6 ULA fc00::/7 + link-local fe80::/10, internal TLDs (.local/.internal/.lan/.intranet), userinfo, suspicious hostnames (no dot / leading dot), and common DB/admin ports (22, 25, 3306, 5432, 6379, 27017).
- Modified chismoso/src/mesh/webhook.ts — deliverWebhook() now invokes validateOutboundUrl(url) BEFORE fetch(). On failure returns { ok: false, status: 0, error: 'URL rejected: <reason>' }. On success uses validation.safeUrl.toString() for the actual fetch. Replaced the previous naive /^https?:\/\// regex with the full SSRF check.
- Modified src/app/api/investigations/[id]/route.ts — kept existing /^[\w-]+$/ regex gate, then layered defense-in-depth: path.basename(id) strips any directory component, then a path.resolve() containment check on BOTH the .md and .json paths confirms they stay inside OUTPUT_DIR + path.sep. Returns 400 'Path traversal detected' otherwise.
- Verified src/app/api/topics/[topic]/route.ts — already uses parameterized SQL (WHERE topic = ? + LIMIT ? with .all(topic, limit)). No string interpolation. No changes needed.
- Created chismoso/tests/url-validator.test.ts — 10 test cases covering: valid https, non-http protocols (file/ftp/gopher), localhost variants, private IPs, cloud metadata, userinfo, internal TLDs, suspicious hostnames, DB ports, malformed URLs.
- Modified chismoso/vitest.config.ts — added empty inline css.postcss.plugins: [] override so vitest doesn't try to load the parent Next.js postcss.config.mjs (which references @tailwindcss/postcss not installed in chismoso's node_modules). This is what let the tests actually execute.

Stage Summary:
- Files:
  - CREATED: chismoso/src/mesh/url-validator.ts
  - CREATED: chismoso/tests/url-validator.test.ts
  - MODIFIED: chismoso/src/mesh/webhook.ts (SSRF guard before fetch)
  - MODIFIED: src/app/api/investigations/[id]/route.ts (basename + resolve containment)
  - MODIFIED: chismoso/vitest.config.ts (css.postcss override to unblock tests)
  - VERIFIED ONLY: src/app/api/topics/[topic]/route.ts (already parameterized)
- URL blocks: non-http(s) protocols; localhost + IPv4 loopback (127/8, 0/8); IPv6 loopback (::1); private IPv4 (10/8, 172.16/12, 192.168/16); link-local incl. cloud metadata (169.254/16 — blocks 169.254.169.254 AWS/GCP metadata); CGNAT (100.64/10); IPv6 ULA (fc00::/7) + link-local (fe80::/10); internal TLDs (.local/.internal/.lan/.intranet); URL userinfo (user:pass@host); suspicious hostnames (no dot / leading dot); DB/admin ports (22, 25, 3306, 5432, 6379, 27017).
- Tests: 10 passed / 10 total (npx vitest run tests/url-validator.test.ts → 10/10 in 8ms)
- Verification: tsc --noEmit → EXIT 0; bun run lint → EXIT 0
- Detailed record: /home/z/my-project/agent-ctx/IMP-2-ssrf-protection.md

---
Task ID: IMP-4
Agent: dashboard-markdown
Task: Add proper markdown renderer + dashboard summary view

Work Log:
- Leí worklog.md (contexto FASE 0-9 + EXP-1..EXP-6 + AUDIT-PERF), src/app/page.tsx (especialmente tabs del reporte + empty-state placeholder), src/components/ (3 components existentes: investigation-stream, anomaly-alerts, topics-evolution — ninguno toca markdown ni dashboard), src/components/ui/ (full shadcn set), API routes contracts (/api/investigations, /api/investigations/[id], /api/providers, /api/anomalies, /api/mesh/config, /api/topics), y el sample report /home/z/my-project/download/chismoso/report-inv_muvga00rrq7yrd.md.
- Creé /home/z/my-project/src/components/markdown-renderer.tsx: renderer markdown sin dependencias externas (no react-markdown, no @tailwindcss/typography). Parser line-by-line con Block union tipado. Inline parser maneja `code`, [label](url), **bold**, *italic* con prioridad code > link > bold > italic. Soporta headings #..######, fenced code blocks (```lang), horizontal rules (---/***/___), blockquotes (> ...), unordered lists (-/*/+) , ordered lists (1.), GFM pipe tables (con delimiter row y escaped \|), paragraphs. Todos los nodos son React elements reales (no dangerouslySetInnerHTML). Links abren en nueva pestaña con rel="noopener noreferrer" y solo permiten http(s)/mailto/relative URLs.
- Creé /home/z/my-project/src/components/dashboard-summary.tsx: landing dashboard con 2×2 grid en desktop / stacked en mobile. 4 cards: (1) Estado general — 4 stat tiles con investigaciones totales, providers OK (X/N), anomalías activas, mesh On/Off+subscribers; (2) Oportunidades destacadas — top 3 por score entre las 5 investigaciones más recientes (fan-out detail fetch con Promise.all); (3) Topics en vigilancia — top 5 por observation count; (4) Cómo empezar — guía 4 pasos. Todas las fetches son defensivas (fetchJson<T>() retorna null en cualquier error), y cada card trackea su propio flag `*_failed` para mostrar "endpoint caído" honesto en vez de misleading zeros — necesario porque en dev observé /api/mesh/config, /api/topics, /api/anomalies devolviendo 500 (pre-existing DB issues que no debía tocar).
- Modifiqué /home/z/my-project/src/app/page.tsx: añadidos imports MarkdownRenderer + DashboardSummary. En el TabsContent "markdown" reemplacé `<MarkdownView markdown={result.report.markdown} />` con `<MarkdownRenderer markdown={result.report.markdown} />` (envuelto en div border bg-card p-4 overflow-x-auto para mantener el frame). En el bloque `!result && !loading` reemplacé el placeholder `<Card>` con `<DashboardSummary />` y añadí `&& !streaming` al condition para que el dashboard se oculte durante ReAct streaming.
- Mantuve `<MarkdownView>` (la función helper original con `<pre>`) como fallback según spec.
- Verificación: `cd /home/z/my-project && bun run lint` → exit 0. Dev server recompiled cleanly (logs muestran `✓ Compiled in 57ms/953ms`). curl http://localhost:3000/ → 200, HTML contiene "Resumen del sistema", "Investigaciones", "Providers OK" (dashboard renderiza server-side). Dev log confirma las 5 fetches del dashboard: /api/investigations 200, /api/providers 200, /api/anomalies 500 (degradado gracefully), /api/mesh/config 500 (degradado gracefully), /api/topics 500 (degradado gracefully), /api/investigations/inv_muvga00rrq7yrd 200 (detail fetch para top opportunities).
- Escribí work record en /home/z/my-project/agent-ctx/IMP-4-dashboard-markdown.md.

Stage Summary:
- Files created:
  - /home/z/my-project/src/components/markdown-renderer.tsx (330 lines)
  - /home/z/my-project/src/components/dashboard-summary.tsx (540 lines)
  - /home/z/my-project/agent-ctx/IMP-4-dashboard-markdown.md
- Files modified:
  - /home/z/my-project/src/app/page.tsx (imports + Reporte tab usa MarkdownRenderer + empty-state usa DashboardSummary)
- Markdown features: H1-H6 headings, **bold**, *italic*, `inline code`, ```fenced code blocks```, ordered/unordered lists, [links](url), ---/***/___ horizontal rules, > blockquotes, GFM pipe tables (with escaped \|), paragraphs.
- Dashboard sections: (1) Estado general — 4 stat tiles (investigaciones / providers OK / anomalías / mesh); (2) Oportunidades destacadas — top 3 por score cross-investigations; (3) Topics en vigilancia — top 5 por observation count; (4) Cómo empezar — 4-step quick-start guide.
- Verification: lint exit 0, dev server compiles cleanly, curl 200 OK, dashboard renders server-side, defensive fetches handle the 500s on /api/mesh/config, /api/topics, /api/anomalies.

---
Task ID: AUDIT-CODE
Agent: code-quality-auditor
Task: Audit CHISMOSO V1.1 for code quality issues

Work Log:
- Leí worklog.md (393 líneas) para entender el contexto completo: FASE 0-9 (V1.0), EXP-1 scheduler, EXP-2 mesh, EXP-3 react, EXP-4 embeddings+semantic-search, EXP-5 SSE streaming, EXP-6 anomaly-detection.
- Listé /home/z/my-project/chismoso/src/ (41 archivos .ts en 9 subdirectorios) y /home/z/my-project/src/ (26 archivos .ts/.tsx en app/ components/ lib/ hooks/).
- Ejecuté `cd chismoso && npx tsc --noEmit` → exit 0 (no type errors, no strict-mode warnings).
- Audité TypeScript strictness: 0 @ts-ignore/@ts-expect-error, 6 eslint-disable-next-line (3× no-explicit-any en react.ts, 3× no-console en logger/scheduler/run), ~65 usos de `any` concentrados en repositories.ts (21), react.ts (8), mesh/index.ts (10), page.tsx (10), _mesh-db.ts (5), cli.ts (5).
- Audité error handling: 11 rutas API con shapes inconsistentes — solo `/api/providers` sigue el contrato `{error, details}`; las demás usan `{error, message}` o `{error}` sin details. `/api/investigate` retorna 200 OK incluso en failure con `{ok:false}`. try/catch/finally con db.close() en finally es consistente. ~15 catch {} vacíos con /* ignore */ comments.
- Audité code duplication: 3 duplicaciones mayores — (1) `_mesh-db.ts` (303 LOC) duplica MESH_SCHEMA + row parsers de `chismoso/src/mesh/`; (2) `src/lib/anomaly-detector.ts` (380 LOC) port completo de `chismoso/src/anomaly/`; (3) TF-IDF hash embedding (~80 LOC) duplicado entre `embeddings.ts` y `semantic-search/route.ts`. Patrón de spawn CLI duplicado entre `/api/investigate/route.ts` y `/api/investigate/stream/route.ts`.
- Audité architecture violations: NO hay UI imports desde chismoso/src/ ✓, NO hay intelligence→orchestrator imports ✓, NO hay providers→intelligence imports ✓, NO hay circular imports ✓. PERO encontré 2 architectural gaps críticos: (1) El orchestrator NO llama storeEmbedding — los embeddings solo se siembran una vez vía seed-embeddings.ts, así que nuevas investigaciones no son buscables vía semantic-search. (2) `clusterSignalsSemantic` nunca se invoca desde ninguno de los dos orchestrators — la feature V1.1 existe pero está muerta en el pipeline productivo.
- Audité dead code: `src/components/markdown-renderer.tsx` (435 LOC) nunca importado; `InvestigationRepository.update()` nunca llamado; `ToolRegistry.describe()/list()` nunca usados; `AnomalyDetector.onAnomaly()` API sin consumidores; `euclideanDistance` y `defaultEmbeddingClient` sin uso productivo; `examples/websocket/` y `tests/python-runtime-*.sh` son orphans no relacionados a CHISMOSO; `prisma/schema.prisma` leftover de scaffolding.
- Audité React specific: page.tsx 1305 líneas (mega-componente), falta useMemo en sorts de opportunities/trends, setTab(v as any) y setSideTab(v as any) type-unsafe, OpportunityCard/TrendCard/ProblemCard tienen `any` types en props. Todos los client components tienen 'use client' ✓. InvestigationStream maneja refs correctamente ✓.
- Audité SQL patterns: todos los queries usan `?` placeholders ✓ (única excepción es `${placeholders}` en semantic-search/route.ts:286 que es una lista de `?` marks, seguro). N+1 query pattern en orchestrator.ts:225-282 (findByTopic por cluster) y en anomaly/index.ts detectAll (3 queries por topic).
- Audité logging hygiene: logger.ts tiene sanitize() que redacta apikey/api_key/token/password/secret/authorization/auth recursivamente ✓. /api/mesh/config GET sanitiza secrets a hasSecret:boolean ✓. No PII capturada. getClientIP solo se usa para rate-limit keying, no se loguea ✓. Log levels (DEBUG/INFO/WARN/ERROR) usados apropiadamente.
- Audité test coverage: 8 archivos de tests en chismoso/tests/ cubren 7 módulos V1.0 + url-validator V1.1. **8 de 9 módulos V1.1 NO tienen tests** (mesh/db, mesh/index, mesh/webhook, mesh/auto-publish, scheduler, anomaly/index, anomaly/stats, orchestrator/react, intelligence/embeddings, intelligence/semantic-cluster, intelligence/semantic-search, db-extensions/embeddings.sql). Lado Next.js: 0 tests, 0 config de vitest/jest.
- Escribí reporte completo en /home/z/my-project/agent-ctx/AUDIT-CODE.md con 28 findings estructurados por severidad (2 Critical, 7 High, 11 Medium, 6 Low, 2 Info).

Stage Summary:
- Findings: 28 total (2 Critical, 7 High, 11 Medium, 6 Low, 2 Info)
- Critical: V1.1 modules near-zero test coverage (8/9 untested); embeddings never auto-persisted (semantic search goes stale after every new investigation)
- High: 65+ `any` types in persistence + API layers; inconsistent API error shapes across 11 routes; 3 major code duplications (~700 LOC); spawn-CLI logic duplicated between investigate routes; dead file markdown-renderer.tsx (435 LOC); dead method InvestigationRepository.update(); as any[] casts on better-sqlite3 rows
- Untested V1.1 modules: mesh/{db,webhook,index,auto-publish}, scheduler/{index,run}, anomaly/{index,stats}, orchestrator/react, intelligence/{embeddings,semantic-cluster,semantic-search}, db-extensions/embeddings.sql (1/9 tested: url-validator)
- File: /home/z/my-project/agent-ctx/AUDIT-CODE.md

---
Task ID: IMP-1
Agent: rate-limit-hardening
Task: Add rate limiting + input validation hardening to all API routes

Work Log:
- Read worklog.md + 4 target route files to understand existing validation patterns.
- Created src/lib/rate-limit.ts — in-memory per-IP rate limiter (Map-backed, unref'd 5min cleanup interval), getClientIP() from x-forwarded-for/x-real-ip, pre-configured LIMITS per endpoint family. Exposed __resetRateLimitStoreForTests() so tests can deterministically reset state.
- Created src/lib/validation.ts — validators for objective, geography, maxQueries, maxRuntimeMs, topic, topK, meshPayload. ADDED validateQuery (string, ≤500 chars) since /api/semantic-search requires query validation but the spec source didn't include it — kept route handler DRY.
- Modified /api/investigate/route.ts — rate limit (5/min/IP) BEFORE body parse, replaced inline validation with the 4 validators, body fields typed as `unknown`.
- Modified /api/investigate/stream/route.ts — parseParams now uses the 4 validators directly; rate limit applied to BOTH GET and POST (separate `stream:` bucket from `investigate:`).
- Modified /api/semantic-search/route.ts — rate limit (30/min/IP); replaced inline checks with validateQuery + validateTopK.
- Modified /api/mesh/external-signals/route.ts — rate limit (60/min/IP) on POST; replaced ad-hoc body checks with validateMeshPayload.
- Installed vitest@5.0.3 as dev dependency (wasn't present).
- Created tests/rate-limit.test.ts (10 tests) + tests/validation.test.ts (55 tests).
- First test run: 1 failure — `validateObjective('rm -rf /')` returns ok:true because the regex only blocks [;|&`$()] and rm -rf / contains none. Fixed the test: added a "does NOT block" test case documenting the defense-in-depth limitation, and changed the metachar test cases to strings that actually contain blocked chars (ls; rm -rf /, cat /etc/passwd &).
- Re-ran: 65/65 pass. bun run lint clean.
- Smoke-tested endpoints via curl against dev server: all 4 endpoints return HTTP 400 + validator error message on bad input; all 4 return HTTP 429 + Retry-After header after quota exhausted (verified in dev.log).

Stage Summary:
- Files: src/lib/rate-limit.ts (new), src/lib/validation.ts (new), tests/rate-limit.test.ts (new), tests/validation.test.ts (new), agent-ctx/IMP-1-rate-limit-hardening.md (new); modified: src/app/api/investigate/route.ts, src/app/api/investigate/stream/route.ts, src/app/api/semantic-search/route.ts, src/app/api/mesh/external-signals/route.ts
- Limits: investigate=5/min/IP, stream=5/min/IP, semanticSearch=30/min/IP, meshPost=60/min/IP — all per-IP, 60s sliding window, 429 + Retry-After header.
- Tests: 65 passed (10 rate-limit + 55 validation), 0 failed.

---
Task ID: IMP-3
Agent: tests-v11-precompile
Task: Add tests for V1.1 modules + pre-compile CHISMOSO for faster API

Work Log:
- Skimmed worklog.md, listed tests/ + src/mesh/ + src/scheduler/ + src/anomaly/ + src/orchestrator/.
- Read clustering.test.ts (existing pattern), react.ts, anomaly/{index,stats}.ts, scheduler/index.ts, mesh/index.ts, mesh/url-validator.ts, semantic-cluster.ts, semantic-search.ts, embeddings.ts, embeddings.sql.ts, orchestrator.ts (InvestigateResult contract), planner.ts, llm.ts, tools.ts, repositories.ts, db.ts.
- Created tests/mesh.test.ts (14 tests): AgentMesh publish/pending/ack/ingestExternalSignal/unconsumed/markConsumed roundtrips, idempotent publish, getConfig/setConfig atomic subscribers, status() counts, validateOutboundUrl SSRF guard smoke tests.
- Created tests/scheduler.test.ts (12 tests): TopicScheduler constructor/start/stop/idempotency, interval fires, failing investigate does NOT crash loop, loadWatchConfig (missing/empty/invalid/roundtrip), saveDefaultWatchConfig (force vs no-force, default values).
- Created tests/anomaly.test.ts (36 tests): mean/stddev/zscore/ewma/percentile/linearRegressionSlope pure-math tests with known values + edge cases; AnomalyDetector empty/insufficient-samples/baseline/volume_spike/confidence_drift_up/confidence_drift_down/detectAll/custom-minSamples/custom-zscoreThreshold/onAnomaly-subscriber/deterministic-IDs.
- Created tests/react.test.ts (7 tests): ReActOrchestrator constructor smoke test; investigate() returns InvestigateResult shape (investigation+signals+evidence+trends+problems+opportunities+report); stop-on-first-evaluate (LLM call count = 2); invalid-JSON-evaluate forces stop; maxIterations=1 forces stop without calling evaluate (LLM calls = 1); planner-throwing propagates + persists FAILED investigation; default-budget path. StubLLM extends real LLMClient and overrides chat() to return canned JSON by inspecting system prompt. Stub ToolRegistry returns empty results without provider calls — no network.
- Created tests/semantic-cluster.test.ts (17 tests): cosineSimilarity (identical/orthogonal/opposite/zero-vector/dimension-mismatch/textbook-formula); clusterSignalsSemantic (empty/5-identical/5-unrelated/mix/threshold-override/embeddings-returned); semanticSearch (no-embeddings-table/empty-table/top-result-is-most-similar/topK-limits/minScore-filter). All use in-memory ChismosoDB + ensureEmbeddingsSchema + storeEmbedding for the DB-backed search tests.
- Modified chismoso/package.json: added `precompile: tsc` and `precompile:watch: tsc --watch` scripts (alongside existing `build`).
- Pre-compiled CHISMOSO with `npx tsc` — dist/cli.js + 30+ .js/.d.ts/.js.map files created successfully.
- Modified /src/app/api/investigate/route.ts: added `existsSync` import, `COMPILED_CLI` + `USE_COMPILED` constants; spawn now uses `node dist/cli.js ...` when compiled, falls back to `npx tsx src/cli.ts ...` otherwise. Preserved IMP-2's rate-limit + validation imports.
- Modified /src/app/api/investigate/stream/route.ts: same pattern. SSE stream now spawns `node dist/cli.js` (or tsx fallback).
- Modified /src/app/api/providers/route.ts: same pattern.
- Verified .gitignore already excludes `dist/` (no change needed).
- Verification: `npx tsc --noEmit` (chismoso) → exit 0. `bun run lint` (Next.js) → exit 0. `npx vitest run` → 135/137 pass (the 2 failures are pre-existing e2e.test.ts cases hitting the real LLM API — they fail due to API rate limits / 429 errors, NOT from my changes; verified they fail for the same reason on the unchanged baseline).
- Measured pre-compile speedup: `/api/providers` latency dropped from 1309ms (tsx) to 184ms (node dist/cli.js) — **~7.1x faster, saving ~1.1s per call**. For `investigate` calls (which include 15-30s of LLM/network time), the savings is ~370ms of CLI startup overhead per invocation.

Stage Summary:
- Files:
  - NEW: chismoso/tests/mesh.test.ts (14 tests)
  - NEW: chismoso/tests/scheduler.test.ts (12 tests)
  - NEW: chismoso/tests/anomaly.test.ts (36 tests)
  - NEW: chismoso/tests/react.test.ts (7 tests)
  - NEW: chismoso/tests/semantic-cluster.test.ts (17 tests)
  - MODIFIED: chismoso/package.json (added precompile + precompile:watch scripts)
  - MODIFIED: src/app/api/investigate/route.ts (USE_COMPILED switch)
  - MODIFIED: src/app/api/investigate/stream/route.ts (USE_COMPILED switch)
  - MODIFIED: src/app/api/providers/route.ts (USE_COMPILED switch)
  - GENERATED: chismoso/dist/** (via `npx tsc` — already excluded from .gitignore)
- Tests: 51 → 137 (+86 new tests; 135 passing, 2 pre-existing e2e tests fail due to LLM API rate limits — unrelated to IMP-3 domain)
- Pre-compile speedup: `/api/providers` 1309ms → 184ms (~7.1x faster, ~1.1s saved per call); CLI startup itself: 432ms → 62ms (~7x faster, ~370ms saved per CLI invocation)

---
Task ID: FIX-2
Agent: sqlite-singleton-indexes-abort
Task: Add SQLite singleton + missing indexes + child process abort handler

Work Log:
- Read AUDIT-PERF.md and the 8 required source files to scope the fix surface.
- Created `src/lib/db-chismoso.ts` — single readonly `better-sqlite3` connection to `chismoso/data/chismoso.db` (mkdirSync'd defensively, HMR-safe via globalThis). On cold start it runs `CREATE INDEX IF NOT EXISTS` for the 7 missing performance indexes (signals.timestamp, signals(topic,timestamp DESC), trends.created_at DESC, problems.created_at DESC, opportunities.score DESC, evidence(topic, collected_at DESC), provider_runs.investigation_id).
- Added `SCHEMA_V2` block to `chismoso/src/db.ts` mirroring the same 6 indexes (idempotent), applied right after `SCHEMA_V1` in the `ChismosoDB` constructor.
- Updated `src/lib/anomaly-detector.ts` to consume the singleton (this is the file that actually opens a DB connection for `/api/anomalies` and `/api/alerts`). Removed `new Database(...)` open and `db.close()` from `detectAnomalies`; the singleton is reused across all calls.
- Updated `src/app/api/topics/route.ts` and `src/app/api/topics/[topic]/route.ts` to use `chismosoDb` singleton (removed `let db: Database.Database | null = null; ... finally { db.close() }` boilerplate).
- Rewrote `src/app/api/mesh/_mesh-db.ts`: `openMeshDb()` now returns a single shared `Database` instance (HMR-safe via globalThis). mkdirSync'd the parent dir before opening. Overrode the singleton's `close` method to be a no-op so existing route handlers that call `db.close()` in `finally` blocks don't kill the shared connection.
- Wired abort handlers to both `/api/investigate/route.ts` and `/api/investigate/stream/route.ts`: registered `req.signal.addEventListener('abort', abortListener)` that sends SIGTERM, then SIGKILL after 2s. Listener is removed in the `close`/`error`/`finalize` paths so we don't leak it.
- For the stream route, threaded `req.signal` through `runInvestigationStream(params, signal)` so both POST and GET paths can subscribe.

Stage Summary:
- Files: src/lib/db-chismoso.ts (NEW), src/lib/anomaly-detector.ts, src/app/api/topics/route.ts, src/app/api/topics/[topic]/route.ts, src/app/api/mesh/_mesh-db.ts, src/app/api/investigate/route.ts, src/app/api/investigate/stream/route.ts, chismoso/src/db.ts
- Indexes added: 7 (6 new in SCHEMA_V2 + idx_opportunities_score re-applied; chismoso's MeshDB schema already had 4 mesh-specific indexes that remain untouched)
- Speedup (warm renders, measured via curl against running dev server):
    * /api/topics   : 18ms → 4–6ms     (≈3× faster render)
    * /api/anomalies: 23ms → 4–7ms     (≈4× faster render; first-call anomaly-detector module compile also gone on warm hits)
    * /api/alerts   : 6ms → 3–5ms      (≈1.5–2× faster render)
    * /api/mesh/config: 5ms → 3–6ms    (similar warm timing)
  The bigger wins are on cold paths and on data-heavy loads — each request no longer pays the 10–50ms `new Database()` open overhead.
- mesh/config 500 fixed: yes — was 500-ing before (visible in dev.log history: "GET /api/mesh/config 500 in 7ms" etc.). After fix, returns 200 consistently. mkdirSync ensures the parent dir exists before opening the DB, and the singleton avoids reopening.
- abort handler wired: yes, both /api/investigate and /api/investigate/stream now kill the spawned child on client disconnect (SIGTERM immediately, SIGKILL after 2s grace).
- Verification: `cd chismoso && npx tsc --noEmit` passes (no output). `bun run lint` passes (no output). All four test endpoints return 200 with empty data on a fresh DB.

---
Task ID: FIX-3
Agent: cache-deadcode-cleanup
Task: Add TTL cache for /api/providers + consolidate mesh DB duplication + investigate anomaly-detector port

Work Log:
- Read AUDIT-CODE.md, providers/route.ts, _mesh-db.ts, chismoso/src/mesh/db.ts, anomaly-detector.ts; verified markdown-renderer IS imported (page.tsx:41) — AUDIT-CODE HIGH #6 finding is OBSOLETE.
- Created src/lib/cache.ts: minimal TTL cache (Map + periodic sweep every 5 min via `.unref()`). Exports getCached / setCached / invalidate / invalidateAll. Process-local, no Redis.
- Modified src/app/api/providers/route.ts (now layered on top of the api-response refactor): GET checks `getCached('providers:list')` first → returns `{providers, cached:true}` immediately. On miss, spawns CLI as before, then `setCached(..., 5*60*1000)` only for non-empty results (so silent CLI failures don't pin an empty list for 5 min). Response now carries `cached: boolean`.
- Consolidated src/app/api/mesh/_mesh-db.ts with chismoso MeshDB: removed the duplicated `MESH_SCHEMA` SQL string + `MESH_DB_PATH` + manual `new Database + WAL + exec(MESH_SCHEMA)` block. Now imports `MeshDB` and `DEFAULT_MESH_DB_PATH` from `../../../../chismoso/dist/mesh/db.js` (precompiled by IMP-3). `openMeshDb()` instantiates `new MeshDB()` and returns `.raw`. Re-exported `DEFAULT_MESH_DB_PATH` so callers don't hardcode the path. All 4 row-helper functions (fetchPendingEvents, ackEvents, ingestExternalSignal, fetchExternalSignals, getMeshConfig, setMeshConfig, getMeshStatus) preserved as Next.js-specific HTTP wrappers. Added TODO to extract row helpers into a shared module chismoso+Next.js can import from. Silenced chismoso's structured logger to WARN (so the per-request MeshDB constructor `logger.info` doesn't spam stdout).
- Investigated anomaly-detector.ts: chismoso `AnomalyDetector` is a CLASS that takes a `Repositories` instance → requires the full chismoso `ChismosoDB` graph (migrations, FK setup, scheduler lifecycle). Re-exporting it into the Next.js runtime would force the dashboard to run those migrations and hold a long-lived `ChismosoDB` across HMR. Kept the port. Rewrote the header comment explaining WHY it's a port (not a re-export) + added a TODO to extract the detection algorithm into a pure `detectAnomaliesFromRows(rows, config)` function in a shared package.
- Bonus fix: anomaly-detector.ts had `import type { Database } from 'better-sqlite3'` which broke `Database.Database` namespace-qualified type access (TS2702). Switched to `import Database from 'better-sqlite3'` (default value import — same pattern as db-chismoso.ts). Pre-existing issue from the singleton refactor, not introduced by this task, but it was in my domain.
- Verification:
  * `cd chismoso && npx tsc --noEmit` → exit 0, no output. ✓
  * `bun run lint` → no errors. ✓
  * My domain files all type-check cleanly (anomaly-detector.ts errors gone; _mesh-db.ts and cache.ts no errors; providers/route.ts no errors).
  * /api/providers timing (curl, dev server):
      - Cold call (spawn CLI): 147ms total, response `cached:false, providers:4`
      - Cached call:              12ms total, response `cached:true, providers:4`
      - Speedup: ~12× (≈135ms saved per cached call). The handler render time on cache hit drops to ~3-5ms (rest is curl/network).
  * /api/mesh/config: 200 in 4-6ms (works after refactor — chismoso MeshDB import succeeds)
  * /api/mesh/events?agent=TEST_AGENT: 200, returns `{"agent":"TEST_AGENT","count":0,"events":[]}`
  * /api/mesh/external-signals?limit=3: 200, returns `{"count":0,"signals":[]}`
- Pre-existing issue NOT in scope (noted for next agent): better-sqlite3 Statement destructor crashes Next.js HMR (Assertion `(env) != nullptr` in `RemoveEnvironmentCleanupHook`). Triggered by chismosoDb singleton (in db-chismoso.ts) being torn down during HMR. Affects dev only. Reproduces on every code change while a long-lived Database is open. Mitigation: restart `bun run dev`.

Stage Summary:
- Files: src/lib/cache.ts (NEW), src/app/api/providers/route.ts (MODIFIED), src/app/api/mesh/_mesh-db.ts (MODIFIED), src/lib/anomaly-detector.ts (MODIFIED header comment + import fix)
- Cache TTL: 5 min for /api/providers (`PROVIDERS_CACHE_KEY = 'providers:list'`). Periodic Map sweep every 5 min in cache.ts.
- /api/providers speedup: 147ms → 12ms (≈12×, ~135ms saved per cached call)
- markdown-renderer OBSOLETE finding (AUDIT-CODE HIGH #6): yes, IS imported (src/app/page.tsx line 41). The finding is stale — IMP-4 integrated it.
- _mesh-db.ts: schema + path duplication REMOVED (chismoso MeshDB imported). Row helpers kept (Next.js-specific, documented).
- anomaly-detector.ts: port KEPT (documented why replacing with chismoso class would force full ChismosoDB lifecycle into Next.js). TODO added for future extraction.

---
Task ID: FIX-1
Agent: embeddings-pipeline
Task: Wire embeddings auto-generation + semantic clustering into orchestrator pipeline

Work Log:
- Read AUDIT-CODE critical finding #2 + 7 source files (orchestrator, react, embeddings client, embeddings.sql, semantic-cluster, clustering, db, models).
- Modified clustering.ts: added `clusterSignalsAuto()` exported function (~130 LOC). Picks semantic path when signals.length>=8 AND db AND embeddingClient are provided; otherwise falls back to the existing token-based `clusterSignals()`. On the semantic path, also persists missing embeddings via `storeEmbeddings` (single transaction). Returns `{clusters, signalToCluster, strategy, reason}` for caller-side logging. Failures in persistence fall back to in-memory-only semantic clustering (non-fatal).
- Modified orchestrator.ts STEP 5: pre-embeds signals (idempotent — only embeds signals without a stored embedding yet) via `ensureEmbeddingsSchema + loadAllEmbeddings + EmbeddingClient.embedBatch + storeEmbeddings`. Then calls `clusterSignalsAuto` with the SAME pre-warmed EmbeddingClient (cache hit on clusterSignalsSemantic's internal re-embed → avoids triggering better-sqlite3 Statement destructor crash on Node 22+ that the codebase already documents in vitest.config.ts). Wrapped in try/catch — embedding failures don't fail the investigation (they're nice-to-have, not critical).
- Modified react.ts STEP 6: identical changes as orchestrator.ts (drop-in replacement contract).
- Aligned text format across all 3 modules: `${keyword} ${topic} ${rawSnippet.slice(0, 200)}` (matches `clusterSignalsSemantic.signalToText`). Previously the audit pseudocode suggested `slice(0, 500)` which would have missed the cache.
- Added `scripts/verify-fix-1.ts` (181 LOC) — standalone smoke that bypasses the rate-limited LLM and exercises the exact post-collection path the orchestrator runs: builds 10 fake signals, calls `clusterSignalsAuto`, verifies (1) strategy='semantic', (2) `signal_embeddings` table has 10 rows, (3) `semanticSearch('restaurantes reservas whatsapp')` returns ranked results. ALL ASSERTIONS PASS. Top result: sig_wa_2 score=0.679.
- tsc --noEmit: PASS. bun run lint: PASS (0 warnings, 0 errors). vitest run: 135/137 tests pass; the 2 failures are tests/e2e.test.ts which require live LLM API (currently returning HTTP 429 from upstream — pre-existing infra issue, NOT caused by this change; failure stack originates in ResearchPlanner.plan at line 70, which is STEP 1, well before STEP 5 where my changes live).
- Could NOT run the full CLI `investigate` end-to-end because the ZAI LLM API is rate-limited (429 on every request — affects planner, react decision loop, etc.). Verified the embeddings pipeline directly via scripts/verify-fix-1.ts which exercises the exact same code path the orchestrator runs at STEP 5/6 (post-collection analysis), bypassing the LLM.

Stage Summary:
- Files:
  - chismoso/src/intelligence/clustering.ts (MODIFIED +128 LOC)
  - chismoso/src/orchestrator/orchestrator.ts (MODIFIED +74 LOC)
  - chismoso/src/orchestrator/react.ts (MODIFIED +68 LOC)
  - chismoso/scripts/verify-fix-1.ts (NEW +181 LOC, smoke script for ad-hoc verification)
- Semantic search working: YES (verified via scripts/verify-fix-1.ts; top hit sig_wa_2 score=0.679 for query "restaurantes reservas whatsapp")
- Strategy chosen in test run: semantic (reason: "semantic (persisted 10 new embedding(s))")
- Audit critical finding #2 RESOLVED: orchestrator + ReAct now call `storeEmbeddings` after every investigation; `clusterSignalsSemantic` is wired in via `clusterSignalsAuto`. `/api/semantic-search` will return fresh results after each new investigation.

---
Task ID: FIX-4
Agent: api-error-normalization
Task: Normalize all API error responses to { error, details? } shape

Work Log:
- Read AUDIT-CODE.md HIGH #4 finding (inconsistent API error shapes across 11 routes).
- Read all 14 API route files under src/app/api/ to inventory current error patterns.
- Created src/lib/api-response.ts exporting apiError, apiOk, apiBadRequest, apiNotFound, apiRateLimited, apiServerError, apiUnavailable helpers.
- Modified /api/investigate/route.ts: rate limit + JSON parse + validation errors → apiRateLimited/apiBadRequest; failed investigation status (FAILED) → apiServerError 500 instead of 200 OK with ok:false; success → apiOk.
- Modified /api/investigate/stream/route.ts: rate limit + JSON parse + validation errors → helpers (POST + GET paths).
- Modified /api/investigations/route.ts: empty list response → apiOk.
- Modified /api/investigations/[id]/route.ts: 400 invalid id → apiBadRequest; 404 not found → apiNotFound; 200 success → apiOk.
- Modified /api/providers/route.ts: 500 errors already used { error, details } shape — refactored to use apiServerError; success → apiOk.
- Modified /api/topics/route.ts: 500 { error, message, topics: [] } → apiServerError('topics_query_failed', { message }); success → apiOk.
- Modified /api/topics/[topic]/route.ts: 400 missing_topic → apiBadRequest; 500 → apiServerError; success → apiOk (kept TopicHistoryResponse interface).
- Modified /api/anomalies/route.ts: 500 { error, message, ... } → apiServerError('anomaly_detection_failed', { message, ranAt, topic }); success → apiOk.
- Modified /api/alerts/route.ts: same pattern as anomalies; 500 → apiServerError('alerts_query_failed', { message, ranAt }).
- Modified /api/mesh/events/route.ts: removed { ok: true, acked } wrapper, success → apiOk({ acked }); 400/500 errors → helpers.
- Modified /api/mesh/events/ack/route.ts: same pattern as mesh/events.
- Modified /api/mesh/external-signals/route.ts: rate limit + JSON parse + validation + ingest/query errors → helpers; success → apiOk (no ok:true wrapper).
- Modified /api/mesh/config/route.ts: GET success → apiOk; PUT validation errors (invalid_json/missing_field/invalid_subscriber) → apiBadRequest with code in details; 500 read/write → apiServerError.
- Modified /api/semantic-search/route.ts: rate limit + JSON parse + missing_query + topK_out_of_range → apiBadRequest with code in details; 500 → apiServerError('search_failed', { message }); empty results → apiOk({ results: [] }).
- Narrowed all `catch (e: any)` to `catch (e: unknown)` with `instanceof Error` checks.
- Verified bun run lint passes (exit 0) and npx tsc --noEmit passes for all files in src/app/api/ and src/lib/api-response.ts.
- Confirmed zero remaining NextResponse.json calls in src/app/api/ via grep.

Stage Summary:
- Files: 15 (1 new lib/api-response.ts + 14 route files modified)
- Routes normalized: 14
- Inconsistent shapes fixed: 11 (the 11 flagged in AUDIT-CODE HIGH #4)
