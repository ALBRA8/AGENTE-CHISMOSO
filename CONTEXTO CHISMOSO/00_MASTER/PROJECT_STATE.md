# 00_MASTER: Estado del Proyecto (PROJECT_STATE)

**Fecha:** 2026-11-13  
**Estado:** 🟢 COMPLETADO & 100% OPERATIVO  
**Versión:** 1.5.0  

---

## 1. Resumen Ejecutivo
AGENTE-CHISMOSO es una plataforma autónoma completa para el análisis y detección temprana de oportunidades de negocio e inteligencia de señales (SIGINT/OSINT). Se compone de dos capas principales:
1. **Frontend / Dashboard Web:** Aplicación Next.js 16 (App Router + Turbopack + TailwindCSS) con panel interactivo, visualización de investigaciones, ajustes unificados y chat en tiempo real con SSE.
2. **Motor Analítico (CLI / Orquestador Core):** Paquete Node.js/TypeScript en `chismoso/` con orquestación ReAct, integración con Serper/Google Search, clustering de tendencias en SQLite y generador de reportes estructurados (Markdown + JSON).

---

## 2. Inventario de Capacidades Activas

| Módulo / Capacidad | Estado | Evidencia de Verificación |
| :--- | :--- | :--- |
| **Búsqueda Web en Vivo** | 🟢 OPERATIVO | Conexión con Serper API probada. Extracción de 10 y 30 señales reales en vivo. Fallback a Tavily y Brave implementado. |
| **Chat Conversacional ReAct** | 🟢 OPERATIVO | Streaming token por token vía SSE. Invocación autónoma de herramientas (`list_investigations`, `load_investigation`). |
| **Investigaciones Automatizadas** | 🟢 OPERATIVO | Ejecución vía `/api/investigate`. Genera reportes en disco y registros en SQLite. Tiempos de 8s (prueba corta) y 15s (prueba profunda). |
| **Interfaz de Configuración** | 🟢 OPERATIVO | Pestañas unificadas idénticas a AGENTE GENERAL (`Identidad`, `Proveedor IA`, `Búsqueda Web`, `Telegram`, `WhatsApp`). Toggles `👁️ Ver` / `🙈 Ocultar` en todas las claves. |
| **Persistencia de Ajustes** | 🟢 OPERATIVO | Persistencia atómica en `.signals-settings.json`, `.provider-settings.json`, `.env` y sincronización con `localStorage`. |
| **WhatsApp Daemon** | 🟢 OPERATIVO | Daemon Baileys autenticado por proxy en puerto 3002. Generación y renderizado de código QR en base64 listo para vinculación. |
| **Seguridad de Red** | 🟢 OPERATIVO | CORS configurado para permitir `localhost`. Rutas de investigaciones protegidas contra Path Traversal mediante resolución canónica. |

---

## 3. Puertos y Servicios en Ejecución

* **Puerto 3000:** Next.js Dev Server / API Gateway (`http://localhost:3000`)
* **Puerto 3002:** WhatsApp Daemon Baileys Sidecar (`http://127.0.0.1:3002`)
* **Base de datos local:** SQLite en `chismoso/data/chismoso.db`
* **Directorio de reportes generados:** `download/chismoso/`
