# CHISMOSO V1.0 — Agente de inteligencia de señales, tendencias, problemas y oportunidades de negocio

> *"CHISMOSO no existe para saberlo todo. Existe para detectar antes que otros qué está empezando a importar."*

| Atributo       | Valor                                                     |
|----------------|-----------------------------------------------------------|
| **Versión**    | 1.0.0                                                     |
| **Estado**     | Production-ready (V1) — 41/41 tests pasan                 |
| **Runtime**    | Node.js ≥ 20 (probado en Node 24)                        |
| **Lenguaje**   | TypeScript 5.6 (ESM)                                     |
| **Licencia**   | MIT                                                       |
| **Dependencias** | `z-ai-web-dev-sdk` (web_search + page_reader + LLM), `better-sqlite3` |

---

## ¿Qué es CHISMOSO?

CHISMOSO es un **agente de inteligencia** que transforma un objetivo de investigación en lenguaje natural en un reporte accionable de tendencias, problemas y oportunidades de negocio. Forma parte de un ecosistema de agentes especializados —junto a **AGENTE-LEADS**, **NEX-SCOPE**, **RADAR-SECOP2**, **AGENTE-TRADING** y **CRM-ALBRA**— donde cada agente hace una sola cosa muy bien y se la pasa al siguiente mediante un contrato explícito.

La propuesta de CHISMOSO es estrecha y deliberada: **detectar señales tempranas** ( débiles o fuertes) que indiquen que algo está empezando a importar en un mercado, convertir esas señales en tendencias y problemas corroborados, y traducirlos en oportunidades con un scoring transparente y trazable. Cada oportunidad lleva `suggestedNextAgent: "AGENTE-LEADS"`, que es el agente responsable de convertirla en inteligencia de leads.

**CHISMOSO no es**:

- ❌ Un chatbot. No conversa; ejecuta un objetivo y produce un reporte.
- ❌ Un scraper genérico. No descarga HTML arbitrario; usa providers con tipado y normalización.
- ❌ Un agregador de noticias. No muestra titulares; agrupa, clasifica y puntúa.
- ❌ Otro AGENTE-LEADS. No genera leads; genera **oportunidades** para que AGENTE-LEADS las procese.

El pipeline interno que ejecuta en cada investigación es estricto y unidireccional:

```
DATOS  →  SEÑALES  →  PATRONES  →  TENDENCIAS / PROBLEMAS  →  OPORTUNIDADES  →  INTELIGENCIA ACCIONABLE
```

Cada etapa es auditable: cada señal contiene `rawSnippet` y `url` de origen, cada tendencia contiene su evidencia, cada oportunidad contiene su `scoreBreakdown` que explica cómo se calculó el puntaje. **No hay números mágicos**: si una oportunidad dice 49/100, el reporte muestra exactamente cómo se llegó a 49.

---

## Instalación

```bash
cd /home/z/my-project/chismoso
npm install
npm run build
```

Esto produce `dist/` con `cli.js` y `index.js` listos para usar. El binario `chismoso` queda disponible tras `npm link` o vía `npx`:

```bash
node dist/cli.js help
# o, tras npm link:
chismoso help
```

> **Nota:** `better-sqlite3` compila un binario nativo. En entornos restringidos puede ser necesario `npm rebuild better-sqlite3`.

---

## Uso del CLI

### Comandos disponibles

| Comando                                                              | Descripción                                                           |
|----------------------------------------------------------------------|-----------------------------------------------------------------------|
| `chismoso investigate "<objective>" [flags]`                         | Ejecuta una investigación completa sobre el objetivo dado.            |
| `chismoso demo`                                                      | Ejecuta la investigación canónica de la especificación (sección 58). |
| `chismoso providers`                                                 | Lista los providers registrados y su estado de salud.                |
| `chismoso history [--topic=<topic>]`                                 | Muestra historial de tendencias (todas o filtradas por tópico).     |
| `chismoso show <investigationId>`                                   | Muestra una investigación almacenada en SQLite.                      |
| `chismoso help`                                                      | Imprime la ayuda con todos los comandos y variables de entorno.     |

