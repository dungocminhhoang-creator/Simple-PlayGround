@echo off
setlocal
cd /d "%~dp0"

echo [INFO] [T:web-demo] [STEP:startup] Starting Simple Playground demo web
echo [INFO] [T:web-demo] [STEP:config] URL=http://localhost:5174
echo [INFO] [T:web-demo] [STEP:config] Demo mode=true
echo [INFO] [T:web-demo] [STEP:config] Command=npm run dev -- --port 5174

if not exist "package.json" (
  echo [ERROR] [T:web-demo] [STEP:preflight] package.json not found. Run this file from the project folder.
  pause
  exit /b 1
)

set VITE_DEMO_MODE=true
npm run dev -- --port 5174

echo [INFO] [T:web-demo] [STEP:shutdown] Demo web process ended
pause
