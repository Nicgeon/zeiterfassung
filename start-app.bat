@echo off
rem Startet die Zeiterfassung als Programm (lokal). Normalerweise ueber Zeiterfassung.vbs (ohne Konsolenfenster).
cd /d "%~dp0"

rem Node.js suchen: zuerst im PATH, dann in typischen Benutzerordnern (wie in start-local.bat)
where node >nul 2>nul
if errorlevel 1 (
  if defined NODE_HOME if exist "%NODE_HOME%\node.exe" set "PATH=%NODE_HOME%;%PATH%"
)
where node >nul 2>nul
if errorlevel 1 (
  for /d %%D in ("%USERPROFILE%\node-v*-win-x64" "%USERPROFILE%\node" "%LOCALAPPDATA%\Programs\nodejs" "%~dp0node-v*-win-x64") do (
    if exist "%%~D\node.exe" set "PATH=%%~D;%PATH%"
  )
)
where node >nul 2>nul
if errorlevel 1 (
  powershell -NoProfile -Command "Add-Type -AssemblyName PresentationFramework; [void][System.Windows.MessageBox]::Show('Node.js wurde nicht gefunden. Bitte Node.js 22 oder neuer installieren (https://nodejs.org) oder die Umgebungsvariable NODE_HOME auf den Ordner mit node.exe setzen.', 'Zeiterfassung')"
  exit /b 1
)

set LOCAL_MODE=true
node src\launcher.js %*
