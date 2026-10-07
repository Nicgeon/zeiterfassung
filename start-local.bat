@echo off
cd /d "%~dp0"

rem Node.js suchen: zuerst im PATH, dann in typischen Benutzerordnern
rem (Installation ohne Administratorrechte, z.B. C:\Users\NAME\node-v24.21.0-win-x64).
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
  echo Node.js wurde nicht gefunden.
  echo Bitte den Ordner, in dem node.exe liegt, in der Variable NODE_HOME angeben, z.B.:
  echo   set NODE_HOME=C:\Users\philipp.moser\node-v24.21.0-win-x64
  echo   start-local.bat
  pause
  exit /b 1
)

set LOCAL_MODE=true
set ZEIT_SUPERVISED=1
set OPEN_BROWSER=1

:run
if not exist node_modules (
  echo Erster Start: Abhaengigkeiten werden installiert ...
  call npm install --omit=dev
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

rem Ein Update hat Abhaengigkeiten geaendert: vor dem Start installieren.
if exist .update-install-pending (
  echo Update: Abhaengigkeiten werden installiert ...
  call npm install --omit=dev
  if errorlevel 1 (
    pause
    exit /b 1
  )
  del .update-install-pending
)

rem Native Module (better-sqlite3) gelten nur fuer die Node-Version, mit der sie installiert wurden.
rem Wechselt die Version, wird das Modul automatisch neu gebaut.
node -e "new (require('better-sqlite3'))(':memory:').close()" >nul 2>nul
if errorlevel 1 (
  echo Node.js-Version hat sich geaendert - better-sqlite3 wird neu gebaut ...
  call npm rebuild better-sqlite3
  node -e "new (require('better-sqlite3'))(':memory:').close()" >nul 2>nul
  if errorlevel 1 (
    echo Das hat nicht geklappt. Bitte den Ordner node_modules loeschen und start-local.bat erneut starten.
    pause
    exit /b 1
  )
)

node src\server.js
if "%errorlevel%"=="75" (
  echo Neustart nach Update ...
  set OPEN_BROWSER=0
  goto run
)
pause
