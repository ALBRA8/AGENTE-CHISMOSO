' ============================================================
'  CHISMOSO - INICIO SILENCIOSO (doble click, cero ventanas)
'  - Si el entorno ya esta instalado: lanza el servidor OCULTO
'    y abre el navegador cuando responde (sin terminal).
'  - Si es la primera vez: abre el asistente visible una unica vez.
' ============================================================
Option Explicit
Dim fso, sh, carpeta, raiz, nodeModules, distCli

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

' Detectar raiz del proyecto (funciona tanto en la raiz como dentro de launchers\)
If fso.FileExists(fso.GetParentFolderName(WScript.ScriptFullName) & "\package.json") Then
    raiz = fso.GetParentFolderName(WScript.ScriptFullName)
ElseIf fso.FileExists(fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)) & "\package.json") Then
    raiz = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
Else
    raiz = fso.GetParentFolderName(WScript.ScriptFullName)
End If

carpeta = raiz
sh.CurrentDirectory = carpeta

nodeModules = carpeta & "\node_modules"
distCli = carpeta & "\chismoso\dist\cli.js"

' Verificamos si ya esta instalado y compilado
If fso.FolderExists(nodeModules) And fso.FileExists(distCli) Then
    ' Ruta silenciosa: ventana oculta (0), sin esperar (False)
    sh.Run "node launchers\lanzador_chismoso.js", 0, False
Else
    ' Primera vez: asistente visible (instala dependencias + compila + arranca)
    sh.Run "cmd /c """ & carpeta & "\start.bat""", 1, False
End If
