@echo off
rem ============================================================================
rem  live-stop.cmd  --  one-click GO OFFLINE (full close)
rem  Human: double-click it (window pauses at the end so you can read it).
rem  Agent: run `live-stop.cmd --no-pause` (does NOT pause).
rem  It calls: node tools/live.mjs stop
rem    -> Mate live_stop (companion GO OFFLINE, auto-confirm)
rem    -> POST /ctl/stop (stop bridge + overlay, pause music)
rem    -> hard-kill musicd process (kills the leftover sound)
rem  Keep this file ASCII-only (cmd.exe mis-parses UTF-8 in echo/rem lines).
rem ============================================================================
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "NODE_EXE="
if exist "D:\Apps\node22\node.exe" set "NODE_EXE=D:\Apps\node22\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"

if not defined NODE_EXE (
  echo.
  echo  [ERROR] Node.js not found. Install once: winget install OpenJS.NodeJS.LTS
  echo.
  pause
  exit /b 1
)

"%NODE_EXE%" "tools\live.mjs" stop %*
set "RC=%ERRORLEVEL%"

if /i "%~1"=="--no-pause" goto :done
echo.
pause
:done
exit /b %RC%
