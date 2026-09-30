@echo off
REM Double-clickable entry point for starting the LAN relay and bridge.
REM
REM This one blocks for the lifetime of the two processes, so a double-clicked
REM window stays useful rather than closing immediately. When it does exit -
REM because it failed, or because Ctrl+C stopped the processes - it waits for a
REM keypress so the result stays readable.
REM
REM Any arguments are forwarded, so `lan-test.cmd -Port 8790` works.

setlocal

set "SCRIPT=%~dp0lan-test.ps1"

where pwsh >nul 2>&1
if %ERRORLEVEL%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
)

echo.
echo The relay and bridge have stopped.
pause
