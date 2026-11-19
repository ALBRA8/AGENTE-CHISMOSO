# Inicio rapido — Doble click y listo

CHISMOSO incluye lanzadores para que lo arranques con **doble click** sin tocar la terminal.

> **Version actual:** V1.0
> **Stack:** Dashboard Next.js 16 + chismoso/ CLI (Node 20 LTS o 22 LTS, TypeScript 5)
> **Repo:** https://github.com/ALBRA8/AGENTE-CHISMOSO

---

## Requisitos previos (solo la primera vez)

1. **Node.js 20 LTS o 22 LTS** desde https://nodejs.org/ (incluye npm automaticamente).
   - CHISMOSO requiere Node >= 20.0.0 (ver `chismoso/package.json` > `engines`).
   - No recomendamos Node 23/24 para Windows: algunas dependencias nativas
     (`better-sqlite3`, `tesseract.js`) pueden no tener binarios precompilados
     para las versiones mas recientes y forzarian una compilacion desde cero.
2. **Clonar el repo**:
   ```
   git clone https://github.com/ALBRA8/AGENTE-CHISMOSO.git
   ```
3. **(Solo Windows) Visual Studio Build Tools** — `better-sqlite3` es un
   modulo nativo de C++. Si el instalador de npm no encuentra un binario
   precompilado para tu combinacion exacta de Node + Windows, compilara
   desde el fuente y necesitara:
   - **Python 3.10+** (disponible en `PATH`).
   - **Visual Studio Build Tools 2022** con el workload
     *"Desktop development with C++"* (incluye MSBuild y el SDK de Windows).
   - Descarga: https://visualstudio.microsoft.com/visual-cpp-build-tools/
   - Si prefieres evitar la compilacion, ejecuta:
     ```
     npm install --build-from-source
     ```
     dentro de `chismoso/` y de la raiz del dashboard.

Eso es todo. Node + (opcionalmente) Build Tools son lo unico que necesitas
instalar manualmente.

---

## Instalacion paso a paso

### Windows
```
git clone https://github.com/ALBRA8/AGENTE-CHISMOSO.git
cd AGENTE-CHISMOSO
npm install
cd chismoso
npm install --no-audit --no-fund
cd ..
npx tsc --noEmit       # opcional: typecheck del dashboard
cd chismoso && npx tsc --noEmit && cd ..   # opcional: typecheck del motor
```

### macOS / Linux
```
git clone https://github.com/ALBRA8/AGENTE-CHISMOSO.git
cd AGENTE-CHISMOSO
npm install
cd chismoso && npm install --no-audit --no-fund && cd ..
```

> **Gestor de paquetes:**
> - El **dashboard raiz** mantiene `bun.lock` y se sirve con `bun` para el
>   dev server de Next.js (`bun run dev`). El instalador de npm tambien
>   funciona (`npm install` genera `package-lock.json`) — ambos son
>   validos, pero la cadena de CI usa bun para la raiz.
> - El **subproyecto `chismoso/`** se mantiene con **npm**
>   (`chismoso/package-lock.json`). Eliminamos `chismoso/bun.lock` para que
>   los usuarios de Windows tengan una sola fuente de verdad (npm es el
>   gestor documentado para Windows).

---

## Como arrancar

### Windows
- **Modo silencioso (Recomendado):** doble click sobre `INICIAR-CHISMOSO.vbs`
  - Cero consolas negras flotando en tu pantalla.
  - Si es la primera vez, abrira el instalador visible para preparar dependencias.
  - Una vez instalado, arranca en segundo plano y abre tu navegador automaticamente.
- **Modo consola tradicional:** doble click sobre `start.bat`
- **Crear acceso directo en el Escritorio:** doble click en `CREAR-ACCESO-DIRECTO.bat`

### macOS
- Doble click sobre `start.command` desde Finder
- La primera vez, macOS te va a preguntar si confias en el desarrollador → Allow

### Linux
- Doble click sobre `start.sh` (asegurate de tener permiso de ejecucion: `chmod +x start.sh`)

---

## Como detener el servidor

- **En Windows:** doble click sobre `DETENER-CHISMOSO.bat` (o `DETENER-CHISMOSO.vbs`).
- **Si usaste start.bat:** presiona `Ctrl+C` en la ventana de terminal o cierrala.

---

## Probar el motor CHISMOSO (CLI)

Despues de `npm install` dentro de `chismoso/`, puedes ejecutar los comandos
del motor directamente desde una terminal:

```
cd chismoso
npx tsc                       # compila a dist/
node dist/cli.js doctor       # chequeo de salud (14 subsistemas)
node dist/cli.js providers    # lista de providers y su estado
node dist/cli.js demo         # investigacion canonica de ejemplo
```

Para correr la suite de pruebas del motor:

```
cd chismoso
npm test
```

---

## Providers externos (recomendado)

A partir de V1.0, el motor funciona al 100% con providers externos **sin**
necesidad del SDK interno `z-ai-web-dev-sdk`. Configura al menos UNA key
de busqueda y UNA key de LLM en tu archivo `.env` (copia `.env.example`):

**Busqueda web** (al menos una):
- `SERPER_API_KEY` (Serper.dev — busqueda en Google)
- `TAVILY_API_KEY` (Tavily)
- `BRAVE_API_KEY` (Brave Search)

**LLM** (al menos una):
- `NVIDIA_API_KEY` (NVIDIA integrate)
- `GROQ_API_KEY` (Groq)
- `OPENAI_API_KEY` (OpenAI)

Si no configuras ninguna key Y tampoco esta instalado el SDK, el motor
lanza un error claro que lista exactamente que variables configurar.

---

## Problemas?

| Problema | Solucion |
|---|---|
| "Node.js no esta instalado" | Instalo desde https://nodejs.org/ (version 20 LTS o 22 LTS) |
| "Error al instalar dependencias" | Verifica tu conexion a internet. Borra `node_modules/` y vuelve a intentar. |
| `better-sqlite3` falla al compilar en Windows | Instala Visual Studio Build Tools 2022 con el workload "Desktop development with C++" + Python 3, o ejecuta `npm install --build-from-source` dentro de `chismoso/` |
| Puerto 3000 ocupado | Cierra otros procesos que lo usen, o edita `start.bat`/`start.command` para usar otro puerto |
| El navegador no se abre | Abre manualmente la URL que muestra el Preview Panel |
| z-ai-web-dev-sdk no encontrado | Es un SDK interno de Z.ai, ahora OPCIONAL. Configura providers externos (Serper/Tavily/Brave + Groq/NVIDIA/OpenAI) en `.env` y el motor funcionara sin el SDK. Si lo tienes en `~/.bun/install/global/node_modules/z-ai-web-dev-sdk`, el script lo copia automaticamente. |
| Error raro en consola | Revisa el log completo. Si es un 429, la cuota del LLM esta saturada — espera 10-15 min y reintenta. |

---

## Shortcut extra (opcional)

Si quieres un acceso directo en el escritorio:

### Windows
1. Click derecho sobre `start.bat` → "Enviar a" → "Escritorio (crear acceso directo)"

### macOS
1. Arrastra `start.command` al Dock (se ejecutara con un solo click desde ahi)

### Linux
1. Crea un archivo `.desktop` en `~/.local/share/applications/`:
   ```
   [Desktop Entry]
   Name=CHISMOSO
   Exec=/ruta/al/repo/start.sh
   Icon=utilities-terminal
   Type=Application
   ```

---

**Estado del repo:** https://github.com/ALBRA8/AGENTE-CHISMOSO
**Version actual:** V1.0
