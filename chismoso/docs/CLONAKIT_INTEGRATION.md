# ClonaKit Integration — Official Provider (Task FRENTE-B-CHISMOSO-CLONAKIT)

> **Status**: implemented · **Provider**: `clonakit` (local, pure, no network) · **Mapping**: 61 frameworks (code comment says 57 — the comment is slightly outdated; the actual table has 61 entries across 11 categories).
>
> **Boundary**: This document covers the **ClonaKit capability-mapping provider** (static, local, read-only). For the **REA** (Reverse-engineer Anything) integration that calls ClonaKit's binary tool via MCP, see the separate [`CLONAKIT-INTEGRATION.md`](./CLONAKIT-INTEGRATION.md) (with hyphen).

---

## What this integration does

Before this task, CHISMOSO shipped `src/intelligence/capability-mapping.ts` (ported from ClonaKit's `herramientas/capacidades.mjs`) but only used it to:

- Enrich fichas (`ficha/builder.ts` references web equivalents).
- Bump Opportunity `marketFit` by +5 when signals mention a concrete native framework (`opportunities.ts → computeTechRecommendations`).
- Attach a compact `signal.metadata.detected_tech` array during normalization.

With this task, ClonaKit becomes an **official provider** in the registry, and **every signal** CHISMOSO detects gets "destripped" with:

| Field | What it is | Where it lives |
|-------|------------|----------------|
| `techStack` | Each mentioned framework, validated against the 61-entry mapping. | In-memory (top-level on the enriched signal) |
| `webEquivalents` | Web-equivalent recommendations for known frameworks. | In-memory (top-level) |
| `fichaSnippet` | A markdown "ficha técnica inicial" summarising the stack. | In-memory (top-level) |
| `metadata.clonakit_enrichment` | The full blob (techStack + webEquivalents + fichaSnippet + counts), JSON-serialised. | Persisted in SQLite (`signals.metadata_json`) |

---

## Architecture (ASCII)

```
                         ┌──────────────────────────────────────────────┐
                         │            PROVIDER REGISTRY                 │
                         │  (src/providers/index.ts)                    │
                         │                                              │
                         │  web_search   reddit_communities   web_content│
                         │  google_trends (UNAVAILABLE)   ★ clonakit ★ │
                         └──────────────────┬───────────────────────────┘
                                            │
                                            ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                         NORMALIZER PIPELINE                              │
│  (src/intelligence/normalizer.ts → normalizeRawItem)                    │
│                                                                          │
│   RawItem ──► inferSignalType ──► rawConfidence ──► extractEntity       │
│                                                                          │
│            ┌─────────────────────────────────────────────────────┐      │
│            │  IMP-CLONA-3 (existing, unchanged):                 │      │
│            │  detectTechMentions(snippet)                        │      │
│            │  → signal.metadata.detected_tech (basic)            │      │
│            └────────────────────┬────────────────────────────────┘      │
│                                 ▼                                        │
│            ┌─────────────────────────────────────────────────────┐      │
│            │  FRENTE-B (NEW): enrichSignalWithTech(signal)        │      │
│            │  (src/intelligence/tech-enricher.ts)                 │      │
│            │                                                       │      │
│            │  1. clonakitProvider.extractTechMentions(snippet)    │      │
│            │       → string[]  (e.g. ['AVFoundation','CoreData']) │      │
│            │  2. if empty → return signal UNCHANGED (fast path)   │      │
│            │  3. clonakitProvider.validateCapabilities(mentioned) │      │
│            │       → ValidatedCapability[]                        │      │
│            │  4. clonakitProvider.buildFichaSnippet(mentioned)    │      │
│            │       → markdown string                              │      │
│            │  5. attach techStack / webEquivalents / fichaSnippet │      │
│            │     + metadata.clonakit_enrichment (persisted blob)  │      │
│            └────────────────────┬────────────────────────────────┘      │
│                                 ▼                                        │
│                      Signal + Evidence → DB                              │
└───────────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                    ORCHESTRATOR TOOLS (6 total)                          │
│  (src/orchestrator/tools.ts)                                             │
│                                                                          │
│  1. search_web        2. search_community   3. collect_trends            │
│  4. deepen_content    5. product_intel      6. ★ destripar_tecnologia ★ │
│                                                                          │
│  destripar_tecnologia: READ-only, risk:low, side_effects:none            │
│    input:  { text } | { url }                                            │
│    output: { techStack, webEquivalents, fichaSnippet, counts }           │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## Data flow

```
SIGNAL (rawSnippet)
   │
   ▼
┌──────────────────────────────────────────────────────────┐
│ clonakitProvider.extractTechMentions(snippet)           │
│                                                          │
│  Delegates to detectTechMentions() in                   │
│  capability-mapping.ts (word-boundary regex match       │
│  against the 61 framework names, case-insensitive).     │
│                                                          │
│  Returns: string[] of canonical PascalCase names.       │
│  Example: ['AVFoundation', 'CoreData']                   │
└──────────────────────────────────────────────────────────┘
   │
   ▼
┌──────────────────────────────────────────────────────────┐
│ clonakitProvider.validateCapabilities(mentioned)         │
│                                                          │
│  For each name: lookupCapability(name) → entry?         │
│    - found  → { framework, exists:true, purpose,        │
│                 web_equivalent, category }               │
│    - missing → { framework, exists:false }              │
│                                                          │
│  Deduplicates case-insensitively, preserves order.      │
│  Returns: ValidatedCapability[]                         │
└──────────────────────────────────────────────────────────┘
   │
   ▼
┌──────────────────────────────────────────────────────────┐
│ clonakitProvider.buildFichaSnippet(mentioned)            │
│                                                          │
│  Produces a markdown "Ficha técnica inicial":            │
│    ### Ficha técnica inicial (ClonaKit)                  │
│                                                          │
│    **Stack técnico detectado y validado:**               │
│    | Framework | Propósito | Equivalente web | Categoria │
│    | ...                                                │
│                                                          │
│    **Mencionados pero no validados:** (if any)           │
│    - `React`                                             │
│                                                          │
│    **Equivalentes web recomendados:**                    │
│    - IndexedDB                                           │
│    - localStorage                                        │
│                                                          │
│    > Generado automáticamente por el provider clonakit  │
└──────────────────────────────────────────────────────────┘
   │
   ▼
┌──────────────────────────────────────────────────────────┐
│ enrichSignalWithTech(signal) → EnrichedSignal            │
│                                                          │
│  Returns a NEW signal object (original not mutated) with:│
│    - techStack:        ValidatedCapability[]             │
│    - webEquivalents:   WebEquivalent[]                   │
│    - fichaSnippet:     string (markdown)                 │
│    - metadata.clonakit_enrichment: {                     │
│        techStack, webEquivalents, fichaSnippet,          │
│        mentionedCount, knownCount, unknownCount          │
│      } (persisted in SQLite as JSON blob)                │
└──────────────────────────────────────────────────────────┘
```

---

## Example: input signal + output enriched signal

### Input (RawItem from `web_search`)

```json
{
  "providerName": "web_search",
  "sourceType": "SEARCH_WEB",
  "snippet": "Slack's Mac app uses AVFoundation for video calls and CoreData for local message caching. The team also evaluated CoreML for smart replies.",
  "url": "https://example.com/slack-tech-stack",
  "title": "How Slack Built Their Mac App"
}
```

### After `normalizeRawItem(item, { topic: 'slack', geography: 'global' })`

The returned `signal` (abbreviated for clarity):

```jsonc
{
  "id": "sig_abc123",
  "topic": "slack",
  "source": "web_search",
  "sourceType": "SEARCH_WEB",
  "rawSnippet": "Slack's Mac app uses AVFoundation for video calls and CoreData for local message caching. The team also evaluated CoreML for smart replies.",
  "url": "https://example.com/slack-tech-stack",
  "signalType": "MENTION_SPIKE",
  "evidenceType": "OBSERVED",
  "confidence": 0.8,

  // --- Existing IMP-CLONA-3 enrichment (unchanged) ---
  "metadata": {
    "detected_tech": [
      { "framework": "AVFoundation", "purpose": "Grabar y reproducir audio y vídeo, usar la cámara", "web_equivalent": "getUserMedia() y las etiquetas <video>/<audio>", "count": 1 },
      { "framework": "CoreData",     "purpose": "Base de datos local",                                 "web_equivalent": "IndexedDB o localStorage",                       "count": 1 },
      { "framework": "CoreML",       "purpose": "Inteligencia artificial en el propio ordenador",      "web_equivalent": "TensorFlow.js, ONNX Runtime Web o una API de IA", "count": 1 }
    ],

    // --- NEW: FRENTE-B ClonaKit enrichment (persisted blob) ---
    "clonakit_enrichment": {
      "mentionedCount": 3,
      "knownCount": 3,
      "unknownCount": 0,
      "techStack": [
        { "framework": "AVFoundation", "exists": true, "purpose": "Grabar y reproducir audio y vídeo, usar la cámara", "web_equivalent": "getUserMedia() y las etiquetas <video>/<audio>", "category": "audio_video" },
        { "framework": "CoreData",     "exists": true, "purpose": "Base de datos local",                                 "web_equivalent": "IndexedDB o localStorage",                       "category": "data" },
        { "framework": "CoreML",       "exists": true, "purpose": "Inteligencia artificial en el propio ordenador",      "web_equivalent": "TensorFlow.js, ONNX Runtime Web o una API de IA", "category": "ai" }
      ],
      "webEquivalents": [
        { "framework": "AVFoundation", "web_equivalent": "getUserMedia() y las etiquetas <video>/<audio>", "category": "audio_video" },
        { "framework": "CoreData",     "web_equivalent": "IndexedDB o localStorage",                       "category": "data" },
        { "framework": "CoreML",       "web_equivalent": "TensorFlow.js, ONNX Runtime Web o una API de IA", "category": "ai" }
      ],
      "fichaSnippet": "### Ficha técnica inicial (ClonaKit)\n\n**Stack técnico detectado y validado:**\n\n| Framework | Propósito | Equivalente web | Categoría |\n|-----------|-----------|-----------------|-----------|\n| AVFoundation | Grabar y reproducir audio y vídeo, usar la cámara | getUserMedia() y las etiquetas <video>/<audio> | audio_video |\n| CoreData | Base de datos local | IndexedDB o localStorage | data |\n| CoreML | Inteligencia artificial en el propio ordenador | TensorFlow.js, ONNX Runtime Web o una API de IA | ai |\n\n**Equivalentes web recomendados:**\n\n- getUserMedia() y las etiquetas <video>/<audio>\n- IndexedDB\n- localStorage\n- TensorFlow.js, ONNX Runtime Web o una API de IA\n\n> Generado automáticamente por el provider `clonakit` a partir de 3 mencion(es) de framework(s). Mapping de referencia: 61 frameworks."
    }
  },

  // --- NEW: in-memory top-level fields (NOT persisted as columns; re-derived on load) ---
  "techStack": [/* same as metadata.clonakit_enrichment.techStack */],
  "webEquivalents": [/* same as metadata.clonakit_enrichment.webEquivalents */],
  "fichaSnippet": "### Ficha técnica inicial (ClonaKit)\n..."
}
```

### What the `destripar_tecnologia` tool returns for the same text

```jsonc
{
  "ok": true,
  "analysedText": "Slack's Mac app uses AVFoundation for video calls and CoreData...",
  "techStack": [
    { "framework": "AVFoundation", "exists": true, "web_equivalent": "getUserMedia() y las etiquetas <video>/<audio>", "category": "audio_video" },
    { "framework": "CoreData", "exists": true, "web_equivalent": "IndexedDB o localStorage", "category": "data" },
    { "framework": "CoreML", "exists": true, "web_equivalent": "TensorFlow.js, ONNX Runtime Web o una API de IA", "category": "ai" }
  ],
  "webEquivalents": [
    { "framework": "AVFoundation", "web_equivalent": "getUserMedia() y las etiquetas <video>/<audio>", "category": "audio_video" },
    { "framework": "CoreData", "web_equivalent": "IndexedDB o localStorage", "category": "data" },
    { "framework": "CoreML", "web_equivalent": "TensorFlow.js, ONNX Runtime Web o una API de IA", "category": "ai" }
  ],
  "fichaSnippet": "### Ficha técnica inicial (ClonaKit)\n\n...",
  "mentionedCount": 3,
  "knownCount": 3,
  "unknownCount": 0,
  "durationMs": 1
}
```

---

## Opt-out

The enrichment is **on by default**. Three ways to disable:

1. **Per-call (NormalizeContext)**: `normalizeRawItem(item, { topic, geography, clonakit_enrichment: false })`.
2. **Environment variable**: `CHISMOSO_CLONAKIT_ENRICHMENT=false` (also `0`, `no`, `off`).
3. **Config override**: `resolveConfig({ clonakit_enrichment: false })`.

When disabled, the normalizer skips `enrichSignalWithTech()` entirely. The existing `detected_tech` pass still runs (it's independent), but no `clonakit_enrichment` blob is produced.

---

## Files touched (Task FRENTE-B-CHISMOSO-CLONAKIT)

| File | Action | Purpose |
|------|--------|---------|
| `src/providers/clonakit.ts` | NEW | The `ClonaKitProvider` class implementing `IProvider` + the three helper methods (`extractTechMentions`, `validateCapabilities`, `buildFichaSnippet`). Exports a module-level singleton `clonakitProvider`. |
| `src/intelligence/tech-enricher.ts` | NEW | `enrichSignalWithTech(signal)` + `enrichSignalsWithTech(signals, enabled)` + `EnrichedSignal` type. The hook called by the normalizer. |
| `src/intelligence/normalizer.ts` | MODIFY | Added `clonakit_enrichment?: boolean` to `NormalizeContext`. After the existing `detectTechMentions` step, calls `enrichSignalWithTech(signal)` (gated by the flag, default on). Returns the enriched signal. |
| `src/providers/index.ts` | MODIFY | Registered `ClonaKitProvider` in `createDefaultProviderRegistry()`. Exported it from the barrel. |
| `src/orchestrator/tools.ts` | MODIFY | Added the `destriparTecnologiaTool` (tool #6). Registered it in `createDefaultToolRegistry()`. |
| `src/config/index.ts` | MODIFY | Added `clonakit_enrichment: boolean` to `ChismosoConfig` (default `true`, env `CHISMOSO_CLONAKIT_ENRICHMENT`). |
| `src/intelligence/index.ts` | MODIFY | Re-exported `tech-enricher.js` from the intelligence barrel. |
| `tests/clonakit-provider.test.ts` | NEW | 58 unit tests covering the provider, enricher, normalizer integration, the tool, and the registries. |
| `README.md` | MODIFY | Added `ClonaKitProvider` to the providers table. Added a "ClonaKit Integration" section explaining the enrichment, the tool, and the opt-out. |
| `docs/CLONAKIT_INTEGRATION.md` | NEW | This document. |

---

## Supported frameworks (61 entries, 11 categories)

> **Note**: the code comment in `capability-mapping.ts` says "57 entries" — that comment is slightly outdated. The actual table has **61 entries** across 11 categories (the `storage` category is reserved but empty). `CAPABILITY_COUNT` returns the accurate number (61).

### audio_video (11)

| Framework | Propósito | Equivalente web |
|-----------|-----------|-----------------|
| AVFoundation | Grabar y reproducir audio y vídeo, usar la cámara | getUserMedia() y las etiquetas `<video>`/`<audio>` |
| AVKit | Reproductor de vídeo | `<video controls>` |
| ScreenCaptureKit | Capturar la pantalla o ventanas | getDisplayMedia() |
| CoreAudio | Audio de bajo nivel (micrófonos, altavoces) | Web Audio API |
| AudioUnit | Efectos y procesado de audio | Web Audio API (AudioWorklet) |
| AudioToolbox | Codificar y reproducir audio | Web Audio API o MediaRecorder |
| CoreMedia | Manejar fotogramas y muestras de audio/vídeo | MediaStream o WebCodecs |
| CoreMediaIO | Cámaras virtuales y dispositivos de vídeo | getUserMedia() (en web no se pueden crear cámaras virtuales) |
| CoreVideo | Imágenes de vídeo en memoria | `<canvas>` o WebCodecs (VideoFrame) |
| VideoToolbox | Comprimir vídeo con el chip del ordenador (H.264/HEVC) | MediaRecorder o WebCodecs (VideoEncoder) |
| Speech | Reconocimiento de voz | Web Speech API |

### graphics (16)

| Framework | Propósito | Equivalente web |
|-----------|-----------|-----------------|
| Metal | Gráficos y cálculo en la tarjeta gráfica (GPU) | WebGL o WebGPU |
| MetalKit | Gráficos en la GPU | WebGL o WebGPU |
| OpenGL | Gráficos 2D/3D en la GPU (tecnología antigua) | WebGL |
| CoreGraphics | Dibujo 2D, pantallas y ventanas | `<canvas>` 2D o SVG |
| CoreImage | Filtros de imagen | Filtros CSS, `<canvas>` o WebGL |
| ImageIO | Leer y guardar imágenes | `<img>`, createImageBitmap() y canvas.toBlob() |
| QuartzCore | Animaciones de la interfaz | Animaciones CSS o Web Animations API |
| CoreText | Tipografía | Fuentes CSS (@font-face) |
| ColorSync | Gestión del color | Colores CSS y colorSpace del canvas |
| PDFKit | Ver y editar PDF | PDF.js |
| QuickLook | Vistas previas de archivos | `<img>`, `<iframe>` o PDF.js |
| QuickLookThumbnailing | Miniaturas de archivos | `<canvas>` o `<img>` |
| SpriteKit | Juegos 2D | `<canvas>` o Phaser |
| SceneKit | Gráficos 3D | three.js |
| IOSurface | Compartir imágenes entre procesos o con la GPU | No aplica en web |
| Accelerate | Cálculo matemático rápido | JavaScript o WebAssembly |

### ui (6)

| Framework | Propósito | Equivalente web |
|-----------|-----------|-----------------|
| AppKit | Interfaz nativa de Mac (ventanas, menús, botones) | HTML + CSS |
| Cocoa | Interfaz nativa de Mac (ventanas, menús, botones) | HTML + CSS |
| SwiftUI | Interfaz moderna de Apple | HTML + CSS (o React, Vue…) |
| WebKit | Mostrar páginas web dentro de la app | Un `<iframe>` o la propia web |
| JavaScriptCore | Ejecutar JavaScript dentro de la app | El JavaScript del navegador |
| UniformTypeIdentifiers | Tipos de archivo | `<input type="file" accept="…">` |

### data (5)

| Framework | Propósito | Equivalente web |
|-----------|-----------|-----------------|
| Foundation | Base de cualquier app de Apple (texto, fechas, archivos) | JavaScript estándar |
| CoreFoundation | Base de cualquier app de Apple (texto, fechas, archivos) | JavaScript estándar |
| CoreData | Base de datos local | IndexedDB o localStorage |
| CloudKit | Sincronizar datos en iCloud | Un backend (Supabase, Firebase…) |
| Combine | Reaccionar a cambios de datos | Eventos y promesas de JavaScript |

### network (3)

| Framework | Propósito | Equivalente web |
|-----------|-----------|-----------------|
| Network | Conexiones de red | fetch() o WebSocket |
| CFNetwork | Conexiones de red | fetch() o WebSocket |
| SystemConfiguration | Estado de la conexión a internet | navigator.onLine |

### security (3)

| Framework | Propósito | Equivalente web |
|-----------|-----------|-----------------|
| Security | Llavero, certificados y cifrado | Web Crypto API (las contraseñas, mejor en un servidor) |
| LocalAuthentication | Touch ID / Face ID | WebAuthn (passkeys) |
| AuthenticationServices | Iniciar sesión con Apple o passkeys | WebAuthn u OAuth |

### hardware (3)

| Framework | Propósito | Equivalente web |
|-----------|-----------|-----------------|
| CoreBluetooth | Bluetooth | Web Bluetooth (solo Chrome) |
| IOKit | Hardware: USB, energía, dispositivos | WebUSB o WebHID (limitado) |
| GameController | Mandos de juego | Gamepad API |

### ai (3)

| Framework | Propósito | Equivalente web |
|-----------|-----------|-----------------|
| CoreML | Inteligencia artificial en el propio ordenador | TensorFlow.js, ONNX Runtime Web o una API de IA |
| Vision | Reconocer texto, caras u objetos en imágenes | Tesseract.js o una API de IA |
| NaturalLanguage | Analizar texto | Una API de IA |

### system (5)

| Framework | Propósito | Equivalente web |
|-----------|-----------|-----------------|
| DiskArbitration | Detectar discos conectados | No disponible en web |
| ApplicationServices | Accesibilidad, eventos y control de otras apps | No disponible en web (los atajos solo funcionan con la pestaña activa) |
| Carbon | APIs antiguas de Mac (p. ej. atajos de teclado globales) | No disponible en web |
| ServiceManagement | Arrancar al iniciar sesión o lanzar ayudantes | No aplica en web |
| SystemExtensions | Extensiones del sistema (p. ej. cámara virtual) | No disponible en web |

### location (2)

| Framework | Propósito | Equivalente web |
|-----------|-----------|-----------------|
| CoreLocation | Ubicación | navigator.geolocation |
| MapKit | Mapas | Leaflet + OpenStreetMap |

### media (4)

| Framework | Propósito | Equivalente web |
|-----------|-----------|-----------------|
| Contacts | Contactos del usuario | Un formulario propio (la web no puede leer tus contactos) |
| EventKit | Calendario y recordatorios | Archivos .ics o la API de Google Calendar |
| UserNotifications | Notificaciones | Notifications API |
| StoreKit | Compras dentro de la app | Stripe u otra pasarela de pago web |

### storage (0)

Reserved for future use — no entries yet.

---

## Boundary (clean-room)

This provider is **pure and local**:

- It reads ONLY from the static `CAPABILITY_MAPPING` in `src/intelligence/capability-mapping.ts`.
- It NEVER calls out to ClonaKit's binary tools (REA, etc.) — that's a separate integration, see [`CLONAKIT-INTEGRATION.md`](./CLONAKIT-INTEGRATION.md).
- It NEVER reads source code, assets, or binaries from any product.
- It NEVER hits the network.

The enrichment is a pure function of `(signal.rawSnippet, CAPABILITY_MAPPING)` — same input always produces the same output, no side effects, no non-determinism.

For the CHISMOSO-wide clean-room commitment, see [`docs/CLEAN-ROOM.md`](./CLEAN-ROOM.md).

---

## Testing

The test suite (`tests/clonakit-provider.test.ts`, 58 tests) covers:

1. **Provider surface** — capabilities, health, canHandle, search (positive + negative + empty query + num cap).
2. **extractTechMentions** — case-insensitive, dedup, word-boundary, empty input, the "React is NOT in the mapping" case.
3. **validateCapabilities** — known + unknown + mixed, case-insensitive canonicalisation, dedup, every-framework round-trip.
4. **buildFichaSnippet** — markdown structure, unknown section, footer count, empty input.
5. **enrichSignalWithTech** — enrichment + persistence blob + no-mutation + fast path (same reference when no mentions).
6. **enrichSignalsWithTech** — batch + disabled flag + empty batch.
7. **normalizeRawItem integration** — default-on + explicit-true + explicit-false + no-tech-mentions + existing-behaviour-preserved.
8. **destripar_tecnologia tool** — text input + url input + error cases + stored signal lookup + empty result.
9. **Registries** — ClonaKit in provider registry + destripar_tecnologia in tool registry + describe() output.
10. **Singleton** — `clonakitProvider` is an instance + has the same behaviour as a fresh instance.

Run them with:

```bash
cd chismoso && npx vitest run tests/clonakit-provider.test.ts
```

---

## Future extensions

- **Extend the mapping**: operators can add entries to `CAPABILITY_MAPPING` in `src/intelligence/capability-mapping.ts` — the provider, enricher, and tool all pick them up automatically (the `LOWERCASE_INDEX` is rebuilt at module load).
- **New SourceType**: currently signals from `clonakit.search()` reuse `SourceType.WEB_CONTENT`. If a future version wants to distinguish them, add a `TECH_INTEL` value to the `SourceType` enum and update `inferSignalType` + the DB schema.
- **LLM-assisted ficha**: the current `buildFichaSnippet` is deterministic (markdown table from the mapping). A future version could pass the validated stack to the LLM to produce a richer, narrative ficha — the `destripar_tecnologia` tool would then call the LLM with the validated stack as context.
