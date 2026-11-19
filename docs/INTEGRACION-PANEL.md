# Integración CHISMOSO ↔ PANEL-DE-CONTROL ↔ INSTALADOR

**Versión:** 1.0.0 · **Estado:** contrato de integración publicado · **Audiencia:** integradores del ecosistema de agentes (PANEL-DE-CONTROL, INSTALADOR, AGENTE-LEADS, CRM-ALBRA).

Este documento define cómo un **PANEL-DE-CONTROL** (orquestador de agentes) registra a CHISMOSO como agente disponible, cómo un **INSTALADOR** (desplegador automático) lo instala en una máquina nueva, qué variables de entorno son obligatorias, qué endpoints de salud expone, y dónde vive el servidor MCP.

---

## 1. Contrato de agente

| Campo | Valor |
| :--- | :--- |
| `agentName` | `AGENTE-CHISMOSO` |
| `displayName` | CHISMOSO |
| `version` | la devuelta por `GET /api/version` (campo `version`) |
| `role` | inteligencia de señales / tendencias / problemas / oportunidades |
| `nextAgentHint` | `AGENTE-LEADS` (campo `suggestedNextAgent` en cada `Opportunity`) |
| `transport` | HTTPS REST (`/api/*`) + MCP stdio (`chismoso mcp serve`) |
| `repoLayout` | dashboard Next.js en la raíz; motor en `chismoso/` |

CHISMOSO es un agente **consumible** y **productor** dentro del mesh:
- **Consume** señales externas vía `POST /api/mesh/external-signals` (las publica otro agente, p. ej. NEX-SCOPE o RADAR-SECOP2).
- **Produce** oportunidades vía `mesh_outbox` (tabla SQLite) + webhook delivery a `AGENTE-LEADS` cuando está suscrito en `mesh_config`.

---

## 2. Registro en PANEL-DE-CONTROL

Para que PANEL-DE-CONTROL reconozca a CHISMOSO como agente disponible, debe registrar una entrada con los siguientes campos:

```json
{
  "agentName": "AGENTE-CHISMOSO",
  "baseUrl": "https://chismoso.<tenant>.example.com",
  "healthPath": "/api/health",
  "versionPath": "/api/version",
  "mcpCommand": ["node", "chismoso/dist/cli.js", "mcp", "serve"],
  "mcpTransport": "stdio",
  "mesh": {
    "eventsPollPath": "/api/mesh/events?agent=AGENTE-LEADS",
    "eventsAckPath": "/api/mesh/events/ack",
    "externalSignalsPostPath": "/api/mesh/external-signals"
  },
  "requiredEnv": [
    "CHISMOSO_DB_PATH",
    "CHISMOSO_OUTPUT_DIR",
    "SERPER_API_KEY | TAVILY_API_KEY | BRAVE_API_KEY",
    "NVIDIA_API_KEY | GROQ_API_KEY | OPENAI_API_KEY"
  ],
  "capabilities": ["investigate", "chat", "ingest", "fichas", "mcp-server"]
}
```

### Detección automática de capacidades

PANEL-DE-CONTROL puede descubrir dinámicamente las capacidades MCP de CHISMOSO sin codificarlas:

1. Lanzar el proceso MCP: `node chismoso/dist/cli.js mcp serve`
2. Tras el handshake JSON-RPC, enviar `tools/list`, `resources/list`, `prompts/list`.
3. CHISMOSO responde con las 8 tools, 6 resources y 3 prompts expuestos (ver `chismoso/src/mcp/{tools,resources,prompts}.ts`).

Esto evita que PANEL-DE-CONTROL tenga que mantener una lista hardcoded de capacidades — el servidor MCP es la fuente de verdad.

### Registro del webhook del mesh

PANEL-DE-CONTROL puede registrar a AGENTE-LEADS como suscriptor del mesh de CHISMOSO para que las oportunidades se empujen automáticamente:

```bash
curl -X POST https://chismoso.<tenant>.example.com/api/mesh/config \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CHISMOSO_JWT" \
  -d '{
    "enabled": true,
    "subscribers": [
      {
        "agentName": "AGENTE-LEADS",
        "webhookUrl": "https://leads.<tenant>.example.com/api/mesh/inbox",
        "secret": "$MESH_SHARED_SECRET",
        "eventsFilter": ["opportunity"]
      }
    ]
  }'
```

CHISMOSO validará la URL (SSRF guard: rechaza loopback, IPs privadas, cloud metadata), guardará la configuración con `chmod 0o600` y comenzará a entregar eventos pendientes al webhook suscrito.

---

## 3. Despliegue por INSTALADOR

INSTALADOR es responsable de llevar una máquina nueva desde "OS limpio" hasta "CHISMOSO sirviendo tráfico". El flujo recomendado:

### 3.1 Pre-requisitos del host

- **Node.js ≥ 20 LTS** (recomendado 20 o 22 LTS; probado hasta Node 24).
- **Python 3** (lo usa `better-sqlite3` durante `npm install` para compilar el binding nativo si no encuentra un prebuilt).
- **C++ toolchain** en Windows: Visual Studio Build Tools (Desktop development with C++ workload).
- **Docker + Docker Compose** (alternativa contenerizada — ver §3.3).

