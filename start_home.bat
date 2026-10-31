@echo off
setlocal
rem ==================================================================
rem  Kite: run everything on this computer.
rem    1. the backend            (window "Kite backend")
rem    2. your Cloudflare Tunnel (window "Kite tunnel")
rem    3. the frontend           (window "Kite frontend", optional)
rem  Double-click this file, or run it from Command Prompt:  start_home.bat
rem ==================================================================

rem ---- Your settings (edit these with:  notepad start_home.bat) -----

rem Your named Cloudflare Tunnel and the address it serves (made with
rem "cloudflared tunnel create" and "cloudflared tunnel route dns", see README).
set TUNNEL_NAME=kite
set TUNNEL_HOST=kite-api.cat-code.org

rem Where your Kite frontend runs, comma-separated, no slash at the end.
rem http://localhost:3000 is the frontend started by this file.
rem Add your Vercel address later, e.g.
rem   set ALLOWED_ORIGINS=http://localhost:3000,https://kite-xyz.vercel.app
set ALLOWED_ORIGINS=http://localhost:3000

rem 1 = also start the frontend on http://localhost:3000 and open it.
rem 0 = don't (e.g. once your frontend is on Vercel).
set START_FRONTEND=1

rem Port the backend listens on.
set PORT=8080

rem ------------------------------------------------------------------

rem Behind a Cloudflare Tunnel: take visitors' real IPs from Cloudflare.
set TRUST_CF=1
rem Keep site cookies (your logins) across restarts. Private, git-ignored.
set COOKIE_FILE=%~dp0.kite-cookies.json
rem The frontend talks to the backend through the tunnel.
set BACKEND_URL=https://%TUNNEL_HOST%

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto no_node
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if errorlevel 1 goto old_node

where cloudflared >nul 2>nul
if errorlevel 1 goto no_cloudflared

if not exist "%USERPROFILE%\.cloudflared\cert.pem" goto not_logged_in

rem Kite's own tunnel settings. A file you wrote yourself
rem (%USERPROFILE%\.cloudflared\<TUNNEL_NAME>.yml) wins; otherwise one is made
rem here that sends everything to the backend. Either way the shared
rem config.yml (used by your other tunnels) is not read, which would answer 404.
set TUNNEL_CONFIG=%USERPROFILE%\.cloudflared\%TUNNEL_NAME%.yml
if exist "%TUNNEL_CONFIG%" goto have_config
set TUNNEL_CONFIG=%~dp0.kite-tunnel.yml
(
  echo # Made by start_home.bat. Sends every request on this tunnel to the Kite backend.
  echo ingress:
  echo   - service: http://localhost:%PORT%
) > "%TUNNEL_CONFIG%"
:have_config

echo Starting the Kite backend on port %PORT% ...
start "Kite backend" /d "%~dp0backend" cmd /k node server.js

echo Starting your Cloudflare Tunnel "%TUNNEL_NAME%" (%TUNNEL_HOST%) ...
start "Kite tunnel" cmd /k cloudflared tunnel --config "%TUNNEL_CONFIG%" run %TUNNEL_NAME%

if not "%START_FRONTEND%"=="1" goto started
echo Starting the Kite frontend on http://localhost:3000 ...
start "Kite frontend" /d "%~dp0frontend" cmd /k npm run dev
rem Give everything a moment to start, then open Kite.
timeout /t 8 /nobreak >nul
start "" http://localhost:3000

:started
echo.
echo Kite is starting in separate windows.
echo   Backend:  https://%TUNNEL_HOST%   (check: https://%TUNNEL_HOST%/health shows ok)
if "%START_FRONTEND%"=="1" echo   Frontend: http://localhost:3000
echo   To stop Kite, close those windows.
echo.
pause
exit /b 0

:no_node
echo Node.js was not found. Install version 20 or newer, then run this again:
echo     winget install OpenJS.NodeJS.LTS
pause
exit /b 1

:old_node
echo Your Node.js is too old. Kite needs version 20 or newer:
echo     winget upgrade OpenJS.NodeJS.LTS
pause
exit /b 1

:no_cloudflared
echo cloudflared (Cloudflare Tunnel) was not found. Install it, then run this again:
echo     winget install --id Cloudflare.cloudflared
pause
exit /b 1

:not_logged_in
echo cloudflared isn't logged in to Cloudflare on this computer. Run these once:
echo     cloudflared tunnel login
echo     cloudflared tunnel create %TUNNEL_NAME%
echo     cloudflared tunnel route dns %TUNNEL_NAME% %TUNNEL_HOST%
pause
exit /b 1
