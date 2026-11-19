# 07_FAILURES: Registro de Fallos Resueltos (FAILURE_INDEX)

Registro post-mortem de fallos detectados durante el desarrollo y estabilización del agente, detallando síntoma, causa raíz y solución aplicada.

---

### Fallo F-001: Error HTTP 403 en Chat Conversacional (CORS Denied)
- **Síntoma:** El chat mostraba una alerta `HTTP 403` al intentar enviar cualquier mensaje desde el navegador en `http://localhost:3000`.
- **Causa Raíz:** `src/lib/cors.ts` evaluaba el encabezado `Origin: http://localhost:3000`. Como la variable `CHISMOSO_CORS_ORIGINS` no estaba definida en producción/desarrollo local, la función rechazaba cualquier origen no vacío.
- **Solución:** Se actualizó `src/lib/cors.ts` para permitir explícitamente cualquier variante de loopback local (`localhost`, `127.0.0.1`, `::1`).

---

### Fallo F-002: Error HTTP 403 por CSRF Token en `/api/chat`
- **Síntoma:** Incluso con CORS resuelto, el endpoint `/api/chat` devolvía 403 si existía alguna cookie de sesión activa en el navegador.
- **Causa Raíz:** El endpoint utilizaba el wrapper `authedPOST`, el cual exige un encabezado `X-CSRF-Token` en todas las peticiones POST. La interfaz de chat cliente hacía un `fetch` estándar sin token CSRF.
- **Solución:** Se desprendió `authedPOST` en `src/app/api/chat/route.ts` utilizando un manejador POST directo con validación de IP y rate-limiting interactivo.

---

### Fallo F-003: WhatsApp Daemon no cargaba el Código QR
- **Síntoma:** La vista de WhatsApp en el dashboard mostraba estado desconectado y el código QR no cargaba.
- **Causa Raíz:** El daemon de WhatsApp en el puerto 3002 exige autenticación con el encabezado `Authorization: Bearer <secret>`. El proxy en `/api/whatsapp/daemon-proxy` no enviaba este token en la llamada interna.
- **Solución:** Se actualizó el proxy para inyectar automáticamente el secret configurado y levantar el daemon automáticamente en caso de estar inactivo.

---

### Fallo F-004: Error 404 al Listar y Cargar Investigaciones en Windows
- **Síntoma:** Al listar investigaciones o abrir un reporte específico se producía un error `HTTP 404: Investigation not found`.
- **Causa Raíz:** Los archivos `src/app/api/investigations/route.ts` y `[id]/route.ts` tenían rutas fijas codificadas para Linux (`/home/z/my-project/download/chismoso`), inexistentes en Windows.
- **Solución:** Se reemplazaron las rutas fijas por `path.resolve(process.cwd(), 'download', 'chismoso')`.

---

### Fallo F-005: Turbopack Build Error por Etiquetas JSX Duplicadas
- **Síntoma:** El servidor Next.js fallaba en compilación con el mensaje: `An object member cannot be declared optional (659:19)`.
- **Causa Raíz:** Una edición anterior en `src/components/settings-view.tsx` dejó una etiqueta de botón huérfana en la sección de botones de guardado.
- **Solución:** Se limpiaron las líneas duplicadas y Turbopack reanudó la compilación con 0 errores.

---

### FASE-1-SEC (2026-11): Cierre definitivo de F-002 + rutas sin auth

**Estado:** ✅ RESUELTO en Task `FASE-1-SEC`.

**Contexto:** La "solución" original de F-002 (desprender `authedPOST` en `/api/chat`) dejó el endpoint sin protección alguna. La auditoría FASE-1-SEC detectó cinco rutas en la misma condición:

- `src/app/api/chat/route.ts` — POST (chat con LLM)
- `src/app/api/provider-settings/route.ts` — GET + PUT (config LLM con API keys)
- `src/app/api/signals-config/route.ts` — GET + PUT (API keys de motores de búsqueda)
- `src/app/api/telegram/route.ts` — GET + PUT + POST (bot token de Telegram)
- `src/app/api/whatsapp/daemon-proxy/route.ts` — GET + POST (proxy al daemon)

Adicionalmente, los GET de `provider-settings` y `signals-config` devolvían las **API keys completas** en claro al cliente, y `getAuthConfig()` trataba cualquier valor no-`'true'` de `CHISMOSO_AUTH_ENABLED` como "off" — incluyendo la cadena vacía y typos, desactivando auth silenciosamente en producción.

**Solución aplicada:**

1. **Rutas protegidas:** `provider-settings`, `signals-config`, `telegram`, `whatsapp/daemon-proxy` ahora usan `authedRoute` (siempre exige credenciales cuando auth está activo). `chat` usa `optionalAuth` + un gate inline: en dev (auth desactivado por defecto) el dashboard sigue funcionando con un `fetch` plano; en producción (auth activo por defecto) las llamadas anónimas reciben 401 y las sessiones sin CSRF reciben 403. Esto cierra F-002 **sin** resucitar el problema original del dashboard local.
2. **Mascaramiento de secretos:** los GET ahora retornan `api_key_set: boolean` + `api_key_hint: "••••1234"` (últimos 4 chars) en lugar de la key completa. `signals-config` aplica el mismo patrón para `tavily_*`, `serper_*`, `brave_*`. La UI (`settings-view.tsx`) ya soporta este formato vía fallback a `localStorage`.
3. **Preservación de keys en PUT:** si un campo de key llega como `""`, se mantiene el valor previamente guardado — el dashboard puede salvar otros campos sin clobbering la key que no puede ver.
4. **Fail-closed en producción:** `getAuthConfig()` ahora trata `NODE_ENV=production` como auth-ON por defecto; solo un `'false'` explícito la desactiva (para pruebas de emergencia). Cadenas vacías, typos y valores numéricos ya NO desactivan auth en producción.
5. **Validación de `base_url` (SSRF):** se rechaza `http://` y URLs que apunten a IPs privadas / loopback / link-local (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x, IPv6 ULA / link-local).
6. **Duro en disco:** `.provider-settings.json`, `.signals-settings.json`, `.telegram-settings.json` y `.env` se escriben con `chmod 0o600`. Los valores escritos a `.env` se envuelven en comillas dobles y se escapan backslashes, comillas y newlines para prevenir inyección de entradas env adicionales.
7. **`docker-compose.yml`:** el puerto `3000` ahora se publica como `127.0.0.1:3000:3000` (loopback only). Caddy sigue siendo el único borde público en 80/443. `compose.albra.yaml` ya usaba `expose:` (no `ports:`) + `HOSTNAME=0.0.0.0`, así que no requería cambios.
8. **Path hardcodeado en WhatsApp daemon-proxy:** se reemplazó la ruta Windows `D:/PROYECTOS/AGENTES CON IA/...` por resolución relativa a `process.cwd()` (`./mini-services/whatsapp-daemon/index.{ts,js}` o `./src/server/whatsapp-daemon.js`) — el bootstrap auto-detecta el daemon en cualquier SO.

**Verificación:** `tests/security.test.ts` cubre 27 casos: rutas protegidas devuelven 401 sin credenciales, GET nunca expone keys completas, PUT con key vacía preserva la existente, validación SSRF de `base_url`, y la matriz completa de modos de `getAuthConfig()` en dev vs producción. `bun run lint` pasa sin errores.