### 3.2 Instalación nativa (systemd)

```bash
# 1. Clonar el repositorio
git clone https://github.com/<org>/chismoso.git
cd chismoso

# 2. Instalar dependencias del dashboard (raíz) — npm, NO bun
npm install --no-audit --no-fund

# 3. Instalar dependencias del motor (chismoso/)
cd chismoso
npm install --no-audit --no-fund
npx tsc --noEmit          # type-check
cd ..

# 4. Copiar el template de env y rellenar claves
cp .env.example .env
# editar .env: al menos una search key + una LLM key

# 5. Construir el dashboard (Next.js standalone)
npm run build

# 6. Arrancar el servidor (systemd o manual)
NODE_ENV=production node .next/standalone/server.js
```

Los units de systemd ya viven en el repo: `systemd/chismoso.service`, `systemd/chismoso-cron.{service,timer}`, `systemd/chismoso-cleanup.{service,timer}`, `systemd/chismoso-scheduler.service`. INSTALADOR solo necesita copiarlos a `/etc/systemd/system/` y hacer `systemctl enable --now chismoso chismoso-scheduler chismoso-cron.timer chismoso-cleanup.timer`.

### 3.3 Instalación contenerizada (Docker Compose)

Para una sola máquina sin dependencias externas (Postgres, monitoring, etc.):

```bash
cp .env.example .env
# editar .env
docker compose -f docker-compose.chismoso.yml up -d --build
```

Esto levanta **solo** CHISMOSO (app + redis + caddy). Para un stack completo (scheduler, backup, monitoring), superponer:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker compose -f ops/docker-compose.monitoring.yml up -d
```

INSTALADOR debe elegir `docker-compose.chismoso.yml` por defecto — las otras capas son opt-in.

### 3.4 Verificación post-instalación

INSTALADOR debe ejecutar estos tres checks antes de marcar la instalación como exitosa:

```bash
# 1. Liveness probe (debe responder 200 con status=ok o status=degraded)
curl -sf http://127.0.0.1:3000/api/health | jq -e '.status' >/dev/null

# 2. Version metadata (debe contener version + git_commit)
curl -sf http://127.0.0.1:3000/api/version | jq -e '.version' >/dev/null

# 3. Doctor deep check (audita los 14 subsistemas)
curl -sf http://127.0.0.1:3000/api/doctor | jq -e '.overall == "ok"' >/dev/null
```

Si cualquiera falla, INSTALADOR debe rollback y reportar el error a PANEL-DE-CONTROL.

---

## 4. Variables de entorno

La lista completa y comentada vive en `.env.example`. Resumen de las obligatorias para que CHISMOSO arranque y sea útil:

| Categoría | Variable | Notas |
| :--- | :--- | :--- |
| **LLM** | `GROQ_API_KEY` **o** `NVIDIA_API_KEY` **o** `OPENAI_API_KEY` | Al menos una. Sin ella, `chat` / `investigate` / `react` fallan con `MISSING_PROVIDER_HINT`. |
| **Search** | `SERPER_API_KEY` **o** `TAVILY_API_KEY` **o** `BRAVE_API_KEY` | Al menos una para `web_search` / `reddit_communities`. |
| **Paths** | `CHISMOSO_DB_PATH` | Default `chismoso/data/chismoso.db`. Sobreescribir con ruta absoluta en Docker / systemd. |
| **Paths** | `CHISMOSO_OUTPUT_DIR` | Default `download/chismoso`. Donde se guardan los reports markdown + JSON. |
| **Auth** | `CHISMOSO_AUTH_ENABLED` | En producción (`NODE_ENV=production`) es ON por defecto. Setear `'false'` solo para emergencias. |
| **Auth** | `CHISMOSO_JWT_SECRET` | Obligatorio cuando auth está ON. Generar con `openssl rand -hex 32`. |
| **CORS** | `CHISMOSO_CORS_ORIGINS` | Lista CSV de orígenes permitidos para `fetch` del browser. Default `http://localhost:3000`. |

Opcionales:

| Variable | Para qué |
| :--- | :--- |
| `WHATSAPP_DAEMON_URL` | Mini-servicio whatsapp-daemon (proxy de mensajes). |
| `TELEGRAM_BOT_TOKEN` | Notificaciones bidireccionales vía `/api/telegram`. |
| `SENTRY_DSN` | Error tracking. |
| `AI_BASE_URL` / `AI_MODEL` | Overrides del LLM endpoint/modelo. |
| `CHISMOSO_DOMAIN` | Dominio público para el cert Let's Encrypt de Caddy. |
| `CHISMOSO_LOG_LEVEL` | `DEBUG` \| `INFO` \| `WARN` \| `ERROR`. |

INSTALADOR debe inyectar estas variables desde el secret store del tenant (Vault, AWS SSM, etc.) — NUNCA committing `.env` real al repositorio.

---

## 5. Health check URL

```
GET /api/health
```

**Respuesta (200):**

