@echo off
chcp 65001 >nul
title 学习通本地挂机服务 (前台调试控制台)
set HTTP_PROXY=
set HTTPS_PROXY=
set ALL_PROXY=
set http_proxy=
set https_proxy=
set all_proxy=
echo ============================================================
echo   学习通无头挂机服务 (本地双轨 - 前台调试控制台)
echo   网络出口: 强制直连中国移动/家庭原生宽带 (免除9010风控)
echo   服务地址: http://127.0.0.1:3888
echo ============================================================
echo 正在启动本地无头服务，请稍候...
cd /d "%~dp0..\..\"
if exist "vps-service\web.js" (
    node vps-service\web.js
) else (
    node 01_源码工程_Source\web.js
)
pause
