@echo off
rem ---------------------------------------------------------------------------
rem Restart the monitor backend, then verify that the new code is really running.
rem
rem Why this file exists:
rem   run-monitor.cmd does NOT stop an already running backend. If the old
rem   process still holds the port, the new one may fail to bind while the old
rem   code keeps serving requests -- a "restart" that changes nothing, with no
rem   visible sign. That happened repeatedly and wasted a lot of time.
rem
rem   The only authoritative way to know which code a process loaded is to ask
rem   the process itself: the backend reports backend.codeVersion in /api/state.
rem   The PowerShell script does the stop/start/verify dance and prints PASS or
rem   FAIL by comparing that value against src\server.js on disk. Do not trust
rem   logs\server.log for this: whether stdout reaches that file depends on how
rem   the backend was launched.
rem
rem NOTE: this file must stay pure ASCII. cmd.exe parses .cmd files using the
rem local ANSI code page, so non-ASCII bytes here would turn into mojibake.
rem ---------------------------------------------------------------------------
setlocal
chcp 65001 >nul 2>&1
cd /d "%~dp0"

if not exist "%~dp0tools\restart-and-verify.ps1" (
  echo.
  echo [weiyang] tools\restart-and-verify.ps1 is missing.
  echo [weiyang] Falling back to a plain stop-then-start.
  echo.
  goto :fallback
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\restart-and-verify.ps1"
set "code=%ERRORLEVEL%"
echo.
if "%code%"=="0" (
  echo [weiyang] restart finished. See the PASS/FAIL result above.
) else (
  echo [weiyang] restart reported a problem ^(exit code %code%^). Read the output above.
)
pause
exit /b %code%

:fallback
set "PORT=8787"
set "STOPPED="
for /f "tokens=5" %%P in ('netstat -ano -p tcp ^| findstr /r /c:"LISTENING" ^| findstr /c:":%PORT% "') do (
  if not "%%P"=="0" (
    echo [weiyang]   killing PID %%P
    taskkill /F /PID %%P >nul 2>&1
    if not errorlevel 1 set "STOPPED=1"
  )
)
if defined STOPPED (
  ping -n 2 127.0.0.1 >nul 2>&1
) else (
  echo [weiyang]   nothing was listening on %PORT%
)
call "%~dp0scripts\run-monitor.cmd"
exit /b %errorlevel%
