@echo off
title XXT_SSH_TUNNEL_DAEMON
echo ========================================================
echo  Starting SSH Reverse Tunnel to Tokyo VPS (66.42.43.239)
echo  Local: 127.0.0.1:3888 ---> Remote: 0.0.0.0:3888
echo ========================================================

:LOOP
echo [%date% %time%] Establishing SSH tunnel to tokyo...
ssh -N -T -R 0.0.0.0:3888:127.0.0.1:3888 -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes tokyo

echo [%date% %time%] SSH tunnel disconnected. Reconnecting in 5 seconds...
timeout /t 5 /nobreak >nul
goto LOOP