### Flags de `investigate`

| Flag                  | Tipo    | Descripción                                                       |
|-----------------------|---------|-------------------------------------------------------------------|
| `--geography=<loc>`   | string  | Geografía (país, región o `global`). Default: `global`.           |
| `--max-queries=N`     | int     | Número máximo de queries a ejecutar (default: 12).                |
| `--max-runtime-ms=N`  | int     | Tiempo máximo de ejecución en ms (default: 300000 = 5 minutos).  |
| `--save`              | flag    | Persiste el reporte en `CHISMOSO_OUTPUT_DIR` (.md + .json).     |

### Ejemplos concretos

```bash
# 1. Investigación canónica — automatización de restaurantes en Colombia
chismoso investigate \
  "Investiga qué tendencias y problemas emergentes podrían generar oportunidades de negocio para automatización de pequeños restaurantes en Colombia." \
  --geography=Colombia --max-queries=8 --save

# 2. Investigación rápida sin guardar reporte
chismoso investigate "Tendencias emergentes en IA generativa para marketing B2B" \
  --geography=global --max-queries=6 --max-runtime-ms=120000

# 3. Listar providers y su salud
chismoso providers

# 4. Ver historial de un tópico específico
chismoso history --topic=automatizacion

# 5. Recuperar una investigación previa por ID
chismoso show inv_muvfmcw36y3lps
```

El comando `investigate` siempre imprime el reporte Markdown a **stdout** y los logs informativos (status, conteos, path guardado) a **stderr**. Si usas `--save`, también escribe dos archivos:

- `report-<investigationId>.md` — reporte human-readable.
- `report-<investigationId>.json` — reporte machine-readable (schema `IntelligenceReport`).

---

## Variables de entorno

| Variable                | Default                                          | Descripción                                                        |
|-------------------------|--------------------------------------------------|--------------------------------------------------------------------|
| `CHISMOSO_DB_PATH`     | `data/chismoso.db`                               | Ruta al archivo SQLite (se crea si no existe).                     |
| `CHISMOSO_LOG_LEVEL`   | `INFO`                                           | Nivel de logging: `DEBUG` \| `INFO` \| `WARN` \| `ERROR`.         |
| `CHISMOSO_GEOGRAPHY`   | `global`                                         | Geografía por defecto si `--geography` no se pasa.                |
| `CHISMOSO_OUTPUT_DIR`  | `/home/z/my-project/download/chismoso`           | Directorio donde se guardan los reportes con `--save`.            |

Ejemplo:

```bash
CHISMOSO_LOG_LEVEL=DEBUG \
CHISMOSO_OUTPUT_DIR=./reports \
chismoso investigate "..." --save
```

---

## Uso como librería

CHISMOSO expone toda su API pública desde `src/index.ts`. Puedes usarlo programáticamente sin pasar por el CLI:

```typescript
import {
  ChismosoDB,
  Repositories,
  createDefaultProviderRegistry,
  createDefaultToolRegistry,
  LLMClient,
  Orchestrator,
  resolveConfig,
  LogLevel,
  setLogLevel,
} from 'chismoso';

async function main() {
  const cfg = resolveConfig();
  setLogLevel(LogLevel.INFO);

  const db = new ChismosoDB({ path: cfg.dbPath });
  const repositories = new Repositories(db);
  const providerRegistry = createDefaultProviderRegistry();
  const toolRegistry = createDefaultToolRegistry();
  const llm = new LLMClient();

  const orchestrator = new Orchestrator({
    db,
    repositories,
    providerRegistry,
    toolRegistry,
    llm,
    budget: {
      maxQueries: 8,
      maxRuntimeMs: 60_000,
      maxProviderCalls: 10,
    },
  });

  const result = await orchestrator.investigate({
    objective: 'Detectar oportunidades para SaaS de contabilidad para freelancers en LatAm',
    geography: 'LATAM',
  });

  console.log('Status:', result.investigation.status);
  console.log('Signals:', result.signals.length);
  console.log('Trends:', result.trends.length);
  console.log('Problems:', result.problems.length);
  console.log('Opportunities:', result.opportunities.length);

  for (const opp of result.opportunities) {
    console.log(`- ${opp.title} (score=${opp.score}, next=${opp.suggestedNextAgent})`);
  }

  // El reporte ya viene listo para consumir:
  //   result.report.markdown  → string Markdown
  //   result.report.machine   → IntelligenceReport (JSON-serializable)
  fs.writeFileSync('report.md', result.report.markdown);
  fs.writeFileSync('report.json', JSON.stringify(result.report.machine, null, 2));

  db.close();
}

main();
```

