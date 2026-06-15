@echo off
cd /d "%~dp0"
echo Starting Synthony Cue System...
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
  echo Node.js not found. Please install from https://nodejs.org
  pause
  exit /b 1
)
if not exist "node_modules" (
  echo Installing dependencies...
  npm install
)
node server.js
pause
