@echo off
setlocal enableextensions
cd /d "%~dp0"
title Douyin Live Overlay - Bridge

rem ---------------------------------------------------------------------------
rem  Usage:
rem    start.cmd              -> demo mode, fake danmaku, nothing leaves this PC
rem    start.cmd 123456789    -> attach to a real live room
rem ---------------------------------------------------------------------------

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

echo  node : %NODE_EXE%
echo  dir  : %CD%
echo.

if "%~1"=="" (
  echo  mode : DEMO  ^(fake danmaku, never touches Douyin^)
  echo.
  "%NODE_EXE%" bridge.mjs --demo
) else (
  echo  mode : LIVE  room %~1
  echo.
  "%NODE_EXE%" bridge.mjs --rid %~1
)

echo.
echo  ---------------------------------------------------------------
echo  Bridge stopped. If it died on startup, the reason is above.
echo  Press any key to close.
echo  ---------------------------------------------------------------
pause >nul