Los exports públicos incluyen: modelos canónicos (`Signal`, `Evidence`, `Trend`, `Problem`, `Opportunity`, `Investigation`, `IntelligenceReport`), enums (`SignalType`, `TruthLevel`, `TrendState`, `ProviderHealth`, `InvestigationStatus`), y toda la capa de inteligencia (`clusterSignals`, `detectTrend`, `detectProblem`, `generateOpportunity`).

---

## Arquitectura

CHISMOSO sigue el principio **INTERFACE ≠ CEREBRO ≠ CAPACIDADES**: el CLI es una cáscara fina, el Orchestrator es el cerebro, y los providers/intelligence son capacidades intercambiables. Para detalles completos ver `ARCHITECTURE.md`.

```
                       ┌──────────────────────────────────────────────────────────┐
   USER ────►  CLI     │                                                          │
                       │      ┌──────────────────────────────────────────┐         │
                       │      │           ORCHESTRATOR (cerebro)          │         │
                       │      │                                          │         │
                       │      │  1. ResearchPlanner (LLM)                │         │
                       │      │        └── fallback determinista         │         │
                       │      │  2. Loop controlado por Budget           │         │
                       │      │     (maxQueries, maxRuntime, maxCalls)   │         │
                       │      │  3. Tools → Providers (RawItem)          │         │
                       │      │  4. Normalizer / Dedup / Cluster         │         │
                       │      │  5. Trend Engine + Problem Engine         │         │
                       │      │  6. Cross-source confirmation            │         │
                       │      │  7. Opportunity Engine (scoring)        │         │
                       │      │  8. Reporter (markdown + JSON)           │         │
                       │      │  9. Persistence (SQLite)                 │         │
                       │      └──────────────────────────────────────────┘         │
                       │                    │                                     │
                       │     ┌──────────────┴──────────────┐                       │
                       │     ▼                              ▼                       │
                       │  PROVIDERS              MEMORY (SQLite)                    │
                       │  - web_search            - signals, evidence                │
                       │  - reddit_communities    - trends, problems                  │
                       │  - web_content           - opportunities                     │
                       │  - google_trends (UNAV)  - investigations                    │
                       │                          - topic_observations                │
                       └──────────────────────────────────────────────────────────┘
                                         │
                                         ▼
                          REPORT (markdown + JSON)
                                         │
                                         ▼
                  Opportunity.suggestedNextAgent = "AGENTE-LEADS"
```

El flujo interno del Orchestrator en cada `investigate()`:

```
INTERPRETAR OBJETIVO  →  PLANIFICAR (LLM)  →  SELECCIONAR FUENTES
   →  RECOPILAR SEÑALES  →  NORMALIZAR / DEDUP / CLUSTERING
   →  ANALIZAR (TREND + PROBLEM DETECTION)  →  CROSS-SOURCE CONFIRMATION
   →  GENERAR OPORTUNIDADES  →  PUNTUAR  →  GENERAR REPORTE  →  ALMACENAR
```

El loop está acotado por un `InvestigationBudget` que garantiza terminación finita. El estado final puede ser `COMPLETED`, `PARTIAL`, `FAILED` o `INSUFFICIENT_EVIDENCE` (cuando no se obtuvo ninguna señal).

---

## Providers disponibles

