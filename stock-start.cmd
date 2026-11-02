@echo off
rem =====================================================================
rem  Stock screen (vertical 1080x1920) -- double-click to start.
rem
rem  IMPORTANT: the process lives exactly as long as the window.
rem  Closing the window (X) stops the program. Minimize it instead
rem  if you want it to keep running while you do other things.
rem
rem  ESC no longer closes it (disabled 2026-11-02) -- only X does.
rem
rem  NOTE: keep this file ASCII-only. cmd.exe mis-parses UTF-8 Chinese
rem  inside rem/echo lines and tries to run them as commands.
rem =====================================================================
setlocal
cd /d "%~dp0"
title Stock Screen - 18084

if not exist ".venv\Scripts\python.exe" (
  echo.
  echo  [ERROR] .venv\Scripts\python.exe not found. Run this from the repo root.
  echo.
  pause
  exit /b 1
)

echo.
echo   Screen  : zuige da fei yu -- stock room  (1080 x 1920)
echo   API     : http://127.0.0.1:18084/healthz
echo   Layout  : http://127.0.0.1:18084/editor
echo.
echo   Close the window to stop. Minimize to keep it running.
echo  ---------------------------------------------------------------
echo.

".venv\Scripts\python.exe" native\stock\run.py

echo.
echo  ---------------------------------------------------------------
echo   Screen stopped.
echo  ---------------------------------------------------------------
pause
