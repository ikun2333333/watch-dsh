@echo off
REM Double-clickable entry point for the LAN setup: Harness, relay, and bridge.
REM
REM This script blocks for the lifetime of the processes it starts, so a
REM double-clicked window stays useful instead of closing immediately. When it
REM does exit - because it failed, or because Ctrl+C stopped things - it waits for
REM a keypress so the reason stays readable.
REM
REM Any arguments are forwarded, so `lan-test.cmd -Port 8790` works.

setlocal

set "SCRIPT=%~dp0lan-test.ps1"

REM Prefer PowerShell 7 when present; Windows PowerShell 5.1 runs the script just
REM as well, and is what is guaranteed to exist.
where pwsh >nul 2>&1
if %ERRORLEVEL%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
)
set "CODE=%ERRORLEVEL%"

echo.
REM Exit code 2 means the script declined to start because the port was already
REM serving. Saying "the relay and bridge have stopped" in that case would be
REM wrong: nothing was started, and the existing relay is probably still fine.
if "%CODE%"=="2" (
  echo Nothing was started or stopped. See the message above.
) else (
  echo The relay and bridge have stopped.
)
pause