| Provider              | SourceType             | Estado        | Backend SDK                         | Descripción                                              |
|-----------------------|------------------------|---------------|-------------------------------------|----------------------------------------------------------|
| `WebSearchProvider`   | `SEARCH_WEB`           | **OK (real)** | `z-ai-web-dev-sdk` → `web_search`   | Búsqueda web general. Hasta 30 req/min, 20 resultados.  |
| `RedditProvider`      | `REDDIT_COMMUNITIES`   | **OK (real)** | `z-ai-web-dev-sdk` → `web_search`   | Búsqueda en comunidades (site:reddit.com, quora.com).   |
| `WebContentProvider`  | `WEB_CONTENT`          | **OK (real)** | `z-ai-web-dev-sdk` → `page_reader`  | Profundiza URLs concretas para extraer evidencia rica.  |
| `GoogleTrendsProvider`| `GOOGLE_TRENDS`        | **UNAVAILABLE**| (sin credenciales configuradas)     | Registrado pero no operativo. No simula datos.          |

### Política anti-ficticia

`GoogleTrendsProvider` está **registrado** para que el resto del sistema sepa que la categoría existe, pero su `health()` retorna `UNAVAILABLE` y su `search()` retorna siempre un resultado vacío con `errorCode: PROVIDER_UNAVAILABLE`. **Nunca fabrica datos**: si no hay API, no hay output. Para activarlo en V2 basta con implementar `search()` y cambiar `capabilities().status` a `OK`; el resto del sistema no requiere cambios.

Los providers reales tampoco simulan: si la SDK falla, el error se propaga con su `ErrorCode` apropiado (`PROVIDER_UNAVAILABLE`, `RATE_LIMITED`, `AUTH_REQUIRED`, `TIMEOUT`).

---

## Tipos de señal

CHISMOSO reconoce 12 `SignalType` (enumerados en `src/models.ts`):

| SignalType           | Significado                                              |
|----------------------|----------------------------------------------------------|
| `SEARCH_SPIKE`       | Pico de búsquedas sobre un tópico.                       |
| `MENTION_SPIKE`     | Pico de menciones en contenido social/comunitario.      |
| `QUESTION_SPIKE`     | Pico de preguntas (¿cómo...?, ¿por qué...?).            |
| `COMPLAINT_SPIKE`    | Pico de quejas o fricción explícita.                    |
| `CONTENT_GROWTH`     | Crecimiento sostenido de contenido sobre el tópico.     |
| `ENGAGEMENT_GROWTH`  | Crecimiento de engagement (comentarios, votos).         |
| `NEW_PRODUCT`        | Aparición de un producto o servicio nuevo.              |
| `NEW_BEHAVIOR`       | Aparición de un comportamiento nuevo en el mercado.     |
| `PRICE_CHANGE`       | Cambio de precio relevante detectado.                   |
| `DEMAND_SIGNAL`      | Señal de demanda explícita (intención de compra).       |
| `PROBLEM_SIGNAL`     | Señal de problema (fricción, dolor, frustración).       |
| `MARKET_SIGNAL`      | Señal estructural del mercado (regulación, M&A).        |

El `Normalizer` infiere el `signalType` a partir de patrones léxicos en ES e IN (por ejemplo, "no funciona", "no puedo", "frustrado" → `COMPLAINT_SPIKE`; "cómo", "por qué", "cual es el mejor" → `QUESTION_SPIKE`).

---

## Modelo de evidencia

La unidad atómica de CHISMOSO es la **evidencia**. Una señal sin evidencia trazable se descarta. El modelo se define en `src/models.ts`:

### `Signal`

```typescript
interface Signal {
  id: string;
  topic: string;               // tópico / query de origen
  keyword: string;             // keyword normalizada que disparó la señal
  source: string;              // proveedor (web_search, reddit_communities...)
  sourceType: SourceType;
  timestamp: string;           // ISO
  geography: string;
  metric: string;              // métrica observada (mentions, results, etc.)
  value: number | string;      // valor crudo
  normalizedValue: number;     // valor normalizado 0..1
  direction: 'up' | 'down' | 'flat' | 'unknown';
  velocity: number;            // tasa de cambio
  confidence: number;          // 0..1
  evidenceType: TruthLevel;    // OBSERVED | DERIVED | INFERRED | PREDICTED | UNKNOWN
  signalType: SignalType;
  metadata: Record<string, unknown>;
  rawSnippet: string;          // texto original del cual se extrajo
  url?: string;                // URL de origen
}
```

