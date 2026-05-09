@echo off
setlocal
set "LOG=%~dp0diag-and-fix.log"
del "%LOG%" >nul 2>&1

echo === Windows IPv4 probe (before fix) === > "%LOG%"
curl --max-time 5 -s -i -H "Origin: https://tauri.localhost" http://127.0.0.1:11434/api/version >> "%LOG%" 2>&1
echo. >> "%LOG%"

echo === Windows IPv6 probe (before fix) === >> "%LOG%"
curl --max-time 5 -s -i -H "Origin: https://tauri.localhost" http://[::1]:11434/api/version >> "%LOG%" 2>&1
echo. >> "%LOG%"

echo === Windows localhost probe (before fix) === >> "%LOG%"
curl --max-time 5 -s -i -H "Origin: https://tauri.localhost" http://localhost:11434/api/version >> "%LOG%" 2>&1
echo. >> "%LOG%"

echo === ping localhost (which family?) === >> "%LOG%"
ping -n 1 localhost >> "%LOG%" 2>&1
echo. >> "%LOG%"

echo === Running diag-and-fix.sh as root in WSL === >> "%LOG%"
wsl -d Ubuntu-24.04 -u root -- bash /mnt/c/Users/vdzoo/Documents/GitHub/jarvis-app/diag-and-fix.sh >> "%LOG%" 2>&1
echo. >> "%LOG%"

echo === Windows IPv4 probe (after fix) === >> "%LOG%"
curl --max-time 5 -s -i -H "Origin: https://tauri.localhost" http://127.0.0.1:11434/api/version >> "%LOG%" 2>&1
echo. >> "%LOG%"

echo === Windows IPv6 probe (after fix) === >> "%LOG%"
curl --max-time 5 -s -i -H "Origin: https://tauri.localhost" http://[::1]:11434/api/version >> "%LOG%" 2>&1
echo. >> "%LOG%"

echo === Windows localhost probe (after fix) === >> "%LOG%"
curl --max-time 5 -s -i -H "Origin: https://tauri.localhost" http://localhost:11434/api/version >> "%LOG%" 2>&1
echo. >> "%LOG%"

exit /b
