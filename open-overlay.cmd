@echo off
setlocal enableextensions
cd /d "%~dp0"

rem ===========================================================================
rem  Dafeiyu live overlay - native renderer (no browser)
rem
rem  Why not the browser: Chrome's renderer process aborts every ~33s on this
rem  machine. This draws the 1920x1080 frame with Python/Pillow and blits it
rem  into a plain Win32 window: ~3% of one core when idle, stable for days.
rem
rem  Usage:
rem    1. start.cmd            first - starts the danmaku bridge
rem    2. open-overlay.cmd     this - opens the overlay window (title: Dafeiyu)
rem    3. In Douyin Live Studio, add Window Capture and pick that window
rem
rem  Options:
rem    open-overlay.cmd --demo       fake danmaku, no bridge needed
rem    open-overlay.cmd --topmost    keep the window on top
rem
rem  NOTE: keep this file ASCII-only. cmd.exe parses .cmd in the OEM codepage
rem  (936 here), so UTF-8 Chinese in a batch file shreds the parser.
rem  Chinese output comes from overlay.py, which prints through the console API.
rem ===========================================================================

set "PY="
call :try python
call :try "py -3.8"
call :try "py -3.12"
call :try "%LOCALAPPDATA%\Programs\Python\Python38\python.exe"
call :try "%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe"

rem ---------------------------------------------------------------------------
rem  Windowless twin. python.exe is a CONSOLE app: launching it always leaves a
rem  black terminal on screen (and the .venv launcher spawns a second one).
rem  pythonw.exe has no console at all, so the overlay window is the only thing
rem  that appears. Output goes to overlay.log so failures are still diagnosable.
rem ---------------------------------------------------------------------------
set "PYW="
call :tryw pythonw
call :tryw "pyw -3.8"
call :tryw "pyw -3.12"
call :tryw "%LOCALAPPDATA%\Programs\Python\Python38\pythonw.exe"
call :tryw "%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\pythonw.exe"

rem ---------------------------------------------------------------------------
rem  Project venv wins over everything above.
rem  It is the only interpreter that has BOTH Pillow and imageio-ffmpeg, and the
rem  gift-media player needs ffmpeg for mp4/webm. Without it, video clips fall
rem  back to "素材放不出来" while images still work - a very confusing failure.
rem ---------------------------------------------------------------------------
if exist "%~dp0.venv\Scripts\pythonw.exe" set "PYW=%~dp0.venv\Scripts\pythonw.exe"
if exist "%~dp0.venv\Scripts\python.exe" set "PY=%~dp0.venv\Scripts\python.exe"

if not defined PY (
  echo.
  echo  [ERROR] No Python with Pillow found.
  echo.
  echo    Check which one is missing:
  echo      python -c "import PIL; print(PIL.__version__)"
  echo.
  echo    If Pillow is missing:
  echo      python -m pip install pillow
  echo.
  pause
  exit /b 1
)

echo  python : %PY%
if defined PYW echo  quiet  : %PYW%  ^(no console window^)
echo  canvas : 1920x1080 (Douyin Live Studio is landscape only)
echo  close  : press Esc on the overlay window
echo.

if defined PYW (
  set "PYTHONIOENCODING=utf-8"
  start "" /b %PYW% "%~dp0native\overlay.py" %* >"%~dp0overlay.log" 2>&1
  exit /b 0
)

%PY% "%~dp0native\overlay.py" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo  [exit %RC%] overlay did not start. Reason is above.
  pause
)
exit /b %RC%

:try
if defined PY exit /b 0
%~1 -c "import PIL" >nul 2>&1
if errorlevel 1 exit /b 0
set "PY=%~1"
exit /b 0

:tryw
if defined PYW exit /b 0
%~1 -c "import PIL" >nul 2>&1
if errorlevel 1 exit /b 0
set "PYW=%~1"
exit /b 0
