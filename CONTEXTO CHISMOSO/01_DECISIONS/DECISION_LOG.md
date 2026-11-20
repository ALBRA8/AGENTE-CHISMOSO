# 01_DECISIONS: Registro de Decisiones de Arquitectura (DECISION_LOG)

**Formato:** ADR (Architectural Decision Record)  

---

### ADR-001: Integración de Serper API como Motor Primario de Búsqueda Web
- **Estado:** Aceptado e Implementado
- **Contexto:** La SDK previa (`ZAI`) dependía de credenciales externas complejas o fallaba en llamadas web. Además, parsear HTML directo de Google es lento y vulnerable a bloqueos.
- **Decisión:** Implementar Serper API (`https://google.serper.dev/search`) como proveedor primario en `chismoso/src/providers/web-search.ts`. Serper devuelve resultados orgánicos en JSON estructurado, con 2.500 consultas gratuitas sin tarjeta y tiempos de respuesta de ~500ms.
- **Consecuencias:** Búsqueda en vivo ultra-rápida, reducción de tokens y alta resiliencia con fallback a Tavily y Brave.

---

### ADR-002: Separación de Configuración y Claves Sensibles (Git hygiene)
- **Estado:** Aceptado e Implementado
- **Contexto:** Las API keys del usuario (Serper, Groq, Tavily, Telegram) se almacenaban en archivos locales que podían comprometerse en Git.
- **Decisión:** Mantener `.signals-settings.json` y `.provider-settings.json` como archivos locales ignorados explícitamente en `.gitignore`. Sincronizar estos ajustes con `.env` y el `localStorage` del cliente.
- **Consecuencias:** Cero fugas de credenciales en repositorios públicos/privados de GitHub.

---

### ADR-003: Permisos de Red Local (CORS y CSRF en Dashboard)
- **Estado:** Aceptado e Implementado
- **Contexto:** El middleware de Next.js bloqueaba peticiones desde Chrome (`localhost:3000`) con error `HTTP 403: CORS denied`, y el wrapper `authedPOST` bloqueaba las llamadas del chat con error CSRF.
- **Decisión:** 
  1. Actualizar `src/lib/cors.ts` para permitir automáticamente orígenes locales (`localhost`, `127.0.0.1`, `::1`).
  2. Simplificar el endpoint `/api/chat/route.ts` eliminando el middleware de CSRF que esperaba tokens inexistentes en la UI de cliente.
- **Consecuencias:** Chat fluido sin errores 403 ni dependencias de cookies para uso local.

---

### ADR-004: Corrección de Rutas Canónicas para Entornos Multiplataforma (Windows)
- **Estado:** Aceptado e Implementado
- **Contexto:** Las rutas `/api/investigations` tenían rutas absolutas hardcodeadas a `/home/z/my-project/...`, lo que causaba `HTTP 404: Not Found` al listar o ver reportes en Windows.
- **Decisión:** Cambiar todas las rutas a resolución relativa mediante `process.cwd()` y `process.env.CHISMOSO_OUTPUT_DIR`.
- **Consecuencias:** Compatibilidad nativa en Windows y Linux sin tocar código.
