# Android toolchain bootstrap for watch-dsh.
#
# Installs into <repo>\tools\android:
#   jdk\            Temurin JDK 21 (runs Gradle and sdkmanager)
#   cmdline-tools\  Android command-line tools
#   sdk\            platform-tools, platforms, build-tools
#
# Downloads go through tools\download.mjs because PowerShell and curl cannot
# reach the network in this environment while Node can.
#
# Usage:  pwsh -File tools\bootstrap-android.ps1
# Re-running is safe: each step is skipped when its output already exists.

[CmdletBinding()]
param(
  [string] $Root = "",
  # Wear Compose 1.7 requires compiling against API 37 or later, which in this
  # SDK channel exists only as a preview platform. The build script uses the
  # same level, so both stay in step.
  [string] $CompileSdk = "37",
  [string] $BuildTools = "36.0.0"
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
$node = Join-Path $Root "tools\node\node.exe"
if (-not (Test-Path $node)) { throw "node not found at $node; run tools\get-node.ps1 first" }
$download = Join-Path $Root "tools\download.mjs"
$cache = Join-Path $Root "tools\cache"
$android = Join-Path $Root "tools\android"
$jdkDir = Join-Path $android "jdk"
$sdkDir = Join-Path $android "sdk"
$cmdlineDir = Join-Path $android "cmdline-tools"

New-Item -ItemType Directory -Force -Path $cache, $android, $sdkDir | Out-Null

function Invoke-Download([string]$Url, [string]$Destination, [string]$Sha256) {
  if (Test-Path $Destination) { Write-Host "cached: $Destination"; return }
  $arguments = @($download, $Url, $Destination)
  if ($Sha256) { $arguments += @("--sha256", $Sha256) }
  & $node @arguments
  if ($LASTEXITCODE -ne 0) { throw "download failed: $Url" }
}

# --- 1. JDK 21 -----------------------------------------------------------------
$jdkZip = Join-Path $cache "jdk21.zip"
if (-not (Test-Path (Join-Path $jdkDir "bin\java.exe"))) {
  Invoke-Download `
    "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jdk_x64_windows_hotspot_21.0.12.1_1.zip" `
    $jdkZip `
    "f9d6e191ab098c0d416e7d588a24420a8621cd2f4720dab2459b8b7b2d2d8b4e"
  Write-Host "extracting JDK ..."
  $stage = Join-Path $android "jdk-stage"
  if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
  Expand-Archive -Path $jdkZip -DestinationPath $stage -Force
  # The archive contains one jdk-21.x.x+x directory; promote it to tools\android\jdk.
  $inner = Get-ChildItem $stage -Directory | Select-Object -First 1
  Move-Item -Path $inner.FullName -Destination $jdkDir
  Remove-Item -Recurse -Force $stage
} else {
  Write-Host "cached: $jdkDir"
}
$javaHome = $jdkDir
Write-Host "JAVA_HOME = $javaHome"

# --- 2. command-line tools -----------------------------------------------------
$cmdlineZip = Join-Path $cache "cmdline-tools.zip"
if (-not (Test-Path (Join-Path $cmdlineDir "latest\bin\sdkmanager.bat"))) {
  Invoke-Download "https://dl.google.com/android/repository/commandlinetools-win-16111833_latest.zip" $cmdlineZip
  Write-Host "extracting command-line tools ..."
  $stage = Join-Path $android "cmdline-stage"
  if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
  Expand-Archive -Path $cmdlineZip -DestinationPath $stage -Force
  # sdkmanager only works from a directory literally named `latest`.
  New-Item -ItemType Directory -Force -Path $cmdlineDir | Out-Null
  if (Test-Path (Join-Path $cmdlineDir "latest")) { Remove-Item -Recurse -Force (Join-Path $cmdlineDir "latest") }
  Move-Item -Path (Join-Path $stage "cmdline-tools") -Destination (Join-Path $cmdlineDir "latest")
  Remove-Item -Recurse -Force $stage
} else {
  Write-Host "cached: $cmdlineDir\latest"
}

# --- 3. SDK packages -----------------------------------------------------------
$sdkmanager = Join-Path $cmdlineDir "latest\bin\sdkmanager.bat"
$androidCli = Join-Path $cmdlineDir "latest\bin\android.exe"
$env:JAVA_HOME = $javaHome
$env:ANDROID_HOME = $sdkDir
$env:ANDROID_SDK_ROOT = $sdkDir
$env:PATH = "$javaHome\bin;$env:PATH"

# This cmdline-tools generation deprecates `sdkmanager` in favour of
# `android sdk`, and its sdkmanager exits with a stack overflow even after a
# successful install; the newer interface is used whenever it is present.
$useAndroidCli = Test-Path $androidCli
Write-Host "installer: $(if ($useAndroidCli) { 'android sdk' } else { 'sdkmanager' })"

function Install-Package([string] $Package, [switch] $AllowPreview) {
  if ($useAndroidCli) {
    $cliArgs = @("sdk", "install", "--sdk=$sdkDir")
    if ($AllowPreview) { $cliArgs += "--beta" }
    $cliArgs += $Package
    & $androidCli @cliArgs 2>&1 | Select-Object -Last 3
  } else {
    $answers = ("y`n" * 40)
    $answers | & $sdkmanager --sdk_root=$sdkDir $Package 2>&1 | Select-Object -Last 3
  }
}

if (-not $useAndroidCli) {
  Write-Host "accepting SDK licenses ..."
  $answers = ("y`n" * 40)
  $answers | & $sdkmanager --sdk_root=$sdkDir --licenses 2>&1 | Select-Object -Last 5
}

foreach ($package in @("platform-tools", "build-tools;$BuildTools")) {
  Write-Host "installing $package ..."
  Install-Package $package
}

Write-Host "installing platforms;android-$CompileSdk ..."
Install-Package "platforms;android-$CompileSdk"
# A preview platform is listed only in the beta channel, so retry there before
# failing: the caller needs a usable android.jar, not a specific channel.
if (-not (Test-Path (Join-Path $sdkDir "platforms\android-$CompileSdk\android.jar"))) {
  Write-Host "retrying platforms;android-$CompileSdk from the preview channel ..."
  Install-Package "platforms;android-$CompileSdk" -AllowPreview
}
if (-not (Test-Path (Join-Path $sdkDir "platforms\android-$CompileSdk\android.jar"))) {
  throw "platform android-$CompileSdk is not installed; pass -CompileSdk with a published level"
}

Write-Host ""
Write-Host "Android toolchain ready:"
Write-Host "  JAVA_HOME   = $javaHome"
Write-Host "  ANDROID_HOME= $sdkDir"
& (Join-Path $sdkDir "platform-tools\adb.exe") version
