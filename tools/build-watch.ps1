# One-command Android build for the watch app.
#
# It pins the toolchain that tools\bootstrap-android.ps1 installed and the Gradle
# distribution that tools\download.mjs fetched, so a clean checkout builds
# without Android Studio and without touching the machine's global PATH.
#
# Usage:
#   pwsh -File tools\build-watch.ps1                 # debug APK
#   pwsh -File tools\build-watch.ps1 -Variant release
#   pwsh -File tools\build-watch.ps1 -Task testDebugUnitTest

[CmdletBinding()]
param(
  [string] $Root = "",
  [ValidateSet("debug", "release")] [string] $Variant = "debug",
  [string] $Task = "",
  [switch] $Clean
)

$ErrorActionPreference = "Stop"

# $Root is resolved here rather than as a param default. `$PSScriptRoot` is empty
# when cmd or a wrapper launches PowerShell on this script's behalf, and a default
# built from it fails during parameter binding - before any output is produced.
if ([string]::IsNullOrEmpty($Root)) {
  $Root = if ([string]::IsNullOrEmpty($PSScriptRoot)) { (Get-Location).Path } else { Split-Path -Parent $PSScriptRoot }
}
if (-not (Test-Path $Root)) { throw "the repository root '$Root' does not exist; pass -Root explicitly" }
$Root = (Resolve-Path $Root).Path

$jdk = Join-Path $Root "tools\android\jdk"
$sdk = Join-Path $Root "tools\android\sdk"
$project = Join-Path $Root "packages\watch-app"

if (-not (Test-Path (Join-Path $jdk "bin\java.exe"))) { throw "JDK missing; run tools\bootstrap-android.ps1" }
if (-not (Test-Path (Join-Path $sdk "platforms\android-35\android.jar"))) { throw "Android SDK missing; run tools\bootstrap-android.ps1" }

# Gradle is run from the extracted distribution rather than a wrapper, so there
# is no bootstrap download on first build and no dependency on a global Gradle.
$gradleHome = Get-ChildItem (Join-Path $Root "tools\android\gradle") -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like "gradle-*" } | Select-Object -First 1
if (-not $gradleHome) {
  $zip = Join-Path $Root "tools\cache\gradle-9.8.0-bin.zip"
  if (-not (Test-Path $zip)) { throw "Gradle distribution missing at $zip; run tools\download.mjs" }
  $stage = Join-Path $Root "tools\android\gradle"
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  Write-Host "extracting Gradle ..."
  $temp = "$zip.extract"
  if (Test-Path $temp) { Remove-Item -Recurse -Force $temp }
  Copy-Item $zip "$temp.zip" -Force
  Expand-Archive -Path "$temp.zip" -DestinationPath $stage -Force
  Remove-Item "$temp.zip" -Force
  $gradleHome = Get-ChildItem $stage -Directory | Where-Object { $_.Name -like "gradle-*" } | Select-Object -First 1
}
$gradle = Join-Path $gradleHome.FullName "bin\gradle.bat"
Write-Host "gradle: $gradle"

$env:JAVA_HOME = $jdk
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:PATH = "$jdk\bin;$sdk\platform-tools;$env:PATH"

$gradleArgs = @(
  "--project-dir", $project,
  "--no-daemon",
  "-Dorg.gradle.jvmargs=-Xmx2560m",
  # The SDK location is passed explicitly so the build needs no local.properties,
  # which keeps machine-specific paths out of the repository.
  "-Dandroid.sdk.location=$sdk"
)
if ($Clean) { $gradleArgs += "clean" }

if ($Task -ne "") {
  $gradleArgs += $Task
} else {
  $gradleArgs += "assemble$($Variant.Substring(0,1).ToUpper())$($Variant.Substring(1))"
}

Write-Host "running: gradle $($gradleArgs -join ' ')"
# Gradle writes progress and errors to stderr, and PowerShell's native-command
# error plumbing swallows it; a log file keeps the real diagnostics readable.
$logPath = Join-Path $Root ".state\logs\gradle-$Variant.log"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logPath) | Out-Null
& $gradle @gradleArgs *> $logPath
$code = $LASTEXITCODE
Get-Content $logPath | Select-Object -Last 120

if ($code -eq 0) {
  $apkDir = Join-Path $project "app\build\outputs\apk\$Variant"
  if (Test-Path $apkDir) {
    Write-Host ""
    Write-Host "APK output:"
    Get-ChildItem $apkDir -Filter *.apk | ForEach-Object {
      Write-Host ("  {0}  ({1:N1} MiB)" -f $_.FullName, ($_.Length / 1MB))
    }
  }
}
exit $code
