# 00_MASTER: Arquitectura del Sistema (ARCHITECTURE)

**Fecha:** 2026-11-13  
**Arquitectura:** Full-Stack Decoupled (Next.js Dashboard + Engine CLI + SQLite + Sidecars)

---

## 1. Diagrama de Arquitectura Global

```
                        ┌────────────────────────────────────────┐
                        │              USUARIO                   │
                        │   (Browser / Telegram / WhatsApp)      │
                        └──────────────────┬─────────────────────┘
                                           │
                                           ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ NEXT.JS APPLICATION (Port 3000)                                                  │
│                                                                                 │
│  ┌───────────────────────┐                    ┌───────────────────────────────┐ │
│  │ UI Components         │                    │ API Routes                    │ │
│  │ - ChatView (SSE)      │                    │ - POST /api/chat (ReAct Loop) │ │
│  │ - InvestigateView     │◀──────────────────▶│ - POST /api/investigate       │ │
│  │ - SettingsView        │                    │ - GET  /api/investigations    │ │
│  │ - WhatsAppQR          │                    │ - GET  /api/signals-config    │ │
│  └───────────────────────┘                    └──────────────┬────────────────┘ │
└──────────────────────────────────────────────────────────────┼──────────────────┘
                                                               │
                                         ┌─────────────────────┴────────────────┐
                                         │                                      │
                                         ▼                                      ▼
             ┌───────────────────────────────────────────────┐      ┌─────────────────────────┐
             │ CHISMOSO ENGINE CLI (TypeScript Subprocess)   │      │ WHATSAPP DAEMON (3002)  │
             │   chismoso/dist/cli.js                        │      │ Baileys Multi-Device    │
             │                                               │      │ Bearer Internal Secret  │
             │  ┌─────────────────────────────────────────┐  │      └─────────────────────────┘
             │  │ ReAct Orchestrator & Research Engine    │  │
             │  │ - Query Planner                         │  │
             │  │ - WebSearchProvider (Serper / Tavily)   │  │
             │  │ - Signal Normalizer & Deduplicator      │  │
             │  │ - Trend & Problem Clusterer             │  │
             │  │ - Opportunity Synthesizer               │  │
             │  └────────────────────┬────────────────────┘  │
             └───────────────────────┼───────────────────────┘
                                     │
                                     ▼
             ┌───────────────────────────────────────────────┐
             │ PERSISTENCIA LOCAL                            │
             │ - SQLite DB: chismoso/data/chismoso.db        │
             │ - Reportes: download/chismoso/report-*.{md,json}
             │ - Ajustes: .signals-settings.json             │
             └───────────────────────────────────────────────┘
```

---

## 2. Flujo de Datos del Chat Conversacional (`/api/chat`)
1. **Petición del cliente:** El navegador envía `{ message: string, sessionId?: string }`.
2. **ReAct Loop:** El modelo (Groq `openai/gpt-oss-120b`) analiza la intención del usuario.
3. **Selección de Herramientas:** Si el usuario pregunta por hallazgos previos, el LLM emite `{"tool": "list_investigations"}` o `{"tool": "load_investigation"}`.
4. **Ejecución Local:** La API consulta los endpoints internos (`http://127.0.0.1:3000/api/investigations/...`) y devuelve el resumen al LLM.
5. **Streaming SSE:** La respuesta final se desglosa en eventos `token` para dar sensación de mecanografía en tiempo real en la UI.

---

## 3. Flujo de Datos de una Investigación (`/api/investigate`)
1. **Invocación:** Se recibe `{ objective, geography, maxQueries, maxRuntimeMs }`.
2. **Spawning del CLI:** Se invoca de forma no bloqueante `node chismoso/dist/cli.js investigate ...`.
3. **WebSearchProvider (Serper):** Se realizan llamadas HTTPS directas a `https://google.serper.dev/search`.
4. **Análisis de Señales:** Se parsean títulos, snippets, fechas y metadatos orgánicos.
5. **Generación de Reportes:** Se emiten los archivos `report-<id>.md` y `report-<id>.json` en `download/chismoso/`.
6. **Almacenamiento:** Las señales y tendencias se insertan en `chismoso/data/chismoso.db`.
