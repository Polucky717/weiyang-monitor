@echo off
rem ---------------------------------------------------------------------------
rem Restart the monitor backend: stop whatever is listening on the port, then
rem start a fresh process so newly edited source files are actually loaded.
rem
rem Why this file exists:
rem   run-monitor.cmd does NOT stop an already running backend. If the old
rem   process still holds the port, starting a new one can silently fail while
rem   the old code keeps serving requests. That makes a "restart" look like it
rem   did nothing at all -- which is exactly what happened once and cost hours
rem   of debugging: the log kept showing old behaviour after a supposed restart.
rem
rem NOTE: this file must stay pure ASCII. cmd.exe parses .cmd files using the
rem local ANSI code page, so non-ASCII bytes here would turn into mojibake.
rem ---------------------------------------------------------------------------
setlocal
chcp 65001 >nul 2>&1
cd /d "%~dp0"

set "PORT=8787"

echo.
echo [weiyang] stopping any backend listening on port %PORT% ...

set "STOPPED="
for /f "tokens=5" %%P in ('netstat -ano -p tcp ^| findstr /r /c:"LISTENING" ^| findstr /c:":%PORT% "') do (
  if not "%%P"=="0" (
    echo [weiyang]   killing PID %%P
    taskkill /F /PID %%P >nul 2>&1
    if not errorlevel 1 set "STOPPED=1"
  )
)

if defined STOPPED (
  rem Give the OS a moment to release the socket before rebinding.
  ping -n 2 127.0.0.1 >nul 2>&1
) else (
  echo [weiyang]   nothing was listening on %PORT%
)

echo [weiyang] starting a fresh backend ...
echo.
call "%~dp0scripts\run-monitor.cmd" %*
exit /b %errorlevel%
