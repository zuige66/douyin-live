@echo off
setlocal
cd /d "%~dp0"

rem One-time setup: register a scheduled task so mate-agent always runs elevated
rem in the background after Windows logon. No more UAC prompts, no more manual start.
rem Required because Live Companion is a High IL process (requireAdministrator + uiAccess).

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

".venv\Scripts\python.exe" tools\install_mate_task.py
echo.
pause
