@echo off
REM Windows entrypoint for ollama-fix.sh. Runs the .sh as root inside WSL,
REM then probes from the Windows side so the log captures both perspectives.
REM
REM Override the WSL distro by setting JARVIS_WSL_DISTRO=Ubuntu-24.04 (etc).
REM Path inside WSL is derived from the script's location at runtime.

setlocal
set "LOG=%~dp0ollama-fix.log"
del "%LOG%" >nul 2>&1

if not defined JARVIS_WSL_DISTRO set "JARVIS_WSL_DISTRO=Ubuntu-24.04"

REM Translate the script directory to its WSL path so we don't hardcode a user.
for /f "usebackq delims=" %%I in (`wsl -d "%JARVIS_WSL_DISTRO%" wslpath -u "%~dp0ollama-fix.sh"`) do set "WSL_SH=%%I"

call :main >> "%LOG%" 2>&1
exit /b

:main
echo === Windows IPv4 probe (before) ===
curl --max-time 5 -s -i -H "Origin: https://tauri.localhost" http://127.0.0.1:11434/api/version
echo.

echo === Windows IPv6 probe (before) ===
curl --max-time 5 -s -i -H "Origin: https://tauri.localhost" http://[::1]:11434/api/version
echo.

echo === Running ollama-fix.sh as root in WSL (%JARVIS_WSL_DISTRO%) ===
echo     %WSL_SH%
wsl -d "%JARVIS_WSL_DISTRO%" -u root -- bash "%WSL_SH%"
echo.

echo === Windows IPv4 probe (after) ===
curl --max-time 5 -s -i -H "Origin: https://tauri.localhost" http://127.0.0.1:11434/api/version
echo.

echo === Windows IPv6 probe (after) ===
curl --max-time 5 -s -i -H "Origin: https://tauri.localhost" http://[::1]:11434/api/version
echo.

echo === Windows localhost probe (after) ===
curl --max-time 5 -s -i -H "Origin: https://tauri.localhost" http://localhost:11434/api/tags
echo.
exit /b
