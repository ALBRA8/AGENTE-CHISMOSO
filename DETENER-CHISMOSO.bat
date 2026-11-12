@echo off
setlocal EnableExtensions
chcp 65001 >nul
title CHISMOSO - Detener Servidor

echo.
echo ============================================================
echo   CHISMOSO - Detener Servidor (Puerto 3000)
echo ============================================================
echo.
echo [..] Buscando y cerrando procesos activos en el puerto 3000...

powershell -NoProfile -ExecutionPolicy Bypass -Command "$pids = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; if ($pids) { foreach ($p in $pids) { try { Stop-Process -Id $p -Force -PassThru -ErrorAction SilentlyContinue | Out-Null; Write-Host ('[OK] Proceso PID ' + $p + ' detenido exitosamente.') -ForegroundColor Green } catch {} } } else { Write-Host '[INFO] No se encontro ningun servidor corriendo en el puerto 3000.' -ForegroundColor Yellow }"

echo.
echo ============================================================
echo   CHISMOSO quedo detenido.
echo   Para volver a arrancar: doble click en INICIAR-CHISMOSO.vbs
echo ============================================================
echo.
pause
