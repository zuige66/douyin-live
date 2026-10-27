@echo off
chcp 65001 >nul
title Netease Music Login
cd /d "%~dp0.."
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" tools\netease-login.py
) else (
  python tools\netease-login.py
)
if errorlevel 1 (
  echo.
  echo 没成。二维码两分钟就过期，重跑一次就行。
)
echo.
pause
