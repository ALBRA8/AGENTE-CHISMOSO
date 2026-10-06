# CHISMOSO V1.3 — Model Context Protocol (MCP)

> Documentación de integración MCP — el estándar abierto de Anthropic para que
> los LLMs se comuniquen con sistemas externos.
>
> **Versión**: 1.3.0 · **Estado**: implementado (MCP-1 + MCP-2) · **Idioma**: español técnico.
>
> **Audiencia**:
> - Usuarios que quieran integrar CHISMOSO con Claude Desktop, Cursor, Continue.dev, Cline o cualquier cliente MCP.
> - Ingenieros que quieran consumir servidores MCP externos (GitHub, Filesystem, Slack, etc.) desde CHISMOSO.
> - Integradores custom que necesiten un cliente MCP programático en TypeScript.

---

## ÍNDICE

1. [¿Qué es MCP?](#1-qué-es-mcp)
2. [Arquitectura MCP en CHISMOSO](#2-arquitectura-mcp-en-chismoso)
3. [CHISMOSO como MCP Server](#3-chismoso-como-mcp-server)
4. [CHISMOSO como MCP Client](#4-chismoso-como-mcp-client)
5. [Configuración con Claude Desktop](#5-configuración-con-claude-desktop)
6. [Configuración con Cursor](#6-configuración-con-cursor)
7. [Configuración con Continue.dev](#7-configuración-con-continue-dev)
8. [Ejemplos de uso en Claude Desktop](#8-ejemplos-de-uso-en-claude-desktop)
9. [CHISMOSO consumiendo otros MCP servers](#9-chismoso-consumiendo-otros-mcp-servers)
10. [Cliente custom](#10-cliente-custom)
11. [Seguridad](#11-seguridad)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. ¿Qué es MCP?

**MCP (Model Context Protocol)** es un estándar abierto creado por Anthropic que
define cómo los LLMs (Claude, GPT, modelos locales, etc.) se comunican con
sistemas externos —archivos, bases de datos, APIs, herramientas internas— de
manera uniforme y descubrible.

El protocolo se basa en tres pilares técnicos:

- **JSON-RPC 2.0** como formato de mensajes (request/response con `id`,
  notificaciones sin `id`, errores con `code` + `message`).
- **Transportes**:
  - **stdio** — CHISMOSO se arranca como subproceso del cliente MCP (Claude
    Desktop, Cursor, Continue.dev, Cline). Es el transporte que usan todos los
    ejemplos de esta doc.
  - **HTTP/SSE** — servidor remoto accesible por URL. Útil para despliegues
    multi-tenant o cuando el cliente y el servidor viven en máquinas distintas.
- **Tres primitivas**:
  1. **Tools** — funciones que el LLM puede invocar (con `inputSchema` JSON
     Schema). El equivalente a function calling.
  2. **Resources** — datos de solo lectura direccionables por URI
     (`chismoso://investigations/latest`). El cliente puede adjuntarlos al
     contexto de la conversación.
  3. **Prompts** — plantillas reutilizables que el cliente puede exponer como
     "slash commands" (`/investigate_topic`, `/compare_topics`, etc.).

### Compatibilidad

MCP es soportado nativamente por:

| Cliente              | Soporte MCP | Notas                                                |
|----------------------|-------------|------------------------------------------------------|
| **Claude Desktop**   | ✅ stdio     | Configuración en `claude_desktop_config.json`       |
| **Cursor**           | ✅ stdio     | `.cursor/mcp.json` a nivel workspace o global       |
| **Continue.dev**     | ✅ stdio     | `~/.continue/config.json`                            |
| **Cline**            | ✅ stdio     | Antes conocido como Claude Dev (VSCode extension)   |
| **Cualquier SDK**    | ✅           | `@modelcontextprotocol/sdk` (TS), `mcp` (Python)  |

### ¿Por qué CHISMOSO soporta MCP?

CHISMOSO V1.0 se integraba al ecosistema (AGENTE-LEADS, CRM-ALBRA, etc.) por un
contrato **contractual pero no IPC**: producía `Opportunity` objects con
`suggestedNextAgent: "AGENTE-LEADS"` y esperaba que un consumidor (script, agente,
integración) tomara el relevo.

V1.2 añadió un **mesh HTTP** propio: cada agente exponía endpoints REST y publicaba
eventos a un bus. El mesh funciona, pero cada integración es ad-hoc —no hay
estándar sobre cómo descubrir capabilities, listar tools, o render prompts.

**V1.3 adopta MCP** por tres razones concretas:

1. **Interoperabilidad nativa con LLMs comerciales**. Claude Desktop puede llamar
   a CHISMOSO sin código glue —solo una entrada en `claude_desktop_config.json`.
2. **Descubrimiento estándar**. `tools/list`, `resources/list`, `prompts/list`
   eliminan la necesidad de documentar cada integration por separado.
3. **Bidireccionalidad**. CHISMOSO no solo expone sus capacidades —también
   consume servidores MCP externos (GitHub, Filesystem, Slack) y los registra
   como tools nativos en su ReAct orchestrator.

---

## 2. Arquitectura MCP en CHISMOSO

CHISMOSO V1.3 participa en MCP en **ambas direcciones**:

```
                          ┌─────────────────────────────────────────┐
                          │           Clientes MCP                  │
                          │  (Claude Desktop, Cursor, Continue.dev)  │
                          └────────────────┬────────────────────────┘
                                           │ JSON-RPC 2.0 over stdio
                                           │ (subprocess)
                          ┌────────────────▼────────────────────────┐
                          │     CHISMOSO como MCP SERVER (MCP-1)    │
                          │  8 tools · 6 resources · 3 prompts      │
                          │  src/mcp/{server,tools,resources,       │
                          │            prompts}.ts                 │
                          └────────┬───────────────────────┬────────┘
                                   │                       │
                                   │ usa                   │ registra
                                   │                       │ tools externos
                                   ▼                       ▼
                       ┌─────────────────────┐  ┌──────────────────────┐
                       │  Stack CHISMOSO     │  │  CHISMOSO como       │
                       │  (DB, Orchestrator, │  │  MCP CLIENT (MCP-2)  │
                       │   Providers,        │  │  src/mcp/client.ts    │
                       │   AnomalyDetector,  │  │  src/mesh/mcp-config  │
                       │   semanticSearch)   │  │  src/mcp/registry.ts  │
                       └─────────────────────┘  │  src/mcp/bridge.ts    │
                                                └──────────┬─────────────┘
                                                           │ spawn / HTTP
                                          ┌────────────────┼────────────────┐
                                          ▼                ▼                ▼
                                  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
                                  │  GitHub MCP  │  │ Filesystem   │  │ Slack MCP    │
                                  │  server      │  │ MCP server   │  │ server       │
                                  │  (npx -y     │  │ (npx -y     │  │ (npx -y     │
                                  │  @mcp/srv-gh)│  │ @mcp/srv-fs)│  │ @mcp/srv-sl) │
                                  └──────────────┘  └──────────────┘  └──────────────┘
```

### Roles

| Rol              | Implementación                                | Cuándo se activa                                                  |
|------------------|-----------------------------------------------|-------------------------------------------------------------------|
| **MCP Server**   | `chismoso mcp serve` (stdio)                  | Cuando un cliente MCP (Claude Desktop, etc.) spawn CHISMOSO       |
| **MCP Client**   | `autoConnectMCP(toolRegistry)` implícito      | Al ejecutar `investigate` / `investigate-react` / `watch`         |
| **MCP Client**   | `chismoso mcp <list-servers\|add\|connect…>` | Operador explícito gestionando servidores externos                 |

### Capa sobre el mesh V1.2

El **mesh HTTP** de V1.2 (AgentMesh, mesh events, mesh external-signals) sigue
funcionando —es el mecanismo de mensajería asíncrona entre agentes del
ecosistema. MCP no lo reemplaza:

- **Mesh V1.2** = publicar/suscribir eventos entre agentes CHISMOSO + vecinos
  (AGENTE-LEADS, CRM-ALBRA). Optimizado para hand-off asíncrono de
  `Opportunity` objects.
- **MCP V1.3** = LLM ↔ tools síncronos. Un LLM (Claude, GPT, modelo local)
  invoca tools y lee resources. Optimizado para **orquestación por el LLM** en
  tiempo de conversación.

Ambas capas coexisten: una `Opportunity` detectada por el orchestrator puede
ser publicada al mesh (V1.2) **y** expuesta como resource `chismoso://opportunities/top`
(V1.3) para que un cliente MCP la consuma síncronamente.

---

## 3. CHISMOSO como MCP Server

### Comando

```bash
# Default — stdio (lo que usan Claude Desktop / Cursor / Continue.dev / Cline)
chismoso mcp serve

# Explícito (idéntico al anterior)
chismoso mcp serve --transport=stdio

# Verbose: imprime tools/resources/prompts registrados a stderr antes de servir
chismoso mcp serve --inspect
```

- Transporte **stdio** es el único cableado en V1.3. STDOUT está reservado para
  mensajes JSON-RPC — cualquier `console.log`/`logger.info` se redirige a STDERR
  vía `redirectConsoleToStderr()` (ver `src/mcp/server.ts`).
- El flag `--inspect` es útil para depurar: vuelca el catálogo completo de
  tools/resources/prompts a stderr antes de entrar en el loop JSON-RPC.
- **HTTP/SSE**: **no implementado en V1.3**. Es un TODO explícito (track:
  *MCP-4 — HTTP transport server*). Mientras tanto, si necesitas acceso remoto,
  ejecuta CHISMOSO en stdio detrás de un proxy (Caddy, nginx) que hable
  JSON-RPC sobre WebSocket → stdio.

### Identidad del servidor

```
name:    chismoso-mcp-server
version: 1.3.0
capabilities:
  tools:     { listChanged: false }
  resources: { subscribe: false, listChanged: false }
  prompts:   { listChanged: false }
instructions: "CHISMOSO MCP server — exposes intelligence capabilities
               (investigate, semantic search, anomalies, opportunities, etc.)
               to LLM clients. All tools return JSON. chismoso_investigate is
               the only non-idempotent tool — it creates new investigation
               records."
```

### 3.1 Tools (8)

Cada tool es un descriptor `{ name, description, inputSchema, execute }`. La
entrada es JSON Schema draft-07; la salida es un objeto JSON serializado como
`text` content block. Los errores de ejecución se retornan con `isError: true`
—**no se lanzan**— para que el LLM pueda verlos y reaccionar.

#### `chismoso_investigate`

Lanza una investigación completa de CHISMOSO para el objetivo dado. Ejecuta el
pipeline entero: PLAN (LLM) → COLLECT (web/community providers reales) →
NORMALIZE/DEDUP/CLUSTER → TREND DETECTION → PROBLEM DETECTION → CROSS-SOURCE →
OPPORTUNITY ENGINE → SCORING → REPORT. Persiste el resultado en SQLite y
devuelve tendencias, problemas y oportunidades como JSON. Puede tardar 30s–5min
según el presupuesto. **No idempotente** — cada llamada crea registros nuevos.

| Parámetro      | Tipo    | Requerido | Default     | Descripción                                                  |
|----------------|---------|-----------|-------------|--------------------------------------------------------------|
| `objective`    | string  | ✅ sí     | —           | Pregunta de investigación, p.ej. "oportunidades de automatización para restaurantes en Colombia" |
| `geography`   | string  | ❌ no     | `"global"`  | Ámbito geográfico (`"Colombia"`, `"ES"`, `"US-CA"`)         |
| `maxQueries`   | integer | ❌ no     | `12`        | Máximo de queries a providers (1–50)                        |
| `maxRuntimeMs` | integer | ❌ no     | `300000`    | Runtime máximo en ms (5_000–600_000)                        |

#### `chismoso_semantic_search`

Búsqueda semántica TF-IDF + cosine similarity sobre todas las señales
almacenadas. Devuelve los top-K signals cuyo `raw_snippet` mejor matchea la
query. Read-only — seguro de llamar cualquier número de veces.

| Parámetro | Tipo    | Requerido | Default | Descripción                              |
|-----------|---------|-----------|---------|------------------------------------------|
| `query`   | string  | ✅ sí     | —       | Texto libre (EN o ES)                   |
| `topK`    | integer | ❌ no     | `10`    | Máximo de resultados (1–50)             |

#### `chismoso_list_investigations`

Lista investigaciones pasadas, newest first. Cada entrada incluye id, query,
scope, status, conteos de signals/trends/opportunities, duración e iteraciones.

| Parámetro | Tipo    | Requerido | Default | Descripción                |
|-----------|---------|-----------|---------|----------------------------|
| `limit`   | integer | ❌ no     | `20`    | Máximo de resultados (1–200) |

#### `chismoso_get_investigation`

Recupera el reporte completo por ID: tendencias, problemas, oportunidades,
conteos de señales/evidencia, providers usados, errores. Útil con IDs de
`chismoso_list_investigations` o del resource `chismoso://investigations/latest`.

| Parámetro | Tipo    | Requerido | Default | Descripción                              |
|-----------|---------|-----------|---------|------------------------------------------|
| `id`      | string  | ✅ sí     | —       | ID de investigación (`inv_abc123def456`) |

#### `chismoso_list_anomalies`

Lista anomalías estadísticas activas detectadas sobre el historial de
`topic_observations`: volume spikes/drops, velocity changes, source
diversification, confidence drift. Filtrable por topic.

| Parámetro | Tipo   | Requerido | Default | Descripción                              |
|-----------|--------|-----------|---------|------------------------------------------|
| `topic`   | string | ❌ no     | —       | Filtrar a un único topic (default: todos) |

#### `chismoso_list_topics`

Lista topics distintos observados por CHISMOSO (unión de `topic_observations`
y `trends`). Útil para descubrir qué ha estado rastreando CHISMOSO.

Sin parámetros.

#### `chismoso_get_topic_history`

Evolución temporal de un único topic — las filas de `topic_observations` que
consume el AnomalyDetector. Devuelve `observedAt`, `sourcesCount`, `signalsCount`,
`confidence` por observación (newest first por defecto).

| Parámetro | Tipo    | Requerido | Default | Descripción                                  |
|-----------|---------|-----------|---------|----------------------------------------------|
| `topic`   | string  | ✅ sí     | —       | Topic exacto (`"restaurant automation"`)    |
| `limit`   | integer | ❌ no     | `20`    | Máximo de observaciones (1–200)              |

#### `chismoso_list_providers`

Lista todos los providers registrados y su health actual. Incluye capabilities,
source types, rate limits, authentication. Útil para verificar cuáles son REAL
vs UNAVAILABLE antes de lanzar una investigación.

Sin parámetros.

### 3.2 Resources (6)

Resources son datos **read-only** direccionables por URI. Aparecen en el panel
"context" / "attachments" del cliente MCP. Cinco resources estáticos + un
resource template.

| URI                                       | Nombre                 | Descripción                                                                       |
|-------------------------------------------|------------------------|-----------------------------------------------------------------------------------|
| `chismoso://investigations/latest`        | Latest Investigation   | La investigación más reciente, con conteos resumen.                                |
| `chismoso://investigations/{id}` *(template)* | Investigation by ID | Detalle completo (trends, problems, opportunities, signals, evidence).            |
| `chismoso://topics`                       | Observed Topics        | Topics distintos trackeados por CHISMOSO (unión de `topic_observations` y `trends`).|
| `chismoso://anomalies/active`             | Active Anomalies       | Todas las anomalías detectadas actualmente en cada topic.                          |
| `chismoso://providers`                    | Providers + Health     | Todos los providers con capabilities y health actual.                              |
| `chismoso://opportunities/top`            | Top Opportunities      | Top 20 oportunidades por score en todas las investigaciones.                     |

- Todos los resources se sirven como `application/json`.
- `chismoso://investigations/{id}` es **URI template (RFC 6570)** — el cliente
  lo descubre vía `resources/templates/list` y lo resuelve sustituyendo `{id}`.
  `latest` es un alias aceptado: `chismoso://investigations/latest` equivale a
  pedir la investigación más reciente.
- URIs desconocidos devuelven error JSON-RPC explícito (sin fallback silencioso).

### 3.3 Prompts (3)

Prompts son plantillas renderizadas server-side que el cliente puede exponer
como "slash commands" (`/investigate_topic`, etc.). Devuelven uno o más
mensajes (típicamente un único `user` message) que el LLM procesa.

#### `investigate_topic`

Lanza una investigación CHISMOSO sobre un topic. El prompt renderizado pide al
LLM que llame a `chismoso_investigate` y resuma las tendencias, problemas y
oportunidades resultantes en lenguaje natural.

| Argumento    | Requerido | Descripción                                                          |
|--------------|-----------|----------------------------------------------------------------------|
| `topic`      | ✅ sí     | Pregunta o topic de investigación (`"restaurant automation in Colombia"`) |
| `geography`  | ❌ no     | Ámbito geográfico (default: `"global"`)                              |

#### `compare_topics`

Compara dos topics side-by-side usando su historial de observaciones en
CHISMOSO. El LLM debe llamar a `chismoso_get_topic_history` y
`chismoso_list_anomalies` para ambos topics y producir una tabla comparativa
(conteo de observaciones, signals, confidence, anomalías, velocity trend).

| Argumento | Requerido | Descripción                                       |
|-----------|-----------|---------------------------------------------------|
| `topicA`  | ✅ sí     | Primer topic a comparar (string canónico exacto) |
| `topicB`  | ✅ sí     | Segundo topic a comparar                          |

#### `deep_dive_opportunity`

Deep-dive en una oportunidad específica de una investigación. El LLM debe
obtener la investigación, elegir la N-ésima oportunidad y producir un análisis
estructurado: validation steps, competidores, ICP, monetización, GTM plan.

| Argumento           | Requerido | Descripción                                                                |
|---------------------|-----------|----------------------------------------------------------------------------|
| `investigationId`   | ✅ sí     | ID (`inv_abc123`). Acepta `"latest"` para apuntar a la más reciente.       |
| `opportunityIndex`  | ❌ no     | Índice 0-based en la lista (ordenada por score DESC). Default: `0`.        |

---

## 4. CHISMOSO como MCP Client

CHISMOSO también actúa como **cliente MCP**: descubre, conecta y consume
servidores MCP externos. Los tools que exponen esos servidores se registran
como tools nativos en el ToolRegistry del orchestrator, junto a los 4 tools
built-in (`search_web`, `search_community`, `collect_trends`, `deepen_content`).

### 4.1 Config file

| Setting               | Valor                                                            |
|-----------------------|------------------------------------------------------------------|
| **Path por defecto**  | `/home/z/my-project/chismoso/data/mcp-servers.json`              |
| **Override**          | env var `CHISMOSO_MCP_CONFIG=/path/to/your-config.json`          |
| **Si no existe**      | `loadMCPConfig()` retorna `{ servers: {} }` (vacío)             |
| **Creación inicial** | `chismoso mcp list-servers` materializa el template en disco    |

### 4.2 Schema

```jsonc
{
  "servers": {
    "<name>": {
      "command":   "npx",                              // stdio: comando a spawnear
      "args":      ["-y", "@modelcontextprotocol/server-github"],
      "env":       { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxx" },  // opcional
      "transport": "stdio",                            // "stdio" | "http"
      "url":       "https://mcp.example.com/sse",      // requerido si transport=http
      "enabled":   true                                // false → skipped en auto-connect
    }
  }
}
```

- `transport: "stdio"` → subproceso local (lo más común). Requiere `command`.
- `transport: "http"` → endpoint remoto. Requiere `url`. Si la URL contiene
  `/sse` se usa `SSEClientTransport` (legacy), en caso contrario
  `StreamableHTTPClientTransport` (spec MCP actual).
- `env` se mergea con `process.env` al spawnear el subproceso.

### 4.3 CLI commands

Todas las operaciones de gestión de servers externos viven bajo `chismoso mcp`:

```bash
# Listar servers configurados + estado (connected | enabled | disabled)
chismoso mcp list-servers

# Añadir un nuevo server (persiste en data/mcp-servers.json)
chismoso mcp add <name> \
  --command=npx \
  --args=-y,@modelcontextprotocol/server-github \
  --env=GITHUB_PERSONAL_ACCESS_TOKEN:ghp_xxx \
  --transport=stdio \
  --enabled

# Eliminar un server de la config
chismoso mcp remove <name>

# Conectar ahora a un server (verifica handshake + lista tools expuestos)
chismoso mcp connect <name>

# Desconectar y marcar disabled
chismoso mcp disconnect <name>

# Listar tools de todos los servers conectados (formato dotted: <server>.<tool>)
chismoso mcp tools

# Invocar un tool remoto (args como JSON)
chismoso mcp call <server.tool> '<json-args>'
# Ejemplo:
chismoso mcp call github.search_repositories '{"query":"next.js"}'
```

### 4.4 Auto-connect en investigate / watch

Cuando se ejecutan `investigate`, `investigate-react` o `watch`, CHISMOSO
**conecta automáticamente** todos los servers con `enabled: true` antes de
empezar el ReAct loop. Los tools remotos se registran en el ToolRegistry como
`<server>_<tool>` (con dots reemplazados por underscores para ser CLI-safe) y
están disponibles para que el LLM los invoque como cualquier tool built-in.

Para **saltar el auto-connect** (útil para reproducir el demo canónico sin
dependencias externas):

```bash
chismoso investigate "restaurant automation in Colombia" --no-mcp
```

### 4.5 Verificación end-to-end

MCP-2 verificó el client completo contra el servidor MCP real
`@modelcontextprotocol/server-filesystem`:

```
$ chismoso mcp add test-fs --command=npx \
    --args=-y,@modelcontextprotocol/server-filesystem,/tmp \
    --transport=stdio --enabled

$ chismoso mcp connect test-fs
[connected] test-fs · 14 tools · 0 resources

$ chismoso mcp tools
test-fs.read_file           Read the complete contents of a file from...
test-fs.write_file          Create a new file or completely overwrite...
test-fs.list_directory      Get a detailed listing of all files...
... (14 en total)

$ chismoso mcp call test-fs.list_allowed_directories '{}'
Allowed directories:
/tmp
```

---

## 5. Configuración con Claude Desktop

Claude Desktop lee su configuración de `claude_desktop_config.json`:

| OS       | Ruta                                                                         |
|----------|------------------------------------------------------------------------------|
| **macOS** | `~/Library/Application Support/Claude/claude_desktop_config.json`           |
| **Windows** | `%APPDATA%\Claude\claude_desktop_config.json`                              |
| **Linux** | `~/.config/Claude/claude_desktop_config.json`                                |

Añade CHISMOSO bajo `mcpServers`:

```json
{
  "mcpServers": {
    "chismoso": {
      "command": "node",
      "args": ["/path/to/chismoso/dist/cli.js", "mcp", "serve"],
      "env": {
        "CHISMOSO_DB_PATH": "/path/to/chismoso/data/chismoso.db"
      }
    }
  }
}
```

Notas:

- Sustituye `/path/to/chismoso/` por la ruta absoluta a tu instalación de
  CHISMOSO. Los paths **deben ser absolutos** — Claude Desktop no expande `~`
  ni variables de entorno dentro de `args`.
- Asegúrate de que `dist/cli.js` exista. Si acabas de clonar el repo:
  ```bash
  cd /path/to/chismoso && npm install && npm run build
  ```
- Tras editar el config, **cierra Claude Desktop completamente** (Cmd+Q en
  macOS, no solo cerrar la ventana) y vuelve a abrirlo. El icono del martillo
  (🔨) en el chat muestra los tools MCP disponibles.

Ejemplo completo en
[`docs/mcp-examples/claude-desktop-config.json`](mcp-examples/claude-desktop-config.json).

---

## 6. Configuración con Cursor

Cursor lee MCP servers de `.cursor/mcp.json` (workspace) o `~/.cursor/mcp.json`
(global). Recomendado: workspace para configuración reproducible por proyecto.

Crea `.cursor/mcp.json` en la raíz de tu workspace:

```json
{
  "mcpServers": {
    "chismoso": {
      "command": "node",
      "args": ["/path/to/chismoso/dist/cli.js", "mcp", "serve"]
    }
  }
}
```

Tras editar:

1. Abre el command palette: `Cmd+Shift+P` (macOS) / `Ctrl+Shift+P` (Win/Linux).
2. Ejecuta **"MCP: Reload Servers"**.
3. En el panel de chat, switch a **Agent mode** (el selector de modelo debe
   estar en un modo que soporte tool calls, p.ej. `claude-3-5-sonnet`).

Ejemplo completo en
[`docs/mcp-examples/cursor-config.json`](mcp-examples/cursor-config.json).

---

## 7. Configuración con Continue.dev

Continue.dev lee su config de `~/.continue/config.json`. Añade CHISMOSO bajo
`mcpServers`:

```json
{
  "mcpServers": {
    "chismoso": {
      "command": "node",
      "args": ["/path/to/chismoso/dist/cli.js", "mcp", "serve"]
    }
  }
}
```

Tras editar, recarga Continue desde el command palette de VSCode
(`Cmd+Shift+P` → "Continue: Reload"). Los tools MCP aparecen como
`@chismoso_investigate`, `@chismoso_list_anomalies`, etc. en el chat.

Ejemplo completo en
[`docs/mcp-examples/continue-config.json`](mcp-examples/continue-config.json).

---

## 8. Ejemplos de uso en Claude Desktop

Tres conversaciones reales que demuestran el flujo user → Claude → CHISMOSO →
Claude → user.

### Ejemplo 1 — Investigación

> **User**: Investiga oportunidades de automatización para restaurantes en
> Colombia.

Claude invoca el tool `chismoso_investigate`:

```json
{
  "name": "chismoso_investigate",
  "arguments": {
    "objective": "oportunidades de automatización para restaurantes en Colombia",
    "geography": "Colombia",
    "maxQueries": 12,
    "maxRuntimeMs": 300000
  }
}
```

CHISMOSO ejecuta el pipeline completo (puede tardar 1–5 min) y devuelve JSON
con `trends[]`, `problems[]`, `opportunities[]`, `executiveSummary`,
`limitations`, `recommendedNextAction`.

**Claude resume**:

> Detecté 3 trends emergentes en automatización para restaurantes en Colombia:
> 1. **Pedidos por voz** (score 78, EMERGING_TREND) — creciendo 2.3× en
>    community mentions en 6 meses.
> 2. **Integración POS ↔ WhatsApp** (score 71, EMERGING_TREND).
> 3. **KDS digitales sin hardware propietario** (score 65, WEAK_SIGNAL).
>
> El problema más severo (severity 72/100): "dueños pierden pedidos por
> saturación en horas pico" — mencionado por 18 reddits distintos en el último
> mes.
>
> **Top oportunidad** (score 49/100):
> SaaS de pedidos por voz plug-and-play para restaurantes small-format en
> Bogotá/Medellín. ICP: 5–15 empleados. Pricing: COP 89k/mes. SuggestedNextAgent:
> AGENTE-LEADS.

### Ejemplo 2 — Profundización en anomalías

> **User**: Muéstrame las anomalías activas.

Claude primero llama al tool `chismoso_list_anomalies`:

```json
{ "name": "chismoso_list_anomalies", "arguments": {} }
```

Y luego, para enriquecer el contexto, adjunta el resource
`chismoso://anomalies/active` a la conversación. Claude presenta:

> **Anomalías activas detectadas (3)**:
>
> | Topic                  | Tipo            | Z-score | Window     | Confianza |
> |------------------------|-----------------|---------|------------|-----------|
> | restaurant automation  | volume_spike_up | +3.21   | 7 días     | 89%       |
> | ghost kitchens          | velocity_change | +2.14   | 30 días    | 71%       |
> | delivery automation     | confidence_drop | -1.92   | 14 días    | 65%       |
>
> La anomalía más relevante es el volume spike en *restaurant automation* —
> 3.2σ por encima de la baseline. Recomiendo lanzar una investigación
> específica (`chismoso_investigate` con `objective="restaurant automation"`)
> para entender qué la está disparando.

### Ejemplo 3 — Comparación de topics

> **User**: Compara restaurants vs cafeterías.

Claude usa el prompt template `compare_topics`:

```json
{
  "name": "compare_topics",
  "arguments": {
    "topicA": "restaurant automation",
    "topicB": "cafe automation"
  }
}
```

El prompt renderizado le pide a Claude llamar a `chismoso_get_topic_history`
dos veces (una por topic) y a `chismoso_list_anomalies` dos veces. Claude
procesa los 4 resultados y produce:

> **Comparación: restaurant automation vs cafe automation**
>
> | Métrica                  | restaurant automation | cafe automation |
> |--------------------------|-----------------------|-----------------|
> | Observaciones totales    | 42                    | 18              |
> | Último `signals_count`   | 11                    | 4               |
> | Última `confidence`      | 78%                   | 52%             |
> | Anomalías activas        | 1 (volume_spike_up)   | 0               |
> | Velocity trend           | ↑ creciente           | → estable       |
>
> **Conclusión**: *restaurant automation* muestra momentum significativamente
> mayor (3× el conteo de observaciones, 50% más confianza, anomalía activa de
> volumen). Recomendaría priorizar investigación profunda en ese eje.

---

## 9. CHISMOSO consumiendo otros MCP servers

CHISMOSO puede consumir servers MCP externos durante una investigación. Esto
amplía el tool palette del orchestrator: el LLM puede decidir, por ejemplo,
buscar repositorios de GitHub o leer un archivo local como parte de su
razonamiento.

### Config de ejemplo

Guarda como `/home/z/my-project/chismoso/data/mcp-servers.json`:

```json
{
  "servers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxx"
      },
      "transport": "stdio",
      "enabled": true
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/z/my-project"],
      "transport": "stdio",
      "enabled": true
    }
  }
}
```

### Flujo

1. El usuario ejecuta `chismoso investigate "competitive landscape of X"`.
2. `autoConnectMCP(toolRegistry)` spawnea los subprocesos `npx` para `github` y
   `filesystem`, hace handshake MCP, lista sus tools, y los registra en el
   ToolRegistry como `github_search_repositories`, `github_get_file_contents`,
   `filesystem_read_file`, etc. (dots reemplazados por underscores).
3. El ReAct orchestrator ve ahora **4 + N** tools disponibles (4 built-in + N
   remotos).
4. Si el planner del LLM decide que conviene, por ejemplo, listar repos GitHub
   de competidores, emite:
   ```json
   { "tool": "github_search_repositories", "args": { "query": "restaurant pos" } }
   ```
5. El ToolRegistry delega al `mcpRegistry.callTool("github", "search_repositories", args)`,
   que a su vez llama vía JSON-RPC al subproceso GitHub MCP, y devuelve el
   resultado al LLM.
6. Al finalizar la investigación, todos los subprocesos MCP se desconectan
   limpiamente.

Para **desactivar** un server sin borrarlo de la config, pon `"enabled": false`
o ejecuta `chismoso mcp disconnect <name>`.

### Servers MCP populares testeados

| Server                                              | Tools expuestos (ejemplo)                                  |
|-----------------------------------------------------|-------------------------------------------------------------|
| `@modelcontextprotocol/server-filesystem`            | `read_file`, `write_file`, `list_directory`, `search_files` |
| `@modelcontextprotocol/server-github`               | `search_repositories`, `get_file_contents`, `create_issue`  |
| `@modelcontextprotocol/server-slack`                 | `list_channels`, `post_message`, `search_messages`          |
| `@modelcontextprotocol/server-postgres`             | `query`, `list_tables`, `describe_table`                    |

---

## 10. Cliente custom

Si necesitas integrar CHISMOSO en tu propia aplicación (no Claude Desktop,
Cursor, etc.), el SDK oficial de TypeScript está documentado en
<https://modelcontextprotocol.io>. Ejemplo mínimo:

```typescript
// custom-client.ts — cliente MCP programático para CHISMOSO
// Ejecutar con: npx tsx custom-client.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['/path/to/chismoso/dist/cli.js', 'mcp', 'serve'],
});

const client = new Client(
  { name: 'my-app', version: '1.0.0' },
  { capabilities: {} },
);

await client.connect(transport);

const { tools } = await client.listTools();
console.log('Available tools:', tools.map(t => t.name));

const result = await client.callTool({
  name: 'chismoso_list_providers',
  arguments: {},
});
console.log(result.content);

await client.close();
```

Pasos:

1. Copia `docs/mcp-examples/custom-client.ts` a tu proyecto.
2. Ajusta el path en `args` a tu instalación de CHISMOSO.
3. Instala el SDK: `npm install @modelcontextprotocol/sdk`.
4. Ejecuta: `npx tsx custom-client.ts`.

El patrón es idéntico al que usa `src/mcp/client.ts` internamente en CHISMOSO
para consumir servers externos — ver ese archivo para un ejemplo completo con
manejo de errores, listing de resources, y reconexión.

---

## 11. Seguridad

### Modelo de confianza

Los servers MCP spawnados por CHISMOSO corren **con los mismos permisos que
el proceso CHISMOSO**. Es decir: si CHISMOSO puede leer `/etc/passwd`, también
puede cualquier server MCP que habilites. Ten cuidado con qué servers activas.

### Tokens y credenciales

| Server                  | Credencial necesaria                  | Cómo almacenarla                                     |
|-------------------------|---------------------------------------|------------------------------------------------------|
| `@mcp/server-github`   | `GITHUB_PERSONAL_ACCESS_TOKEN`         | `data/mcp-servers.json` (en `.gitignore`) o env var |
| `@mcp/server-slack`    | `SLACK_BOT_TOKEN`                     | Idem                                                 |
| `@mcp/server-postgres` | `DATABASE_URL`                        | Idem                                                 |

`data/mcp-servers.json` ya está en `.gitignore` de CHISMOSO — verifica el tuyo
antes de commitear.

### Filesystem MCP

`@modelcontextprotocol/server-filesystem` puede **leer y escribir archivos**
dentro del path que le pases como argumento. Restringe el path a un
subdirectorio específico, **no** a `/` ni a tu `$HOME`:

```jsonc
// ✅ BIEN — sandbox acotado
"args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/z/my-project/sandbox"]

// ❌ MAL — acceso a todo el filesystem
"args": ["-y", "@modelcontextprotocol/server-filesystem", "/"]
```

### SSRF

CHISMOSO V1.2 ya incluye protección SSRF para sus providers HTTP
(`WebSearchProvider`, `WebContentProvider`). Esa protección **se aplica
también a los servers MCP transport=http** — una URL maliciosa en
`data/mcp-servers.json` no podrá reached internal addresses (`127.0.0.1`,
`10.0.0.0/8`, `169.254.169.254`, etc.).

### Auto-connect en CI

Si ejecutas CHISMOSO en CI/CD o en un cron, **desactiva el auto-connect** para
evitar timeouts por servers MCP que no arranquen:

```bash
chismoso investigate "..." --no-mcp
```

### Auditar servers activos

Antes de ejecutar una investigación, lista qué servers están habilitados:

```bash
chismoso mcp list-servers
```

---

## 12. Troubleshooting

| Síntoma                                        | Causa probable                                            | Solución                                                                              |
|------------------------------------------------|-----------------------------------------------------------|---------------------------------------------------------------------------------------|
| `MCP server failed to start`                  | `command`/`args` mal configurados                         | Verifica con `chismoso mcp list-servers` y prueba manualmente con `chismoso mcp connect <name>` |
| `Tool not found`                               | Server no conectado o tool no existe                     | `chismoso mcp tools` para listar tools disponibles; luego `chismoso mcp connect <name>` |
| `Connection refused`                           | HTTP transport, URL incorrecta o puerto cerrado           | Verifica `url` en el config; haz `curl -i <url>`                                     |
| Claude Desktop no ve CHISMOSO                  | Config no recargado                                       | Cierra Claude Desktop **completamente** (Cmd+Q) y vuelve a abrirlo                   |
| `spawn ENOENT`                                 | El `command` no existe en `PATH`                         | Usa rutas absolutas (`/usr/bin/node` en vez de `node`); verifica que `npx` esté instalado |
| Claude Desktop: "Server disconnected" al inicio | STDOUT contaminado por logs                              | Asegúrate de estar en V1.3.0+ — `redirectConsoleToStderr()` fue añadido en MCP-1     |
| Tool devuelve JSON con `isError: true`         | El tool ejecutó pero falló internamente                   | Lee el campo `message` del JSON; suele ser parámetro inválido o DB vacía              |
| `chismoso_investigate` cuelga indefinidamente   | Server MCP externo colgado (auto-connect bloqueando)     | Ejecuta con `--no-mcp` para aislar; luego `chismoso mcp disconnect <name>`            |
| `unknown_tool` response                        | Nombre mal escrito o server no actualizado                | Lista tools disponibles: `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \| node dist/cli.js mcp serve` |
| Cambios en `data/mcp-servers.json` no se reflejan | El proceso CHISMOSO ya estaba corriendo                  | Mata el proceso y vuelve a arrancarlo; el config se lee en cada `investigate` invocation |

### Diagnóstico paso a paso

1. **¿CHISMOSO arranca como server?**
   ```bash
   echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | \
     node /path/to/chismoso/dist/cli.js mcp serve
   ```
   Debes ver un response JSON-RPC con 8 tools.

2. **¿El server externo arranca?**
   ```bash
   chismoso mcp connect <name>
   ```
   Debe imprimir `[connected] <name> · N tools · M resources`.

3. **¿Claude Desktop carga el config?**
   Abre Claude Desktop → settings → Developer → debe aparecer `chismoso` con
   un check verde. Si hay error, el log está en
   `~/Library/Logs/Claude/mcp.log` (macOS).

4. **¿Los tools llegan al LLM?**
   En Claude Desktop, abre un chat nuevo. El icono 🔨 debe listar
   `chismoso_investigate`, `chismoso_list_anomalies`, etc.

---

## Apéndice: referencias

- **Spec MCP oficial**: <https://modelcontextprotocol.io/specification>
- **SDK TypeScript**: <https://github.com/modelcontextprotocol/typescript-sdk>
- **Servers de referencia**: <https://github.com/modelcontextprotocol/servers>
- **Anthropic intro post**: <https://www.anthropic.com/news/model-context-protocol>

Código fuente CHISMOSO V1.3 relevante:

- `src/mcp/server.ts` — entry point del server (stdio)
- `src/mcp/tools.ts` — los 8 tools
- `src/mcp/resources.ts` — los 6 resources
- `src/mcp/prompts.ts` — los 3 prompts
- `src/mcp/client.ts` — client wrapper (consumo de servers externos)
- `src/mcp/registry.ts` — registry de servers conectados
- `src/mcp/bridge.ts` — bridge ToolRegistry ↔ MCP tools
- `src/mesh/mcp-config.ts` — schema + persistencia de `data/mcp-servers.json`
- `src/cli.ts` — comando `mcp` (todos los subcomandos)
