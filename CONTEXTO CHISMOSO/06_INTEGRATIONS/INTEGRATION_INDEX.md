# 06_INTEGRATIONS: Matriz de Integraciones y Servicios (INTEGRATION_INDEX)

Este documento detalla los servicios externos, APIs y daemons que alimentan a AGENTE-CHISMOSO.

---

## 1. Motores de Búsqueda Web

| Proveedor | Endpoint | Autenticación | Rol en el Sistema |
| :--- | :--- | :--- | :--- |
| **Serper API** | `https://google.serper.dev/search` | Header `X-API-KEY` | **Motor Principal:** Rastreo de Google Search orgánico y noticias en tiempo real. 2.500 créditos gratis iniciales. |
| **Tavily Search** | `https://api.tavily.com/search` | Body `api_key` | **Motor Secundario:** Búsqueda optimizada para agentes de IA y síntesis contextual. |
| **Brave Search** | `https://api.search.brave.com/res/v1/web/search` | Header `X-Subscription-Token` | **Motor de Respaldo:** Índice web independiente y sin sesgos de grandes plataformas. |

---

## 2. Proveedores de Modelos de Lenguaje (LLM)

| Proveedor | Modelo Recomendado | Base URL | Rol |
| :--- | :--- | :--- | :--- |
| **Groq Cloud** | `openai/gpt-oss-120b` | `https://api.groq.com/openai/v1` | **Motor Principal de Chat & ReAct:** Inferencia ultra-rápida (~500 tokens/s) para streaming sin latencia. |
| **NVIDIA NIM** | `z-ai/glm-5.3-flash` o `meta/llama-3.1-70b-instruct` | `https://integrate.api.nvidia.com/v1` | Alternativa de alta capacidad y bajo costo para razonamiento profundo. |
| **OpenAI** | `gpt-4o-mini` | `https://api.openai.com/v1` | Proveedor estándar compatible con la especificación OpenAI. |

---

## 3. Canales y Daemons de Comunicación

| Canal | Tipo | Endpoint / Puerto | Estado / Notas |
| :--- | :--- | :--- | :--- |
| **WhatsApp (Baileys)** | Daemon Sidecar (Node.js) | `http://127.0.0.1:3002` | Autenticado mediante `INTERNAL_API_SECRET`. Permite conexión multi-dispositivo leyendo el código QR generado. |
| **Telegram Bot** | Webhook / Polling | `https://api.telegram.org/bot<TOKEN>` | Conexión directa mediante Bot Token y Chat ID configurables en el panel. |
