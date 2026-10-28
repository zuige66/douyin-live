@echo off
setlocal enableextensions
cd /d "%~dp0"
title Douyin Live - Console

rem =====================================================================
rem  Double-click this file to start the live console.
rem
rem  It runs server.mjs on 127.0.0.1:18082 -- NOT the bridge.
rem  The console opens the browser itself. The page has the
rem  Start / Restart / Stop buttons, so the bridge no longer needs
rem  to be launched by hand.
rem
rem  Want the bridge's own console window (debug only)?
rem  Double-click start-bridge.cmd instead.
rem
rem  NOTE: keep this file ASCII-only. cmd.exe mis-parses UTF-8
rem  Chinese inside rem/echo lines and tries to run them as commands.
rem =====================================================================

set "NODE_EXE="
if exist "D:\Apps\node22\node.exe" set "NODE_EXE=D:\Apps\node22\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
if not defined NODE_EXE for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do if exist "%%D\node.exe" set "NODE_EXE=%%D\node.exe"

if not defined NODE_EXE (
  echo.
  echo  [ERROR] Node.js not found on this machine.
  echo.
  echo    Install it once:   winget install OpenJS.NodeJS.LTS
  echo    Then close this window and run start.cmd again.
  echo.
  pause
  exit /b 1
)

echo.
echo   node : %NODE_EXE%
echo   dir  : %CD%
echo.
echo   Console : http://127.0.0.1:18082/   (opens automatically)
echo   Keep this window open - closing it stops the bridge too.
echo.
echo  ---------------------------------------------------------------
echo.

"%NODE_EXE%" server.mjs --open

echo.
echo  ---------------------------------------------------------------
echo   Console stopped. If it died on startup, the reason is above.
echo  ---------------------------------------------------------------
pause >nul
