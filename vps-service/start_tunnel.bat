@echo off
title XXT_SSH_TUNNEL_DAEMON
set REMOTE_HOST=%1
if "%REMOTE_HOST%"=="" set REMOTE_HOST=tokyo

echo ========================================================
echo  Starting SSH Reverse Tunnel to VPS [%REMOTE_HOST%]
echo  Local: 127.0.0.1:3888 ---^> Remote: 0.0.0.0:3888
echo ========================================================

:LOOP
echo [%date% %time%] Establishing SSH tunnel to %REMOTE_HOST%...
ssh -N -T -R 0.0.0.0:3888:127.0.0.1:3888 -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes %REMOTE_HOST%

echo [%date% %time%] SSH tunnel disconnected. Reconnecting in 5 seconds...
timeout /t 5 /nobreak >nul
goto LOOP
