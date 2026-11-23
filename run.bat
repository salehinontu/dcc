@echo off
rem ---------------------------------------------------------------------------
rem  One-command Windows launcher for the local development stack.
rem
rem    run.bat
rem
rem  Installs anything that is missing (pnpm, .env, dependencies, MediaMTX and
rem  the first developer account) and then opens two windows:
rem
rem    backend  - MQTT broker, API + embedded Postgres (PGlite), MediaMTX, simulator
rem    frontend - Vite dashboard on http://localhost:5173
rem
rem  Anything already present is left untouched. Close a window to stop that half
rem  of the stack. For the Docker stack (Postgres, EMQX, SRS) use run.sh --docker.
rem ---------------------------------------------------------------------------
setlocal EnableExtensions EnableDelayedExpansion
title drone-fleet launcher
cd /d "%~dp0"

set "ROOT=%CD%"
set "PNPM_VERSION=10.20.0"
set "MEDIAMTX_VERSION=1.21.2"
set "MIN_NODE_MAJOR=22"
set "API_PORT=3000"

echo.
echo [run] drone-fleet local dev launcher
echo [run] %ROOT%
echo.

rem ---- Node -----------------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo [run] error: Node.js is missing. Install Node %MIN_NODE_MAJOR%+ from https://nodejs.org and run this again.
  goto :fail
)

set "NODE_MAJOR="
for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do set "NODE_MAJOR=%%v"
if not defined NODE_MAJOR (
  echo [run] error: could not read the Node.js version.
  goto :fail
)
if %NODE_MAJOR% LSS %MIN_NODE_MAJOR% (
  echo [run] error: Node %NODE_MAJOR% is too old; this project needs Node %MIN_NODE_MAJOR% or newer.
  goto :fail
)
for /f "delims=" %%v in ('node -v') do set "NODE_VERSION=%%v"
echo [run] node %NODE_VERSION%

rem ---- pnpm -----------------------------------------------------------------
rem A corepack shim can exist without a usable pnpm behind it, so run it.
call pnpm -v >nul 2>&1
if errorlevel 1 (
  echo [run] pnpm is missing or broken; enabling pnpm %PNPM_VERSION% through corepack
  call corepack enable >nul 2>&1
  call corepack prepare pnpm@%PNPM_VERSION% --activate
  call pnpm -v >nul 2>&1
  if errorlevel 1 (
    echo [run] error: pnpm is not usable. Install it with: npm install -g pnpm@%PNPM_VERSION%
    goto :fail
  )
)
for /f "delims=" %%v in ('pnpm -v 2^>nul') do set "PNPM_INSTALLED=%%v"
echo [run] pnpm %PNPM_INSTALLED%

rem ---- .env -----------------------------------------------------------------
if not exist ".env" (
  if not exist ".env.example" (
    echo [run] error: .env and .env.example are both missing.
    goto :fail
  )
  copy /y ".env.example" ".env" >nul
  echo [run] created .env from .env.example ^(edit it before using real hardware^)
)

rem ---- workspace dependencies -----------------------------------------------
if not exist "node_modules\.pnpm\lock.yaml" (
  echo [run] installing workspace dependencies ^(first run, this takes a few minutes^)
  call pnpm install --frozen-lockfile
  if errorlevel 1 (
    echo [run] error: pnpm install failed.
    goto :fail
  )
) else (
  echo [run] workspace dependencies are installed
)

rem ---- MediaMTX (live video) -------------------------------------------------
if not exist ".data\mediamtx\mediamtx.exe" (
  set "MTX_ARCH=amd64"
  if /i "!PROCESSOR_ARCHITECTURE!"=="ARM64" set "MTX_ARCH=arm64"
  echo [run] downloading MediaMTX v%MEDIAMTX_VERSION% ^(windows-!MTX_ARCH!^)
  if not exist ".data" mkdir ".data"
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/bluenviron/mediamtx/releases/download/v%MEDIAMTX_VERSION%/mediamtx_v%MEDIAMTX_VERSION%_windows_!MTX_ARCH!.zip' -OutFile '.data\mediamtx.zip'; Expand-Archive -LiteralPath '.data\mediamtx.zip' -DestinationPath '.data\mediamtx' -Force; Remove-Item '.data\mediamtx.zip'"
  if errorlevel 1 (
    echo [run] warning: MediaMTX could not be installed; live video will stay unavailable.
    if exist ".data\mediamtx.zip" del /q ".data\mediamtx.zip"
  ) else (
    echo [run] MediaMTX installed
  )
) else (
  echo [run] MediaMTX is installed
)

