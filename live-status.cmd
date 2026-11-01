@echo off
rem ============================================================================
rem  live-status.cmd  --  show live/bridge/music status (read-only, no side effect)
rem  Human: double-click.  Agent: `live-status.cmd --no-pause`.
rem  Calls: node tools/live.mjs status
rem  Keep this file ASCII-only.
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

"%NODE_EXE%" "tools\live.mjs" status %*
set "RC=%ERRORLEVEL%"

if /i "%~1"=="--no-pause" goto :done
echo.
pause
:done
exit /b %RC%
