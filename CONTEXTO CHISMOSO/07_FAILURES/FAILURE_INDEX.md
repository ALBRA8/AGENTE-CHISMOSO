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
