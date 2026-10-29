@echo off
setlocal
cd /d "%~dp0"

rem mate-agent must run elevated: Live Companion is a High IL process
rem (requireAdministrator + uiAccess). A Medium IL process cannot drive it.

net session >nul 2>&1
if %errorlevel%==0 goto run

echo Requesting administrator privileges, please click Yes on the UAC prompt...
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
exit /b

:run
if not exist ".venv\Scripts\python.exe" (
  echo [ERROR] .venv\Scripts\python.exe not found. Run this from the repo root.
  pause
  exit /b 1
)

echo ============================================
echo  mate-agent  http://127.0.0.1:18085
echo  Keep this window open while streaming.
echo  Close it (or press Ctrl+C) to stop.
echo ============================================
echo.

".venv\Scripts\python.exe" tools\mate_agent.py

echo.
echo mate-agent exited.
pause