### `Evidence`

```typescript
interface Evidence {
  id: string;
  source: string;
  sourceType: SourceType;
  url?: string;
  observedAt: string;          // cuándo ocurrió el evento
  collectedAt: string;         // cuándo lo recolectó CHISMOSO
  geographicScope: string;
  topic: string;
  rawValue: string;
  normalizedValue: string;
  confidence: number;          // 0..1
  evidenceType: TruthLevel;
  metadata: Record<string, unknown>;
}
```

### TruthLevel — la distinción clave

La especificación (sección 5) exige que cada pieza de inteligencia lleve su nivel de verdad:

| TruthLevel   | Significado                                                          |
|--------------|---------------------------------------------------------------------|
| `OBSERVED`   | Una fuente real muestra esto (signal con URL y rawSnippet).        |
| `DERIVED`    | Conclusión obtenida procesando evidencia (trend, opportunity).     |
| `INFERRED`   | Hipótesis razonable pero no corroborada.                           |
| `PREDICTED`  | Proyección futura.                                                 |
| `UNKNOWN`    | Información insuficiente para clasificar.                          |

En el reporte, las **señales** siempre son `OBSERVED` (vienen de providers reales), mientras que las **tendencias** y **oportunidades** son `DERIVED` (son síntesis). Esta distinción es obligatoria: el usuario siempre puede saber qué es observado y qué es inferido.

---

## Scoring de oportunidades

El Opportunity Engine usa un **scoring transparente**: el puntaje final nunca es un número mágico. El reporte muestra el desglose completo en `scoreBreakdown`. Los pesos están en `src/intelligence/opportunities.ts`:

| Componente         | Peso  | Dirección  | Origen del cálculo                                            |
|--------------------|-------|------------|---------------------------------------------------------------|
| `demand`           | 0.18  | + (positivo) | Volumen de señales + score del trend + cross-source.         |
| `growth`           | 0.18  | +          | `trend.growth * 100` o fallback por recencia.                |
| `problemSeverity`  | 0.16  | +          | `problem.severity` (0..100). Si no hay problema, 30 default. |
| `monetization`     | 0.14  | +          | Severidad del problema + keywords de pago/precio.           |
| `timing`           | 0.12  | +          | Estado del trend (emergente > establecido) + recencia.      |
| `marketFit`        | 0.12  | +          | Ratio de señales de comunidad vs. prensa.                    |
| `competition`      | 0.05  | − (penaliza) | Menciones de "alternativa", "vs", "competidor".            |
| `uncertainty`      | 0.09  | − (penaliza) | `100 − confianza media` − ajuste por volumen.              |

**Fórmula** (normalizada para que la suma de pesos absolutos sea 1.04):

```
score = (0.18·demand + 0.18·growth + 0.16·problemSeverity
       + 0.14·monetization + 0.12·timing + 0.12·marketFit
       − 0.05·competition − 0.09·uncertainty) / 1.04
```

Una oportunidad con `score < 35` o `confidence < 0.30` se marca como `weak` y **no se entrega** al reporte final. El reporte siempre incluye el `scoreBreakdown` para que un humano pueda auditar y cuestionar el puntaje.

### Regla de oro (sección 22 de la spec)

> Nunca afirmar "esta oportunidad va a generar mucho dinero".
> Afirmar: *"la evidencia disponible sugiere una oportunidad potencial de X, con confianza Y y estas limitaciones."*

---

## Testing

```bash
npm test           # Vitest: 39 tests unitarios + 2 E2E = 41 total
npm run test:e2e   # Solo tests end-to-end (investigación canónica con datos reales)
npm run test:watch # Mode watch para desarrollo
npm run lint       # tsc --noEmit (verificación de tipos sin emitir)
```

### Cobertura de tests

