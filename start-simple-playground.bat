@echo off
setlocal
cd /d "%~dp0"

if not exist ".env" (
  echo [WARN] .env file not found.
  echo [WARN] Copy .env.example to .env and configure VITE_GAME_CONTRACT_ADDRESS and RELAYER_PRIVATE_KEY.
  pause
  exit /b 1
)

echo [INFO] Starting Simple Playground frontend and relayer...
echo [INFO] Frontend: http://localhost:5173
echo [INFO] Relayer:  http://localhost:8787/api/health

start "Simple Playground - Frontend" cmd /k "cd /d ""%~dp0"" && npm run dev -- --port 5173"
start "Simple Playground - Relayer" cmd /k "cd /d ""%~dp0"" && npm run relayer"

echo [OK] Started. Keep both terminal windows open while testing.
pause
