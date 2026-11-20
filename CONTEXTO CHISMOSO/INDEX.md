# ÍNDICE MAESTRO DE CONTEXTO CHISMOSO

**Última sincronización:** 2026-11-13  
**Directorio raíz:** `CONTEXTO CHISMOSO/`

---

## 🗂️ Mapeo Completo de Documentación

| Directorio | Archivo | Descripción | Estado |
| :--- | :--- | :--- | :--- |
| **00_MASTER** | `PROJECT_STATE.md` | Estado operacional verificado, capacidades activas y límites de diseño | 🟢 VERIFIED |
| **00_MASTER** | `ARCHITECTURE.md` | Diagramas de componentes, flujo de datos Dashboard ↔ CLI y SQLite | 🟢 VERIFIED |
| **00_MASTER** | `AGENT_IDENTITY.md` | Personalidad telegram-style, prompts de sistema y ReAct loop | 🟢 VERIFIED |
| **01_DECISIONS** | `DECISION_LOG.md` | Registro de decisiones arquitectónicas (ADRs: Groq, Serper, Baileys, SQLite) | 🟢 VERIFIED |
| **02_PROCESSES** | `INVESTIGATION_PIPELINE.md` | Flujo de ejecución del CLI: Query Formulation → Ingestion → Clustering → Reporting | 🟢 VERIFIED |
| **03_FINDINGS** | `FINDINGS_INDEX.md` | Hallazgos del análisis de mercado y comportamiento de búsqueda de IA | 🟢 VERIFIED |
| **04_AUDITS** | `AUDIT_INDEX.md` | Auditoría de seguridad (CORS, CSRF, Path Traversal) e interfaz de usuario | 🟢 VERIFIED |
| **05_TESTS** | `TEST_INDEX.md` | Registro de pruebas en vivo pequeñas y profundas (E2E) con telemetría real | 🟢 VERIFIED |
| **06_INTEGRATIONS** | `INTEGRATION_INDEX.md` | Especificación de APIs: Serper Dev, Tavily, Brave, Groq LLM, WhatsApp Daemon | 🟢 VERIFIED |
| **07_FAILURES** | `FAILURE_INDEX.md` | Registro post-mortem de fallos y bugs superados con su causa raíz y solución | 🟢 VERIFIED |
| **08_SESSIONS** | `SESSION_INDEX.md` | Bitácora cronológica de sesiones de trabajo, commits y despliegues | 🟢 VERIFIED |
| **09_KNOWLEDGE** | `KNOWLEDGE_INDEX.md` | Glosario técnico: Señal, Evidencia, Tendencia, Oportunidad, Confianza, Velocidad | 🟢 VERIFIED |

---

## 🔗 Referencias Rápidas de Archivos Clave del Código

- **Orquestador Principal:** `chismoso/src/orchestrator/`
- **Proveedor de Búsqueda Web:** `chismoso/src/providers/web-search.ts`
- **Motor CLI:** `chismoso/src/cli.ts`
- **Dashboard Next.js API:** `src/app/api/chat/route.ts` & `src/app/api/investigate/route.ts`
- **Configuración de Señales:** `src/app/api/signals-config/route.ts`
- **Componente de Ajustes UI:** `src/components/settings-view.tsx`
- **Base de Datos SQLite:** `chismoso/data/chismoso.db`
