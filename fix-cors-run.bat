@echo off
setlocal
set "LOG=%~dp0fix-cors-run.log"
del "%LOG%" >nul 2>&1

echo Running fix-cors.sh as root in WSL... > "%LOG%"
echo. >> "%LOG%"
wsl -d Ubuntu-24.04 -u root -- bash /mnt/c/Users/vdzoo/Projects/jarvis-local/fix-cors.sh >> "%LOG%" 2>&1

echo. >> "%LOG%"
echo === Windows-side curl with Tauri origin === >> "%LOG%"
curl --max-time 5 -s -i -H "Origin: https://tauri.localhost" http://127.0.0.1:11434/api/tags >> "%LOG%" 2>&1

exit /b
