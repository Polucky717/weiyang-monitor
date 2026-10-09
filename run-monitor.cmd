@echo off
rem ---------------------------------------------------------------------------
rem Weiyang monitor - one-click launcher (double-click this file).
rem
rem The real logic lives in scripts\run-monitor.ps1 (dependency check, browser,
rem login, start backend). This file is only a thin wrapper: it forwards all
rem arguments and keeps the window open on failure so errors stay readable.
rem
rem NOTE: batch files are parsed as ANSI, so this file must stay pure ASCII.
rem Chinese text here would be mangled by the code page. Messages that users
rem see are printed by run-monitor.ps1 (which is UTF-8 with BOM).
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run-monitor.ps1" %*
set "code=%ERRORLEVEL%"
if not "%code%"=="0" (
  echo.
  echo Startup failed with exit code %code%. See the messages above.
  pause
)
exit /b %code%
