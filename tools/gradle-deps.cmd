@echo off
REM Print the resolved dependency graph for the watch app's debug compile classpath.
REM
REM Used to confirm which artifact versions Gradle actually selected, rather than
REM assuming the version catalog took effect.

setlocal

set "ROOT=%~1"
if "%ROOT%"=="" set "ROOT=%~dp0.."

set "JDK=%ROOT%\tools\android\jdk"
set "SDK=%ROOT%\tools\android\sdk"
set "PROJECT=%ROOT%\packages\watch-app"
set "GRADLE=%ROOT%\tools\android\gradle\gradle-9.8.0\bin\gradle.bat"
set "LOG=%ROOT%\.state\logs\gradle-deps.log"

set "JAVA_HOME=%JDK%"
set "ANDROID_HOME=%SDK%"
set "ANDROID_SDK_ROOT=%SDK%"
set "PATH=%JDK%\bin;%SDK%\platform-tools;%PATH%"

call "%GRADLE%" --project-dir "%PROJECT%" --no-daemon --console=plain -Dandroid.sdk.location="%SDK%" :app:dependencies --configuration debugCompileClasspath > "%LOG%" 2>&1
echo exit: %ERRORLEVEL%
echo log: %LOG%
exit /b %ERRORLEVEL%
