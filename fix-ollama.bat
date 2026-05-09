@echo off
setlocal
set "LOG=%~dp0fix-ollama.log"
del "%LOG%" >nul 2>&1

call :main >> "%LOG%" 2>&1
exit /b

:main
echo === Step 1: writing %%USERPROFILE%%\.wslconfig ===
> "%USERPROFILE%\.wslconfig" (
  echo [wsl2]
  echo networkingMode=mirrored
)
echo --- contents ---
type "%USERPROFILE%\.wslconfig"
echo.

echo === Step 2: wsl --shutdown ===
wsl --shutdown
echo waiting 8s for VM to fully stop...
timeout /t 8 /nobreak >nul

echo.
echo === Step 3: launching Ollama in detached WSL window ===
start "Ollama (WSL)" wsl -d Ubuntu-24.04 -- ollama serve
echo waiting 12s for Ollama to come up...
timeout /t 12 /nobreak >nul

echo.
echo === Step 4: Windows-side curl http://127.0.0.1:11434/api/version ===
curl --max-time 5 http://127.0.0.1:11434/api/version 2>&1
echo.

echo === Step 5: WSL-side sanity check (should always work) ===
wsl -d Ubuntu-24.04 -- curl --max-time 5 -fsS http://127.0.0.1:11434/api/version 2>&1
echo.
echo === done ===
exit /b
