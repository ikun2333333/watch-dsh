@echo off
REM Run the Gradle build with output captured by cmd itself.
REM
REM PowerShell 5.1 loses a native command's stderr when the command also writes
REM progress, which is exactly Gradle's behaviour, so the build is driven from
REM cmd and redirected to a log file instead.
REM
REM Two entry points, because cmd cannot drop the first positional argument from
REM %* (`shift` affects %1..%9 only):
REM   gradle-build.cmd <repo-root>                  -> assembleDebug
REM   gradle-build-release.cmd <repo-root>          -> assembleRelease
REM   gradle-build-task.cmd <repo-root> <task...>   -> the named task(s)

setlocal

set "ROOT=%~1"
if "%ROOT%"=="" set "ROOT=%~dp0.."

call "%~dp0gradle-run.cmd" "%ROOT%" assembleDebug
exit /b %ERRORLEVEL%