| Suite               | Archivo                          | Qué cubre                                                  |
|---------------------|----------------------------------|-------------------------------------------------------------|
| Normalizer          | `tests/normalizer.test.ts`       | Tokenización ES/EN, inferencia de signalType, dedup.       |
| Errors              | `tests/errors.test.ts`           | Taxonomía de errores, `retryStrategy`.                     |
| Clustering          | `tests/clustering.test.ts`       | Overlap coefficient, threshold 0.34.                        |
| Trends              | `tests/trends.test.ts`           | `detectTrend`, `classifyState`, growth/velocity/persistence.|
| Opportunities       | `tests/opportunities.test.ts`    | Scoring, weak opportunities, `scoreBreakdown`.             |
| Providers + DB      | `tests/providers-db.test.ts`     | Persistencia en SQLite, repos CRUD.                         |
| E2E (real)          | `tests/e2e.test.ts`               | Investigación canónica con providers reales.              |

Los tests E2E ejecutan el objetivo canónico de la sección 58 de la especificación contra providers reales (web_search, reddit_communities). **No usan mocks**. Son lentos (~30-60s) porque hacen llamadas reales a la web.

---

## Salida del reporte

Cada investigación produce **dos formatos paralelos** del mismo reporte:

### 1. Markdown (human-readable)

```markdown
# CHISMOSO INTELLIGENCE REPORT

**Investigation ID:** `inv_muvfmcw36y3lps`
**Generated at:** 2026-10-05T15:56:28.511Z
**Providers used:** web_search, reddit_communities

## Question
<objetivo>

## Resumen ejecutivo
<resumen con conteos y confianza global>

## Tendencias detectadas (N)
### 1. <tópico>
- State: WEAK_SIGNAL / EMERGING_TREND / ...
- Confidence: 55%
- Score: 60/100
- Sources: 1 (signal types: 13)
- Growth · Velocity · Persistence · Cross-source
- TruthLevel: OBSERVED
- Evidence (top 3):
  - [OBSERVED] web_search — <snippet> (https://...)

## Problemas detectados (N)
## Oportunidades (N)
## Limitaciones
## Acción recomendada
```

### 2. JSON (machine-readable)

Schema `IntelligenceReport` definido en `src/models.ts`:

```typescript
interface IntelligenceReport {
  query: string;
  scope: string;
  generatedAt: string;
  executiveSummary: string;
  trends: Trend[];
  problems: Problem[];
  opportunities: Opportunity[];
  signals: Signal[];
  evidence: Evidence[];
  overallConfidence: number;       // 0..1
  limitations: string[];            // explícitas, no ocultas
  recommendedNextAction: string;
  investigationId: string;
  providersUsed: string[];
}
```

El JSON es el formato pensado para que **otros agentes** (AGENTE-LEADS) consuman el output programáticamente. El Markdown está pensado para que un humano lo lea.

---

## Interoperabilidad

CHISMOSO es un agente **especializado** en un ecosistema. Produce `Opportunity` objects con un contrato explícito que indica qué agente debe tomar el relevo:

```typescript
interface Opportunity {
  // ...campos de scoring...
  suggestedNextAgent: 'AGENTE-LEADS';  // contrato de hand-off
  confidence: number;                    // confianza para que el siguiente agente priorice
  evidence: Evidence[];                  // evidencia trazable para reutilizar
  targetSegment: string;
  geography: string;
  problemRef?: string;                   // enlace al problema detectado
  trendRef?: string;                     // enlace al trend detectado
}
```

### Flujo conceptual del ecosistema

```
CHISMOSO  →  Opportunity  →  AGENTE-LEADS  →  Lead Intelligence  →  CRM-ALBRA  →  Venta
```

- **CHISMOSO** detecta *qué está empezando a importar* y lo encapsula como `Opportunity`.
- **AGENTE-LEADS** toma la oportunidad y genera inteligencia sobre leads específicos para ese segmento.
- **CRM-ALBRA** convierte esa inteligencia en pipeline de ventas real.

En V1, el hand-off es **contractual pero no IPC**: CHISMOSO produce el `Opportunity` con `suggestedNextAgent="AGENTE-LEADS"`, y cualquier consumidor (script, agente, integración) puede leer el JSON y tomar el relevo. No hay mensajería distribuida todavía (ver *Limitaciones* y *Roadmap V2*).

