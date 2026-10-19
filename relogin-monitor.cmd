@echo off
chcp 65001 >nul
title Weiyang Monitor - Relogin
cd /d "%~dp0"

echo.
echo   Weiyang Monitor - Relogin
echo   =========================
echo.

if exist "tools\relogin-and-verify.ps1" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "tools\relogin-and-verify.ps1"
  goto :done
)

echo   tools\relogin-and-verify.ps1 not found - falling back to manual steps.
echo.
echo   Run these in order:
echo     1. close the monitor window / stop the backend
echo     2. npm run login
echo     3. restart-monitor.cmd
echo.
goto :done

:done
echo.
pause
