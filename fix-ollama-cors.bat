@echo off
setlocal
set "LOG=%~dp0fix-ollama-cors.log"
del "%LOG%" >nul 2>&1

call :main >> "%LOG%" 2>&1
exit /b

:main
echo === Step 1: stop existing ollama in WSL ===
wsl -d Ubuntu-24.04 -- bash -lc "pkill -f 'ollama serve' || true; sleep 2; pgrep -a ollama || echo 'no ollama running'"

echo.
echo === Step 2: launch ollama with OLLAMA_ORIGINS=* in detached WSL window ===
start "Ollama (WSL, CORS open)" wsl -d Ubuntu-24.04 -- bash -lc "OLLAMA_HOST=0.0.0.0:11434 OLLAMA_ORIGINS=* ollama serve"
echo waiting 10s for daemon to come up...
timeout /t 10 /nobreak >nul

echo.
echo === Step 3: Windows-side check (should still return version JSON) ===
curl --max-time 5 http://127.0.0.1:11434/api/version 2>&1
echo.

echo === Step 4: simulated Tauri preflight (Origin: https://tauri.localhost) ===
curl --max-time 5 -s -i -X OPTIONS ^
  -H "Origin: https://tauri.localhost" ^
  -H "Access-Control-Request-Method: POST" ^
  -H "Access-Control-Request-Headers: content-type" ^
  http://127.0.0.1:11434/api/chat 2>&1
echo.

echo === Step 5: simulated Tauri actual GET (Origin: https://tauri.localhost) ===
curl --max-time 5 -s -i ^
  -H "Origin: https://tauri.localhost" ^
  http://127.0.0.1:11434/api/tags 2>&1
echo.

echo === done ===
exit /b
