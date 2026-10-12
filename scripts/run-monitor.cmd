@echo off
rem ---------------------------------------------------------------------------
rem First-run entry point: make sure Node.js exists, then hand over to
rem run-monitor.ps1.
rem
rem The Node.js check has to happen HERE, in the .cmd, and cannot live inside
rem run-monitor.ps1: that script needs npm, so it cannot do anything useful on a
rem machine without Node.js. This wrapper only relies on what every Windows 10+
rem ships with (cmd.exe, powershell.exe, curl.exe, tar.exe).
rem
rem Without a local Node.js, ensure-node.ps1 downloads a portable copy (about
rem 30 MB) into %LOCALAPPDATA%\weiyang-node. Nothing is installed system-wide
rem and PATH is not modified - see that script for the reasoning.
rem
rem NOTE: batch files are parsed as ANSI, so this file must stay pure ASCII.
rem It used to print a Chinese failure message, which came out as mojibake on
rem the console. The messages users actually read are printed by
rem run-monitor.ps1 and ensure-node.ps1.
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

rem /install = download a portable Node.js when none is present.
call "%~dp0find-node.cmd" /install
if not defined NODEEXE (
  echo.
  echo Node.js is required but was not found, and it could not be downloaded.
  echo Install it from https://nodejs.org/en/download and run this file again.
  pause
  exit /b 1
)

rem Expose the Node.js we resolved so run-monitor.ps1 can find npm.cmd even when
rem the install is portable and therefore absent from PATH.
set "PATH=%NODEDIR%;%PATH%"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-monitor.ps1" %*
set "code=%ERRORLEVEL%"
if not "%code%"=="0" (
  echo.
  echo Startup failed with exit code %code%. See the messages above.
  pause
)
exit /b %code%
