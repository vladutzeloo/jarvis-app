@echo off
REM Switch WSL2 to mirrored networking so Windows and WSL share the host's
REM network stack. Use this only if Windows can't reach the WSL Ollama daemon
REM via 127.0.0.1 in NAT mode. Orthogonal to CORS — see ollama-fix.cmd for
REM that. Restarts WSL and re-launches Ollama.
REM
REM Override the WSL distro by setting JARVIS_WSL_DISTRO=Ubuntu-24.04 (etc).

setlocal
set "LOG=%~dp0wsl-mirrored-net.log"
del "%LOG%" >nul 2>&1

if not defined JARVIS_WSL_DISTRO set "JARVIS_WSL_DISTRO=Ubuntu-24.04"

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
echo === Step 3: launching Ollama in detached WSL window (%JARVIS_WSL_DISTRO%) ===
start "Ollama (WSL)" wsl -d "%JARVIS_WSL_DISTRO%" -- ollama serve
echo waiting 12s for Ollama to come up...
timeout /t 12 /nobreak >nul

echo.
echo === Step 4: Windows-side curl http://127.0.0.1:11434/api/version ===
curl --max-time 5 http://127.0.0.1:11434/api/version 2>&1
echo.

echo === Step 5: WSL-side sanity check (should always work) ===
wsl -d "%JARVIS_WSL_DISTRO%" -- curl --max-time 5 -fsS http://127.0.0.1:11434/api/version 2>&1
echo.
echo === done ===
exit /b
