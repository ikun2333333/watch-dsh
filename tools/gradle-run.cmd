@echo off
REM Shared Gradle runner: sets the pinned JDK/SDK, runs Gradle, logs everything.
REM
REM Called by gradle-build.cmd and gradle-build-task.cmd with the repo root first
REM and the Gradle task arguments after it.

setlocal

set "ROOT=%~1"
if "%ROOT%"=="" set "ROOT=%~dp0.."

set "JDK=%ROOT%\tools\android\jdk"
set "SDK=%ROOT%\tools\android\sdk"
set "PROJECT=%ROOT%\packages\watch-app"
set "GRADLE=%ROOT%\tools\android\gradle\gradle-9.8.0\bin\gradle.bat"
set "LOG=%ROOT%\.state\logs\gradle-build.log"

if not exist "%GRADLE%" (
  echo gradle not found at %GRADLE%
  echo run tools\download.mjs to fetch the distribution
  exit /b 2
)
if not exist "%ROOT%\.state\logs" mkdir "%ROOT%\.state\logs"

set "JAVA_HOME=%JDK%"
set "ANDROID_HOME=%SDK%"
set "ANDROID_SDK_ROOT=%SDK%"
set "PATH=%JDK%\bin;%SDK%\platform-tools;%PATH%"

echo gradle log: %LOG%
call "%GRADLE%" --project-dir "%PROJECT%" --no-daemon --console=plain --stacktrace -Dandroid.sdk.location="%SDK%" %2 %3 %4 %5 %6 %7 %8 %9 > "%LOG%" 2>&1
set GRADLE_EXIT=%ERRORLEVEL%

echo gradle exit code: %GRADLE_EXIT%
exit /b %GRADLE_EXIT%
