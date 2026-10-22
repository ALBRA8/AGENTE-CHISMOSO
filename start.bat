@echo off
chcp 65001 >nul
title CHISMOSO - Inicio automatico
setlocal enabledelayedexpansion

REM ============================================================================
REM  CHISMOSO - Doble click para arrancar (Windows)
REM  - Verifica Node
REM  - Instala dependencias si falta node_modules
REM  - Compila TypeScript si falta dist/
REM  - Levanta el dev server en http://localhost:3000
REM  - Abre el navegador automaticamente
REM ============================================================================

cd /d "%~dp0"

echo.
echo ============================================================
echo   CHISMOSO - Agente de inteligencia de senales
echo ============================================================
echo.

REM --- Verificar Node.js ---
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js no esta instalado.
  echo.
  echo Descargalo de: https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi
  echo Instalalo y vuelve a ejecutar este archivo.
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODE_VER=%%v
echo [OK] Node.js detectado: %NODE_VER%

REM --- Verificar npm ---
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm no esta instalado. Instala Node.js completo desde https://nodejs.org
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('npm -v') do set NPM_VER=%%v
echo [OK] npm detectado: %NPM_VER%

REM --- Verificar bun (opcional, mas rapido) ---
where bun >nul 2>nul
if errorlevel 1 (
  set USE_BUN=0
) else (
  set USE_BUN=1
  for /f "tokens=*" %%v in ('bun -v') do set BUN_VER=%%v
  echo [OK] bun detectado: !BUN_VER!
)

echo.

REM --- Instalar dependencias del root si faltan ---
if not exist "node_modules" (
  echo [..] Instalando dependencias del dashboard ^(esto tarda ~2 min la primera vez^)
  if "!USE_BUN!"=="1" (
    bun install
  ) else (
    npm install --no-audit --no-fund
  )
  if errorlevel 1 (
    echo [ERROR] Fallo la instalacion de dependencias del root.
    pause
    exit /b 1
  )
  echo [OK] Dependencias del dashboard instaladas
) else (
  echo [OK] Dependencias del dashboard ya instaladas
)

REM --- Instalar dependencias de chismoso si faltan ---
if not exist "chismoso\node_modules" (
  echo [..] Instalando dependencias del agente CHISMOSO ^(~1 min^)
  pushd chismoso
  if "!USE_BUN!"=="1" (
    bun install
  ) else (
    npm install --no-audit --no-fund
  )
  if errorlevel 1 (
    echo [ERROR] Fallo la instalacion de dependencias de chismoso.
    popd
    pause
    exit /b 1
  )
  popd
  echo [OK] Dependencias de chismoso instaladas
) else (
  echo [OK] Dependencias de chismoso ya instaladas
)

REM --- Compilar TypeScript del agente si falta dist ---
if not exist "chismoso\dist\cli.js" (
  echo [..] Compilando agente CHISMOSO ^(TypeScript -^> JavaScript^)
  pushd chismoso
  call npx tsc
  if errorlevel 1 (
    echo [WARN] Hubo warnings en la compilacion, pero el CLI deberia funcionar igual.
  )
  popd
  if not exist "chismoso\dist\cli.js" (
    echo [ERROR] No se pudo compilar CHISMOSO.
    pause
    exit /b 1
  )
  echo [OK] CHISMOSO compilado
) else (
  echo [OK] CHISMOSO ya compilado
)

REM --- Crear data dir si no existe ---
if not exist "chismoso\data" mkdir "chismoso\data"
if not exist "download\chismoso" mkdir "download\chismoso"

REM --- Inicializar DB con doctor si no existe ---
if not exist "chismoso\data\chismoso.db" (
  echo [..] Inicializando base de datos ^(primera vez^)
  pushd chismoso
  node dist\cli.js doctor --fix >nul 2>nul
  popd
  echo [OK] Base de datos inicializada
)

echo.
echo ============================================================
echo   TODO LISTO - Levantando servidor
echo ============================================================
echo.
echo   Dashboard:  http://localhost:3000
echo   Health:     http://localhost:3000/api/health
echo   Providers:  http://localhost:3000/api/providers
echo   Chat agent: botan "Hablar con CHISMOSO" abajo-derecha
echo.
echo   Para detener: cierra esta ventana o presiona Ctrl+C
echo ============================================================
echo.

REM --- Abrir navegador despues de 5 segundos ---
start "" cmd /c "timeout /t 5 /nobreak >nul && start http://localhost:3000"

REM --- Levantar el dev server (bloquea hasta Ctrl+C) ---
echo "[..] Iniciando Next.js dev server..."
if "!USE_BUN!"=="1" (
  bun run dev
) else (
  npm run dev
)

REM Si llegamos aqui, el server se cerro
echo.
echo [INFO] Servidor detenido. Presiona cualquier tecla para cerrar.
pause >nul
