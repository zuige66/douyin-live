@echo off
chcp 65001 >nul
title QQ Music Cookie
cd /d "%~dp0.."
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" tools\qq-cookie.py
) else (
  python tools\qq-cookie.py
)
echo.
pause
