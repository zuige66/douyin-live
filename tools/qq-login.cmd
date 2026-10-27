@echo off
chcp 65001 >nul
title QQ Music Login
cd /d "%~dp0.."
python tools\qq-login.py
if errorlevel 1 (
  echo.
  echo 没成。二维码两分钟就过期，重跑一次就行。
)
echo.
pause
