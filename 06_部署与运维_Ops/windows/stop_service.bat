@echo off
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3888 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"
taskkill /F /IM chrome-headless-shell.exe >nul 2>&1
powershell -NoProfile -Command "Get-Process -Name chrome -ErrorAction SilentlyContinue | Where-Object { $_.Path -match 'ms-playwright' } | Stop-Process -Force -ErrorAction SilentlyContinue"
echo [OK] Xuexitong service stopped.