---

## Limitaciones conocidas (V1)

CHISMOSO V1 es honesto sobre lo que puede y lo que no:

1. **`GoogleTrendsProvider` UNAVAILABLE.** No hay credenciales de Google Trends API configuradas. El provider existe, está registrado, pero retorna vacío. No simula datos.
2. **Solo 3 providers reales.** `web_search`, `reddit_communities`, `web_content`. No hay YouTube, Instagram, X, TikTok, ni fuentes B2B especializadas.
3. **Sin embeddings / vector DB.** El clustering de señales usa **overlap coefficient** heurístico (threshold 0.34) sobre tokens normalizados. No hay similitud semántica con vectores.
4. **Sin IPC entre agentes.** El contrato `Opportunity → AGENTE-LEADS` está definido en el schema, pero no hay bus de mensajes ni sistema distribuido real. El hand-off es file-based o API-based (a integrar).
5. **CLI es la única interfaz V1.** No hay bot de Telegram, no hay Web UI, no hay API REST. Toda interacción es por línea de comandos o por uso programático como librería.
6. **El planner depende del LLM.** El `ResearchPlanner` usa `chat.completions` del SDK para generar queries de investigación. Si el LLM falla (rate limit, timeout, error), hay un **fallback determinista** que genera queries razonables a partir del objetivo, pero la calidad del plan puede degradarse.
7. **`deepen_content` (page_reader) no se invoca en el plan automático.** El planner genera queries textuales; `WebContentProvider` está registrado y testeado pero el loop del Orchestrator V1 no profundiza URLs automáticamente (es un TODO menor para V1.1).
8. **Geografía es informativa.** Los providers no siempre respetan el filtro geográfico (web_search sí filtra con `gl`, pero reddit_communities no tiene filtro regional fino).

---

## Roadmap V2

| Área                  | Objetivo V2                                                            |
|-----------------------|------------------------------------------------------------------------|
| Providers             | Integrar **Google Trends API** real (SerpAPI o Trends no oficial).   |
| Providers             | Añadir **YouTube**, **Instagram**, **X/Twitter**.                     |
| Clustering            | Reemplazar overlap heurístico por **embeddings** + vector DB.         |
| Distribución          | Sistema distribuido de agentes (message bus / cola entre CHISMOSO y AGENTE-LEADS). |
| Interfaces            | **API REST** + **Web UI** + bot de **Telegram**.                       |
| Memory                | Indexación temporal de tendencias con detección de crecimiento multi-ventana. |
| LLM                   | Planner con few-shot examples + self-critique del plan generado.       |
| Idiomas               | Soporte nativo para portugués (Brasil) e inglés además de español.     |

V2 no romperá el contrato de `Opportunity` ni el schema de `IntelligenceReport`; las extensiones serán aditivas.

---

## Licencia

```
MIT License

Copyright (c) 2026 CHISMOSO

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Estado del proyecto

- ✅ V1.0 completo y funcional end-to-end.
- ✅ 41/41 tests pasan (39 unit + 2 E2E con datos reales).
- ✅ Pipeline completo: OBJECTIVE → PLAN (LLM con fallback) → COLLECT (providers reales) → NORMALIZE → DEDUP → CLUSTER → TREND DETECTION → PROBLEM DETECTION → CROSS-SOURCE CONFIRMATION → OPPORTUNITY ENGINE → SCORING → REPORT (markdown + JSON) → STORE (SQLite) → INTEROPERABILITY (`suggestedNextAgent=AGENTE-LEADS`).
- ✅ Cumple la Definition of Done: arquitectura separada, sin capacidades ficticias, evidencia trazable, memoria funcional (`topic_observations`), autonomía (una instrucción de alto nivel ejecuta todo el pipeline), retries/fallbacks/timeouts normalizados, tests unit + E2E.

> *CHISMOSO no existe para saberlo todo. Existe para detectar antes que otros qué está empezando a importar.*
