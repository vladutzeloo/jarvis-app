@echo off
REM JARVIS dev launcher — Vite + Tauri in dev mode with hot-reload.
REM Closing this console window also stops the dev server.

cd /d "%~dp0\.."

echo.
echo  ======================================================
echo   JARVIS dev mode
echo   Repo: %CD%
echo   Vite + Tauri starting... (first run takes a minute)
echo   Ctrl+C in this window to stop.
echo  ======================================================
echo.

call npm run tauri dev

REM If npm exits (clean Ctrl+C or crash), keep the window open so the user
REM can read the last output before it disappears.
echo.
echo  --- dev server stopped (exit code %ERRORLEVEL%) ---
pause
