@echo off
setlocal EnableExtensions
chcp 65001 >nul
title CHISMOSO - Crear Acceso Directo en el Escritorio

echo.
echo ============================================================
echo   CHISMOSO - Creando Acceso Directo en el Escritorio
echo ============================================================
echo.

set "SCRIPT_DIR=%~dp0"
set "TARGET=%SCRIPT_DIR%INICIAR-CHISMOSO.vbs"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $desktop = [System.Environment]::GetFolderPath('Desktop'); $s = $ws.CreateShortcut(\"$desktop\CHISMOSO.lnk\"); $s.TargetPath = '%TARGET%'; $s.WorkingDirectory = '%SCRIPT_DIR%'; $s.Description = 'Iniciar Agente CHISMOSO'; $s.Save()"

echo.
echo [OK] Acceso directo 'CHISMOSO' creado en tu Escritorio con exito.
echo      Ahora puedes abrir CHISMOSO con solo hacer doble click desde tu Escritorio.
echo.
pause