```json
{
  "status": "ok",
  "version": "1.0.0",
  "timestamp": "2026-11-13T18:30:00.000Z",
  "db": "reachable"
}
```

**Semántica:**

| `status` | Significado | Acción recomendada |
| :--- | :--- | :--- |
| `ok` | Proceso arriba + DB SQLite legible. | Tráfico normal. |
| `degraded` | Proceso arriba, DB read falló. | Las rutas de datos del dashboard 500; las rutas sin DB siguen sirviendo. Investigar el campo `db`. |
| (sin respuesta — connection refused) | El proceso está abajo. | LB / health probe debe remover la instancia del pool. |

**Notas:**
- El probe es < 1 ms (un `SELECT 1` contra SQLite singleton).
- **No cachear**: el propósito es saber si el proceso está vivo ahora mismo.
- Para un check **profundo** (14 subsistemas, providers, MCP, scheduler), usar `GET /api/doctor` — pero no como liveness probe (tarda varios segundos).

PANEL-DE-CONTROL debe usar `/api/health` como readiness probe cada 30 s y `/api/doctor` una vez por hora como deep audit.

---

## 6. MCP server endpoint

CHISMOSO expone un servidor MCP (Model Context Protocol) para que cualquier LLM client (Claude Desktop, Cursor, Continue.dev, Cline, o el propio PANEL-DE-CONTROL) pueda invocar sus capacidades sin código glue.

### 6.1 Lanzamiento (stdio)

```bash
node chismoso/dist/cli.js mcp serve
```

El servidor queda a la escucha en **stdin/stdout** usando el transporte stdio de MCP (JSON-RPC 2.0). Todos los logs de CHISMOSO van a stderr para no corromper el stream de protocolo en stdout.

### 6.2 Configuración en un cliente MCP

Para un cliente MCP genérico (Anthropic SDK, custom integrator):

```json
{
  "mcpServers": {
    "chismoso": {
      "command": "node",
      "args": ["chismoso/dist/cli.js", "mcp", "serve"],
      "cwd": "/opt/chismoso",
      "env": {
        "CHISMOSO_DB_PATH": "/var/lib/chismoso/chismoso.db",
        "GROQ_API_KEY": "${GROQ_API_KEY}",
        "SERPER_API_KEY": "${SERPER_API_KEY}"
      }
    }
  }
}
```

Ejemplos completos para Claude Desktop, Cursor, Continue.dev y un cliente TypeScript programático viven en `chismoso/docs/mcp-examples/`.

### 6.3 Capacidades expuestas

| Primitiva | Conteo | Origen |
| :--- | :--- | :--- |
| **Tools** | 8 | `chismoso/src/mcp/tools.ts` |
| **Resources** | 5 estáticos + 1 template | `chismoso/src/mcp/resources.ts` |
| **Prompts** | 3 | `chismoso/src/mcp/prompts.ts` |

Para enumerarlas en runtime: conectar al servidor MCP y enviar `tools/list`, `resources/list`, `prompts/list`. PANEL-DE-CONTROL debería hacerlo al registrar a CHISMOSO y cachear el resultado hasta que el `git_commit` cambie (ver `/api/version`).

### 6.4 Transporte HTTP (no implementado)

Solo stdio está implementado en este build. Para exponer MCP sobre HTTP, lanzar un gateway HTTP→stdio delante (ej. `supergateway`, `mcp-proxy`) o implementar `StreamableHTTPServerTransport` en `chismoso/src/mcp/server.ts`. El gateway HTTP de Caddy en el `docker-compose.chismoso.yml` solo reverse-proxya `/api/*` — no expone MCP por HTTP.

---

## 7. Diagrama de integración

```
        ┌───────────────────────┐
        │   PANEL-DE-CONTROL    │
        │  (orquestador global) │
        └──────────┬────────────┘
                   │ registra agentName=AGENTE-CHISMOSO
                   │ descubre capabilities via MCP tools/list
                   ▼
        ┌───────────────────────┐        ┌──────────────────┐
        │       CHISMOSO        │◀──────▶│   INSTALADOR     │
        │  (Next.js + motor)    │  deploy│  (systemd/docker)│
        │                       │        └──────────────────┘
        │  /api/health   (live) │
        │  /api/version  (meta) │
        │  /api/doctor   (deep) │
        │  /api/mesh/*    (bus) │
        │  mcp serve     (stdio)│
        └──────────┬────────────┘
                   │ mesh_outbox + webhook
                   ▼
        ┌───────────────────────┐
        │     AGENTE-LEADS      │
        │  (suscriptor del mesh)│
        └───────────────────────┘
```

---

## 8. Versionado y compatibilidad

- La versión del dashboard se expone en `GET /api/version` campo `version` (string SemVer).
- La versión del servidor MCP se reporta en el handshake `initialize` (campo `serverInfo.version`).
- PANEL-DE-CONTROL debe comparar `version` contra su mapa de compatibilidad antes de invocar endpoints no-estables.
- Cambios breaking en `/api/*` o en las tools MCP se documentan en `CONTEXTO CHISMOSO/01_DECISIONS/DECISION_LOG.md` con un ADR.
