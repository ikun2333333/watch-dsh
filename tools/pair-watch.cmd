@echo off
REM Double-clickable entry point for pairing the watch.
REM
REM A window opened by double-clicking closes as soon as its command ends, which
REM makes a script that already succeeded look like it crashed. This wrapper runs
REM the real script, then waits for a keypress so the result stays readable.
REM
REM Running this from an existing terminal works too; it will simply wait for one
REM keypress at the end. To skip that, call the .ps1 directly:
REM   .\tools\pair-watch.ps1
REM
REM Any arguments are forwarded, so `pair-watch.cmd -Method discovery` works.

setlocal

set "SCRIPT=%~dp0pair-watch.ps1"

REM Prefer PowerShell 7 when present; Windows PowerShell 5.1 runs the script just
REM as well, and is what is guaranteed to exist.
where pwsh >nul 2>&1
if %ERRORLEVEL%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Pause %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Pause %*
)

REM A failure inside PowerShell already printed its reason and paused, so reaching
REM here with a non-zero code means PowerShell itself could not start the script.
if %ERRORLEVEL% NEQ 0 (
  echo.
  echo The pairing script could not be started ^(exit code %ERRORLEVEL%^).
  pause
)
