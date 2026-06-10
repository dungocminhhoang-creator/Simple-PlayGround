@echo off
setlocal
cd /d "%~dp0"

echo [INFO] [T:web] [STEP:startup] Starting Simple Playground local web
echo [INFO] [T:web] [STEP:config] URL=http://localhost:5173
echo [INFO] [T:web] [STEP:config] Command=npm run dev -- --port 5173

if not exist "package.json" (
  echo [ERROR] [T:web] [STEP:preflight] package.json not found. Run this file from the project folder.
  pause
  exit /b 1
)

if not exist ".env" (
  echo [WARN] [T:web] [STEP:preflight] .env file not found. Local web may miss contract or relayer config.
)

npm run dev -- --port 5173

echo [INFO] [T:web] [STEP:shutdown] Local web process ended
pause
