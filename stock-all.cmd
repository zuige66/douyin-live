@echo off
rem =====================================================================
rem  Start EVERYTHING for the stock live room:
rem    1) console  server.mjs  :18082   (minimized, separate window)
rem    2) bridge   bridge.mjs :18081   (started via the console API)
rem    3) screen   run.py     :18084   (1080x1920 window, this console)
rem
rem  The screen keeps this window busy; closing the screen window stops it.
rem  The console window (minimized) must stay open too -- closing it stops
rem  the bridge. Minimize, never close.
rem
rem  NOTE: bridge only receives chat/gifts while you are ACTUALLY LIVE on
rem  Douyin. Starting it before going live looks green but gets 0 events.
rem
rem  ASCII-only file: cmd.exe mis-parses UTF-8 Chinese in rem/echo lines.
rem =====================================================================
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo  [ERROR] .venv\Scripts\python.exe not found. Run from repo root.
  pause
  exit /b 1
)

set "NODE_EXE="
if exist "D:\Apps\node22\node.exe" set "NODE_EXE=D:\Apps\node22\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
if not defined NODE_EXE (
  echo  [ERROR] Node.js not found.
  pause
  exit /b 1
)

echo.
echo  [1/3] console  ... :18082
start "live-console" /min "%NODE_EXE%" server.mjs
timeout /t 6 >nul

echo  [2/3] bridge   ... :18081
curl -s -m 20 --noproxy "*" -X POST http://127.0.0.1:18082/ctl/start
echo.

echo  [3/3] screen   ... :18084
echo.
echo   API    : http://127.0.0.1:18084/healthz
echo   Layout : http://127.0.0.1:18084/editor
echo   Console: http://127.0.0.1:18082/
echo.
echo   Minimize windows to keep them running. Closing = stop.
echo  ---------------------------------------------------------------
echo.

".venv\Scripts\python.exe" native\stock\run.py

echo.
echo  ---------------------------------------------------------------
echo   Screen stopped. The console window (minimized) may still be up.
echo  ---------------------------------------------------------------
pause
