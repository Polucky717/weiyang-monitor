@echo off
rem ===================================================================
rem  Weiyang Monitor - auto-start launcher  (source of truth)
rem
rem  This copy lives in the PROJECT ROOT and uses %~dp0, so it only works
rem  when run from here. The Windows Startup folder holds a shortcut that
rem  points at THIS file (created by tools\install-autostart.js).
rem
rem  Why a .cmd instead of the old .lnk -> wscript -> .vbs chain:
rem  the PowerShell logger called by launch-monitor.vbs fails silently on
rem  this machine, so startup.log stopped recording auto-start events.
rem  This file writes its own log lines with cmd's echo, which cannot
rem  fail silently - a missing line proves this file did not run.
rem
rem  Why it no longer calls scripts\start-edge-monitor.ps1:
rem  that script aborts with "Monitor port 9222 is still occupied" whenever
rem  the monitor browser is already listening, because the check relies on
rem  Get-NetTCPConnection, which needs administrator rights and fails on
rem  this machine (verified: "access denied"). Auto-start therefore never
rem  reached the backend. This launcher only has to guarantee that the
rem  BACKEND runs; the backend starts the monitor browser itself when it
rem  needs one (src\server.js already has browser auto-restart logic), and
rem  it reuses the existing monitor browser when present.
rem
rem  Log: startup.log in the project root.
rem
rem  To disable auto-start: run  node tools\install-autostart.js --remove
rem  or delete the shortcut from the Startup folder (Win+R -> shell:startup).
rem
rem  Pure ASCII on purpose: cmd.exe parses .cmd as ANSI, so Chinese
rem  comments written as UTF-8 would break the parser.
rem ===================================================================
setlocal
chcp 65001 >nul 2>&1

rem Define the project root FIRST. %~dp0 is this file's own folder, and
rem this file must stay in the project root.
set "ROOT=%~dp0"
cd /d "%ROOT%"

set "LOG=%ROOT%startup.log"
set "SERVER=%ROOT%src\server.js"
set "NODEEXE="

echo %date% %time% ^| autostart-enter ^| file=%~nx0 >> "%LOG%"

if not exist "%SERVER%" (
  echo %date% %time% ^| autostart-ERROR ^| missing=%SERVER% >> "%LOG%"
  exit /b 2
)

rem Resolve node.exe explicitly - PATH is not reliable at logon time.
if exist "%ProgramFiles%\nodejs\node.exe" set "NODEEXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODEEXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODEEXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODEEXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODEEXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODEEXE (
  for %%N in (node.exe) do if not "%%~$PATH:N"=="" set "NODEEXE=%%~$PATH:N"
)
if not defined NODEEXE (
  echo %date% %time% ^| autostart-ERROR ^| node.exe-not-found >> "%LOG%"
  exit /b 3
)
echo %date% %time% ^| autostart-node ^| exe=%NODEEXE% >> "%LOG%"

rem Ask the backend whether it is already up. curl.exe ships with every
rem Windows 10+ build, so no PowerShell is involved.
set "BACKEND_UP="
for /f "delims=" %%R in ('curl.exe -s -m 3 -o NUL -w "%%{http_code}" http://127.0.0.1:8787/api/state 2^>NUL') do set "BACKEND_UP=%%R"
echo %date% %time% ^| autostart-probe ^| http=%BACKEND_UP% >> "%LOG%"
if "%BACKEND_UP%"=="200" (
  echo %date% %time% ^| autostart-backend-reused ^| url=http://127.0.0.1:8787 >> "%LOG%"
  endlocal
  exit /b 0
)

rem Start the backend detached and hidden, appending its output to
rem logs\server.log so a crash leaves evidence behind.
if not exist "%ROOT%logs" mkdir "%ROOT%logs"
echo %date% %time% ^| autostart-backend-starting ^| url=http://127.0.0.1:8787 >> "%LOG%"
start "weiyang-backend" /b "%NODEEXE%" "%SERVER%" >> "%ROOT%logs\server.log" 2>&1

echo %date% %time% ^| autostart-backend-launched ^| start-errorlevel=%ERRORLEVEL% >> "%LOG%"
endlocal
exit /b 0
