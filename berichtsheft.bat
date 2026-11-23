@echo off
cd /d "%~dp0"

rem Node.js suchen (wie in Zeiterfassung-starten.bat)
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
  echo Node.js wurde nicht gefunden. Bitte NODE_HOME setzen, siehe Zeiterfassung-starten.bat.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Bitte zuerst Zeiterfassung-starten.bat ausfuehren ^(installiert die Abhaengigkeiten^).
  pause
  exit /b 1
)

set LOCAL_MODE=true
chcp 65001 >nul
node src\scripts\berichtsheft.js %*
set CODE=%ERRORLEVEL%
echo.
echo Fertig ^(Code %CODE%^).
pause
