' ============================================================
'  CHISMOSO - DETENER SILENCIOSO
'  Detiene el proceso en el puerto 3000 sin mostrar consola.
' ============================================================
Option Explicit
Dim sh
Set sh = CreateObject("WScript.Shell")

Dim cmd
cmd = "powershell -NoProfile -ExecutionPolicy Bypass -Command ""Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { try { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } catch {} }"""

sh.Run cmd, 0, True
