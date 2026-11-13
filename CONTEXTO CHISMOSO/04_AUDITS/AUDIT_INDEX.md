# 04_AUDITS: Auditorías de Seguridad, Rendimiento y Frontend (AUDIT_INDEX)

---

### Auditoría AUD-001: Seguridad en Endpoints y Prevención de Path Traversal
- **Fecha:** 2026-11-13
- **Alcance:** Endpoints `/api/investigations/[id]`, `/api/chat`, `/api/signals-config`
- **Resultados:**
  1. `Path Traversal`: El endpoint de investigaciones utiliza validación por regex (`/^[\w-]+$/`) y `path.basename()` antes de interactuar con el sistema de archivos, asegurando que la ruta resuelta permanezca estrictamente dentro de `OUTPUT_DIR`.
  2. `Sanitización de Logs`: Se eliminó el volcado completo de `stderr` de la CLI en producción para evitar filtrar rutas internas del servidor o variables de entorno del host.
  3. `CORS & CSRF`: Se restringió el acceso CORS a orígenes controlados y orígenes de loopback locales (`localhost:3000`).

---

### Auditoría AUD-002: Rendimiento y Eficiencia de Búsqueda
- **Fecha:** 2026-11-13
- **Alcance:** `WebSearchProvider` vs Scraping Directo
- **Resultados:**
  - Scraping tradicional directo por Puppeteer/Playwright: ~10-25 segundos por consulta con alto consumo de RAM y riesgo de CAPTCHAs.
  - Serper API (JSON estructurado): **~500 ms** por llamada, cero uso de renderers pesados y entrega directa de snippets normalizados.
  - El tiempo total de una investigación completa bajó de 120s a menos de **16 segundos**.
