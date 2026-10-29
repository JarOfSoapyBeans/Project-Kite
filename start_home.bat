@echo off
setlocal
rem ==================================================================
rem  Kite: run the backend on this computer and share it through a
rem  Cloudflare Tunnel. Double-click this file, or run it from
rem  Command Prompt:   start_home.bat
rem ==================================================================

rem ---- Your settings (edit these with:  notepad start_home.bat) -----

rem Your Kite frontend address(es), comma-separated. Must match exactly,
rem e.g. https://kite.vercel.app  (no slash at the end).
set ALLOWED_ORIGINS=https://your-kite.vercel.app

rem Port the backend listens on. The tunnel points here.
set PORT=8080

rem Name of a named Cloudflare Tunnel (a permanent address, see README).
rem Leave empty to use a quick tunnel (a new random address every time).
set TUNNEL_NAME=

rem ------------------------------------------------------------------

rem Behind a Cloudflare Tunnel: take visitors' real IPs from Cloudflare.
set TRUST_CF=1
rem Keep site cookies (your logins) across restarts. Private, git-ignored.
set COOKIE_FILE=%~dp0.kite-cookies.json

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto no_node
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if errorlevel 1 goto old_node

where cloudflared >nul 2>nul
if errorlevel 1 goto no_cloudflared

if "%ALLOWED_ORIGINS%"=="https://your-kite.vercel.app" echo [warning] ALLOWED_ORIGINS is still the example value. Edit start_home.bat first.

echo Starting the Kite backend on port %PORT% ...
start "Kite backend" /d "%~dp0backend" cmd /k node server.js

if "%TUNNEL_NAME%"=="" goto quick_tunnel
echo Starting the Cloudflare Tunnel "%TUNNEL_NAME%" ...
start "Kite tunnel" cmd /k cloudflared tunnel run --url http://localhost:%PORT% %TUNNEL_NAME%
goto started

:quick_tunnel
echo Starting a quick Cloudflare Tunnel. Its address changes every time.
start "Kite tunnel" cmd /k cloudflared tunnel --url http://localhost:%PORT%

:started
echo.
echo Two windows opened: "Kite backend" and "Kite tunnel".
echo   - Your backend's public address is the https:// address in the tunnel
echo     window. For a quick tunnel it ends in trycloudflare.com
echo   - Give it to Kite with the gear button, or set BACKEND_URL on Vercel.
echo   - To stop Kite, close both windows.
echo.
pause
exit /b 0

:no_node
echo Node.js was not found. Install version 20 or newer, then run this again:
echo     winget install OpenJS.NodeJS.LTS
echo (or download it from https://nodejs.org)
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
