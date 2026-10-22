# 🚀 Inicio rápido — Doble click y listo

CHISMOSO incluye lanzadores para que lo arranques con **doble click** sin tocar la terminal.

## Prerrequisitos (solo la primera vez)

1. **Instalar Node.js 20+** desde https://nodejs.org/ (incluye npm automáticamente)
2. **Clonar el repo**:
   ```
   git clone https://github.com/ALBRA8/AGENTE-CHISMOSO.git
   ```

Eso es todo. Node es lo único que necesitas instalado manualmente.

## Cómo arrancar

### Windows
- **Doble click** sobre `start.bat`

### macOS
- **Doble click** sobre `start.command` desde Finder
- La primera vez, macOS te va a preguntar si confías en el desarrollador → Allow

### Linux
- Doble click sobre `start.sh` (asegúrate de tener permiso de ejecución: `chmod +x start.sh`)

## ¿Qué hace el lanzador automáticamente?

1. Verifica que Node.js esté instalado
2. Instala las dependencias del dashboard (si faltan)
3. Instala las dependencias de CHISMOSO (si faltan)
4. Compila TypeScript → JavaScript (si falta `dist/`)
5. Crea el directorio `data/` si no existe
6. Inicializa la base de datos con `chismoso doctor --fix`
7. Levanta el servidor Next.js en `http://localhost:3000`
8. Abre el navegador automáticamente a los 5 segundos

## Después de que arranque

- Abre http://localhost:3000 (o se abre solo)
- Verás el dashboard con el botón flotante **"Hablar con CHISMOSO"** abajo a la derecha
- Click en él → se abre el chat conversacional
- O escribe un objetivo y dale a **"Investigar en vivo"**

## Detener el servidor

- Cierra la ventana negra (terminal) que se abrió, o
- Presiona `Ctrl+C` en esa ventana

## ¿Problemas?

| Problema | Solución |
|---|---|
| "Node.js no está instalado" | Instálalo desde https://nodejs.org/ |
| "Error al instalar dependencias" | Verifica tu conexión a internet. Borra `node_modules/` y vuelve a intentar. |
| Puerto 3000 ocupado | Cierra otros procesos que lo usen, o edita `start.bat`/`start.command` para usar otro puerto |
| El navegador no se abre | Abre manualmente http://localhost:3000 |
| z-ai-web-dev-sdk no encontrado | Es un SDK interno de Z.ai. Si lo tienes en `~/.bun/install/global/node_modules/z-ai-web-dev-sdk`, el script lo copia automáticamente. Si no, pídelo a tu admin. |
| Error raro en consola | Revisa el log completo. Si es un 429, la cuota del LLM está saturada — espera 10-15 min y reintenta. |

## Shortcut extra (opcional)

Si quieres un acceso directo en el escritorio:

### Windows
1. Click derecho sobre `start.bat` → "Enviar a" → "Escritorio (crear acceso directo)"

### macOS
1. Arrastra `start.command` al Dock (se ejecutará con un solo click desde ahí)

### Linux
1. Crea un archivo `.desktop` en `~/.local/share/applications/`:
   ```
   [Desktop Entry]
   Name=CHISMOSO
   Exec=/ruta/al/repo/start.sh
   Icon=utilities-terminal
   Type=Application
   ```

## ¿Quieres el acceso directo en el escritorio automáticamente?

Si muchos usuarios lo piden, puedo añadir un `crear-acceso-directo.bat` que lo haga. Por ahora, sigan los pasos de arriba.

---

**Estado del repo**: https://github.com/ALBRA8/AGENTE-CHISMOSO  
**Última versión**: V1.5 (commit `731f76b`)
