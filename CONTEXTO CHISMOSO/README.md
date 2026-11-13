# CONTEXTO CHISMOSO

## Memoria Documental y Trazabilidad de Continuidad de AGENTE-CHISMOSO

**Estado del Proyecto:** 🟢 COMPLETADO & 100% OPERATIVO  
**Versión del Sistema:** v1.5.0  
**Última actualización:** 2026-11-13  
**Propósito:** Conservar la memoria técnica, arquitectura, decisiones de diseño, integraciones de IA y búsqueda, fallos resueltos, pruebas en vivo y especificación funcional de AGENTE-CHISMOSO para garantizar continuidad sin repetir investigaciones ni auditorías.

---

## 📌 ¿Qué es AGENTE-CHISMOSO?

**CHISMOSO** es un agente autónomo de inteligencia de señales (**SIGINT / OSINT**), detección temprana de tendencias y análisis de mercado. Su misión principal es rastrear la web abierta, foros y fuentes de datos en tiempo real para:
1. Detectar menciones emergentes y anomalías de volumen.
2. Agrupar señales dispersas en tendencias cuantitativamente validadas.
3. Extraer fricciones, dolores de mercado y problemas recurrentes.
4. Sintetizar oportunidades de negocio con score de impacto y nivel de confianza.
5. Servir como analista conversacional en tiempo real (Chat UI, Telegram y WhatsApp) para profundizar en cualquier hallazgo o disparar nuevas investigaciones.

---

## 🏛️ Estructura de la Memoria Documental

```text
CONTEXTO CHISMOSO/
├── README.md                           # Visión general, propósito y guía de navegación
├── INDEX.md                            # Índice maestro cruzado de todos los documentos
├── 00_MASTER/
│   ├── PROJECT_STATE.md                # Estado real verificado, hitos y capacidades activas
│   ├── ARCHITECTURE.md                 # Arquitectura de doble capa (Next.js Dashboard + Engine CLI)
│   └── AGENT_IDENTITY.md               # Prompt de sistema, personalidad y directivas operativas
├── 01_DECISIONS/
│   └── DECISION_LOG.md                 # Registro de decisiones técnicas y de arquitectura (ADR)
├── 02_PROCESSES/
│   └── INVESTIGATION_PIPELINE.md       # Pipeline paso a paso: Query → Signals → Trends → Opportunities
├── 03_FINDINGS/
│   └── FINDINGS_INDEX.md               # Hallazgos de mercado y descubrimientos operativos
├── 04_AUDITS/
│   └── AUDIT_INDEX.md                  # Auditorías de seguridad, frontend, dependencias y rendimiento
├── 05_TESTS/
│   └── TEST_INDEX.md                   # Pruebas en vivo (E2E) ejecutadas con evidencia de telemetría
├── 06_INTEGRATIONS/
│   └── INTEGRATION_INDEX.md            # Integraciones: Serper (Google), Groq LLM, Baileys WhatsApp, Telegram
├── 07_FAILURES/
│   └── FAILURE_INDEX.md                # Bitácora de fallos resueltos (CORS, CSRF, Daemon Auth, Rutas Windows)
├── 08_SESSIONS/
│   └── SESSION_INDEX.md                # Historial de sesiones de trabajo y cambios mayores
└── 09_KNOWLEDGE/
    └── KNOWLEDGE_INDEX.md              # Glosario SIGINT/OSINT, modelos de scoring y fórmulas de confianza
```

---

## 🛡️ Reglas de Fuente de Verdad y Buenas Prácticas

1. **El código compilado y las pruebas en vivo son la fuente de verdad definitiva.** Nada se documenta como `VERIFIED` sin telemetría de ejecución.
2. **Higiene de Secretos:** Nunca registrar API keys reales, Bearer tokens, cookies de sesión ni credenciales en estos documentos. Utilizar variables de entorno sanitizadas (`process.env.SERPER_API_KEY`, `<SECRET_REDACTED>`).
3. **Mantenimiento Continuo:** Cualquier modificación en el motor ReAct, en los proveedores de búsqueda o en las rutas de API debe registrarse en su respectiva sección y reflejarse en `INDEX.md`.
