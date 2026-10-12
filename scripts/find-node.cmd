@echo off
rem ---------------------------------------------------------------------------
rem Locate node.exe and export it to the caller as NODEEXE / NODEDIR.
rem
rem This is a helper for other .cmd files, not something users run.
rem Callers use it like this:
rem
rem     call "%~dp0find-node.cmd" /install
rem     if not defined NODEEXE ( ... Node.js is missing ... )
rem
rem Why a separate file:
rem   * PATH cannot be trusted. At logon time it may not be set up yet, and a
rem     portable Node.js is deliberately NOT added to PATH (see ensure-node.ps1).
rem   * %LOCALAPPDATA%\weiyang-node is where scripts\ensure-node.ps1 unpacks the
rem     downloaded portable copy.
rem   * Both run-monitor.cmd and start-autostart.cmd need this, and one copy
rem     means the search order can never drift between them.
rem
rem Order matters: the portable copy comes first, then user-local installs, then
rem machine-wide ones. A Node.js placed for this project therefore wins over a
rem stale system install. This is the same order start-autostart.cmd uses.
rem
rem Usage:
rem     call "%~dp0find-node.cmd"            use an existing node.exe only
rem     call "%~dp0find-node.cmd" /install   download a portable copy if missing
rem
rem Sets NODEEXE (full path to node.exe) and NODEDIR (its folder, no trailing
rem backslash). Both stay undefined when Node.js cannot be found.
rem
rem Pure ASCII on purpose: cmd.exe parses .cmd as ANSI, so UTF-8 Chinese
rem comments would break the parser.
rem ---------------------------------------------------------------------------
set "NODEEXE="
set "NODEDIR="

set "PORTABLEDIR=%LOCALAPPDATA%\weiyang-node"

rem 1. Look for a node.exe we can use right now.
for %%P in (
  "%PORTABLEDIR%\node.exe"
  "%LOCALAPPDATA%\Programs\nodejs\node.exe"
  "%ProgramFiles%\nodejs\node.exe"
  "%ProgramFiles(x86)%\nodejs\node.exe"
) do (
  if not defined NODEEXE if exist %%P set "NODEEXE=%%~fP"
)
if not defined NODEEXE (
  for %%N in (node.exe) do if not "%%~$PATH:N"=="" set "NODEEXE=%%~$PATH:N"
)

rem 2. Optionally download a portable copy when nothing was found.
rem    The exit code is captured before endlocal, because endlocal would
rem    otherwise discard it along with the local scope.
set "NODE_SETUP_CODE=0"
if not defined NODEEXE if /i "%~1"=="/install" (
  echo Node.js was not found on this computer.
  echo Downloading a portable copy - about 30 MB, one time only.
  echo It goes to "%PORTABLEDIR%" and PATH is not modified.
  echo.
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0ensure-node.ps1"
  set "NODE_SETUP_CODE=%ERRORLEVEL%"
  echo.
  if exist "%PORTABLEDIR%\node.exe" set "NODEEXE=%PORTABLEDIR%\node.exe"
)

if defined NODEEXE for %%D in ("%NODEEXE%") do set "NODEDIR=%%~dpD"
if defined NODEDIR if "%NODEDIR:~-1%"=="\" set "NODEDIR=%NODEDIR:~0,-1%"

rem Report failure only when the download did not produce a usable node.exe.
if not defined NODEEXE if not "%NODE_SETUP_CODE%"=="0" (
  echo The automatic download did not succeed ^(exit %NODE_SETUP_CODE%^).
  echo Please install Node.js by hand and run this again:
  echo     https://nodejs.org/en/download
)

rem Export to the caller. %VAR% is expanded before endlocal executes, so the
rem values survive; this is the standard "endlocal & set" idiom.
endlocal & set "NODEEXE=%NODEEXE%" & set "NODEDIR=%NODEDIR%"
exit /b 0
