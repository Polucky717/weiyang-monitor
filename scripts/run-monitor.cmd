@echo off
rem ---------------------------------------------------------------------------
rem Thin wrapper around run-monitor.ps1 in this same folder.
rem
rem NOTE: batch files are parsed as ANSI, so this file must stay pure ASCII.
rem It used to print a Chinese failure message, which came out as mojibake on
rem the console. The messages users actually read are printed by
rem run-monitor.ps1, which is UTF-8 with BOM and reads correctly.
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-monitor.ps1" %*
set "code=%ERRORLEVEL%"
if not "%code%"=="0" (
  echo.
  echo Startup failed with exit code %code%. See the messages above.
  pause
)
exit /b %code%
