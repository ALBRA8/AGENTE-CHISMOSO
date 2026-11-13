# 05_TESTS: Registro de Pruebas en Vivo (TEST_INDEX)

Este documento contiene la telemetría, parámetros y resultados de las pruebas integrales ejecutadas sobre el sistema.

---

### Prueba TST-001: Verificación Corta de Extracción y Señales
- **Fecha y Hora:** 2026-11-13 01:28 (COT)
- **Objetivo:** *"Startups de inteligencia artificial emergentes en Colombia"*
- **Parámetros:** `maxQueries: 2`, `maxRuntimeMs: 30000`, `geography: Colombia`
- **Resultados:**
  - **HTTP Status:** 200 OK
  - **Tiempo de Ejecución:** **8.44 segundos**
  - **ID de Investigación:** `inv_mweli6yj1fw73d`
  - **Señales recolectadas:** 10 señales
  - **Tendencias identificadas:** 1
  - **Nivel de confianza global:** 55.0%
  - **Evidencia guardada:** Reportes `.md` y `.json` en `download/chismoso/` y registro en SQLite.

---

### Prueba TST-002: Prueba Profunda a Gran Escala (Deep Research)
- **Fecha y Hora:** 2026-11-13 01:57 (COT)
- **Objetivo:** *"Tendencias emergentes de agentes de IA, automatización de procesos y oportunidades de negocio B2B en Colombia"*
- **Parámetros:** `maxQueries: 6`, `maxRuntimeMs: 90000`, `geography: Colombia`
- **Resultados:**
  - **HTTP Status:** 200 OK
  - **Tiempo de Ejecución:** **15.60 segundos**
  - **ID de Investigación:** `inv_mwemjxpt6efx7a`
  - **Estado:** `COMPLETED`
  - **Señales recolectadas:** 30 señales reales
  - **Tendencias identificadas:** 1 (Score: 71)
  - **Fricciones detectadas:** 1 (Severidad: 60, Frecuencia: 100)
  - **Oportunidades generadas:** 1 (Score: 56, Confianza: 0.69)
  - **Nivel de confianza global:** **71.0%**
  - **Acción recomendada:** Derivar a `AGENTE-LEADS` para prospección comercial.

---

### Prueba TST-003: Validación ReAct del Chat Conversacional
- **Fecha y Hora:** 2026-11-13 01:58 (COT)
- **Mensaje de Usuario:** *"¿Qué descubriste sobre la investigación de agentes de IA y automatización de procesos B2B en Colombia?"*
- **Comportamiento Autónomo:**
  1. El LLM emitió un `tool_call` a `list_investigations` en 208 ms.
  2. Localizó la investigación `inv_mwemjxpt6efx7a`.
  3. Sintetizó las 30 señales, la oportunidad B2B y las fuentes.
  4. Transmitió la respuesta vía SSE token por token en **2.2 segundos**.
  5. Cero bloqueos de CORS o CSRF.
