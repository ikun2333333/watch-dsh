@echo off
REM Double-clickable entry point for the public-relay bridge.
REM
REM This brings up the link a watch on mobile data uses: this PC dials out to the
REM public relay, the watch dials out to the same relay, and the relay routes
REM between them. No local port is opened and no port forwarding is involved.
REM
REM The window stays open for as long as the bridge runs, because closing it takes
REM the watch's route to this PC with it. When it does exit, it waits for a
REM keypress so the reason stays readable.
REM
REM Any arguments are forwarded, so `remote-bridge.cmd -Relay wss://other` works.

setlocal

set "SCRIPT=%~dp0remote-bridge.ps1"

REM Prefer PowerShell 7 when present; Windows PowerShell 5.1 runs the script just
REM as well, and is what is guaranteed to exist.
where pwsh >nul 2>&1
if %ERRORLEVEL%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
)

echo.
pause
