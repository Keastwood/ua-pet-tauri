@echo off
setlocal
PowerShell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\sync-workspace.ps1" %*
echo.
pause