rem ---- people-counting model (about 217 MB, once) ------------------------------
call pnpm models:fetch
if errorlevel 1 echo [run] warning: the people-counting model could not be installed; counting stays off.

rem ---- first developer account ------------------------------------------------------
rem The API seeds no accounts; without one nobody can sign in. PGlite cannot be
rem opened by two processes, so this runs before the API starts.
call pnpm --silent --filter @dji/api user:list >"%TEMP%\drone-fleet-users.txt" 2>nul
if errorlevel 1 (
  echo [run] error: the dev database could not be read.
  echo [run]        Stop any running backend window and try again.
  del /q "%TEMP%\drone-fleet-users.txt" >nul 2>&1
  goto :fail
)
set "HAS_USERS="
for /f "usebackq delims=" %%u in ("%TEMP%\drone-fleet-users.txt") do set "HAS_USERS=1"
del /q "%TEMP%\drone-fleet-users.txt" >nul 2>&1
if not defined HAS_USERS (
  echo.
  echo [run] No dashboard account exists yet. Create the first developer account:
  echo.
  call pnpm --filter @dji/api admin
  if errorlevel 1 (
    echo.
    echo [run] error: the developer account was not created.
    goto :fail
  )
  echo.
)

rem ---- fail fast if the stack is already up ----------------------------------
node -e "const s=require('net').connect(%API_PORT%,'127.0.0.1');s.on('connect',()=>{s.destroy();process.exit(1)});s.on('error',()=>process.exit(0));s.setTimeout(500,()=>{s.destroy();process.exit(0)})"
if errorlevel 1 (
  echo [run] error: port %API_PORT% is already in use. Close the running backend, then try again.
  goto :fail
)
node -e "const s=require('net').connect(1883,'127.0.0.1');s.on('connect',()=>{s.destroy();process.exit(1)});s.on('error',()=>process.exit(0));s.setTimeout(500,()=>{s.destroy();process.exit(0)})"
if errorlevel 1 (
  echo [run] error: port 1883 is already in use. Close the running MQTT broker, then try again.
  goto :fail
)

rem ---- backend window: broker + API + database + media + simulator ----------
echo [run] starting the backend window ^(broker, API + database, media, simulator^)
start "drone-fleet backend" /D "%ROOT%" cmd /k node tools/dev/start.mjs --no-web

echo [run] waiting for the API on http://127.0.0.1:%API_PORT% ...
set /a WAITED=0
:wait_api
node -e "fetch('http://127.0.0.1:%API_PORT%/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
if not errorlevel 1 goto :api_ready
set /a WAITED+=2
if %WAITED% GEQ 90 (
  echo [run] warning: the API is slow to start; opening the dashboard anyway.
  goto :api_ready
)
ping -n 3 127.0.0.1 >nul
goto :wait_api

:api_ready
rem ---- frontend window: Vite ------------------------------------------------
echo [run] starting the frontend window ^(Vite^)
start "drone-fleet frontend" /D "%ROOT%" cmd /k pnpm --filter @dji/web dev

echo.
echo [run] backend window  : MQTT 1883, API %API_PORT%, embedded Postgres, MediaMTX, simulator
echo [run] frontend window : dashboard http://localhost:5173
echo [run] close a window to stop that half of the stack
echo.
echo [run] this launcher window can be closed.
ping -n 9 127.0.0.1 >nul
exit /b 0

:fail
echo.
echo [run] stopped.
pause
exit /b 1
