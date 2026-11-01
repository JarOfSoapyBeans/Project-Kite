@echo off
setlocal
rem ==================================================================
rem  Kite, the browser app (Stage 7). Double-click to run it.
rem  The first time, it downloads Electron (about 100 MB) with npm.
rem ==================================================================
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto no_node

if exist "node_modules\electron" goto run
echo Installing Kite app parts (first time only) ...
call npm install --workspace desktop
if errorlevel 1 goto failed

:run
cd desktop
call npm start
exit /b 0

:no_node
echo Node.js was not found. Install version 20 or newer, then run this again:
echo     winget install OpenJS.NodeJS.LTS
pause
exit /b 1

:failed
echo Installing failed. Check your internet connection and try again.
pause
exit /b 1
