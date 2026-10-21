@echo off
chcp 65001 >nul
title Weiyang Monitor - Verify Session Restore
cd /d "%~dp0"

echo.
echo   Weiyang Monitor - Verify Session Restore
echo   ========================================
echo.

if exist "tools\verify-session-restore.ps1" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "tools\verify-session-restore.ps1"
  goto :done
)

echo   tools\verify-session-restore.ps1 not found.
echo.

:done
echo.
pause
