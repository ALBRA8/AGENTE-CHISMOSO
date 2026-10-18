#!/bin/bash
# ============================================================================
#  CHISMOSO - Doble click para arrancar (macOS / Linux)
#  En Mac: doble click sobre este archivo desde Finder
#  En Linux: doble click (asegurate de darle permiso de ejecucion)
#  - Verifica Node
#  - Instala dependencias si falta node_modules
#  - Compila TypeScript si falta dist/
#  - Levanta el dev server en http://localhost:3000
#  - Abre el navegador automaticamente
# ============================================================================

set -e

# Cambiar al directorio donde vive este script
cd "$(dirname "$0")"

echo ""
echo "============================================================"
echo "  CHISMOSO - Agente de inteligencia de senales"
echo "============================================================"
echo ""

# --- Verificar Node.js ---
if ! command -v node &>/dev/null; then
  echo "[ERROR] Node.js no esta instalado."
  echo ""
  echo "  Mac:    brew install node     (https://brew.sh)"
  echo "  Linux:  sudo apt install nodejs npm"
  echo "  O descarga desde: https://nodejs.org/"
  echo ""
  read -p "Presiona Enter para cerrar..."
  exit 1
fi
NODE_VER=$(node -v)
echo "[OK] Node.js detectado: $NODE_VER"

# --- Verificar npm ---
if ! command -v npm &>/dev/null; then
  echo "[ERROR] npm no esta instalado. Instala Node.js completo."
  read -p "Presiona Enter para cerrar..."
  exit 1
fi
NPM_VER=$(npm -v)
echo "[OK] npm detectado: $NPM_VER"

# --- Verificar bun (opcional, mas rapido) ---
USE_BUN=0
if command -v bun &>/dev/null; then
  USE_BUN=1
  BUN_VER=$(bun -v)
  echo "[OK] bun detectado: $BUN_VER (se usara para instalar mas rapido)"
fi

echo ""

# --- Instalar dependencias del root si faltan ---
if [ ! -d "node_modules" ]; then
  echo "[..] Instalando dependencias del dashboard (tarda ~2 min la primera vez)"
  if [ "$USE_BUN" = "1" ]; then
    bun install
  else
    npm install --no-audit --no-fund
  fi
  echo "[OK] Dependencias del dashboard instaladas"
else
  echo "[OK] Dependencias del dashboard ya instaladas"
fi

# --- Instalar dependencias de chismoso si faltan ---
if [ ! -d "chismoso/node_modules" ]; then
  echo "[..] Instalando dependencias del agente CHISMOSO (~1 min)"
  pushd chismoso >/dev/null
  if [ "$USE_BUN" = "1" ]; then
    bun install
  else
    npm install --no-audit --no-fund
  fi
  popd >/dev/null
  echo "[OK] Dependencias de chismoso instaladas"
else
  echo "[OK] Dependencias de chismoso ya instaladas"
fi

# --- Compilar TypeScript del agente si falta dist ---
if [ ! -f "chismoso/dist/cli.js" ]; then
  echo "[..] Compilando agente CHISMOSO (TypeScript -> JavaScript)"
  pushd chismoso >/dev/null
  npx tsc || echo "[WARN] Hubo warnings en la compilacion, pero el CLI deberia funcionar igual."
  popd >/dev/null
  if [ ! -f "chismoso/dist/cli.js" ]; then
    echo "[ERROR] No se pudo compilar CHISMOSO."
    read -p "Presiona Enter para cerrar..."
    exit 1
  fi
  echo "[OK] CHISMOSO compilado"
else
  echo "[OK] CHISMOSO ya compilado"
fi

# --- Crear dirs de datos si no existen ---
mkdir -p chismoso/data
mkdir -p download/chismoso

# --- Inicializar DB con doctor si no existe ---
if [ ! -f "chismoso/data/chismoso.db" ]; then
  echo "[..] Inicializando base de datos (primera vez)"
  pushd chismoso >/dev/null
  node dist/cli.js doctor --fix >/dev/null 2>&1 || true
  popd >/dev/null
  echo "[OK] Base de datos inicializada"
fi

echo ""
echo "============================================================"
echo "  TODO LISTO - Levantando servidor"
echo "============================================================"
echo ""
echo "  Dashboard:  http://localhost:3000"
echo "  Health:     http://localhost:3000/api/health"
echo "  Providers:  http://localhost:3000/api/providers"
echo "  Chat agent: boton \"Hablar con CHISMOSO\" abajo-derecha"
echo ""
echo "  Para detener: cierra esta ventana o presiona Ctrl+C"
echo "============================================================"
echo ""

# --- Abrir navegador despues de 5 segundos (en background) ---
(
  sleep 5
  if command -v open &>/dev/null; then
    open http://localhost:3000           # macOS
  elif command -v xdg-open &>/dev/null; then
    xdg-open http://localhost:3000       # Linux
  fi
) &

# --- Levantar el dev server (bloquea hasta Ctrl+C) ---
echo "[..] Iniciando Next.js dev server..."
if [ "$USE_BUN" = "1" ]; then
  bun run dev
else
  npm run dev
fi

echo ""
echo "[INFO] Servidor detenido. Presiona Enter para cerrar."
read -r
