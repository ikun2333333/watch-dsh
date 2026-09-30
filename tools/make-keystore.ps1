# Create the signing key for release builds of the watch app.
#
# The release variant is the one worth installing: R8 shrinks it from ~39 MiB to
# ~2.5 MiB and, more importantly for a watch, optimises the code so startup and
# scrolling are far faster than an unoptimised debug build.
#
# The keystore lives under .state/, which is gitignored, so the key is never
# committed. Losing it only means you must uninstall and reinstall the app; it
# signs nothing but this app on your own watch.
#
# Usage:  pwsh -File tools\make-keystore.ps1

[CmdletBinding()]
param(
  [string] $Root = "",
  [string] $Alias = "watchdsh"
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
$keytool = Join-Path $jdk "bin\keytool.exe"
# The keystore lives with the app module, because Gradle resolves the signing
# configuration against that directory. Both files are gitignored.
$moduleDir = Join-Path $Root "packages\watch-app"
$keystore = Join-Path $moduleDir "watchdsh-release.jks"

if (-not (Test-Path $keytool)) { throw "keytool not found at $keytool; run tools\bootstrap-android.ps1 first" }
New-Item -ItemType Directory -Force -Path $moduleDir | Out-Null

if (Test-Path $keystore) {
  Write-Host "keystore already exists: $keystore"
  exit 0
}

# A fixed password is acceptable here and is not a shortcut: this key signs a
# locally built app for one person's watch, it never leaves the machine, and a
# prompted password would break unattended rebuilds. It is recorded next to the
# keystore so the build script can use it without asking.
$password = "watchdsh-local"

# keytool prints its progress to stderr, which PowerShell's strict error
# preference would treat as a failure even on exit code 0; the exit code and the
# resulting file are what actually decide whether this worked.
$previousPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& $keytool -genkeypair `
  -keystore $keystore `
  -alias $Alias `
  -keyalg RSA -keysize 2048 -validity 10000 `
  -storepass $password -keypass $password `
  -dname "CN=watch-dsh, OU=local, O=watch-dsh, L=local, S=local, C=CN" 2>&1 | Out-Null
$keytoolExit = $LASTEXITCODE
$ErrorActionPreference = $previousPreference

if ($keytoolExit -ne 0) { throw "keytool failed with exit code $keytoolExit" }
if (-not (Test-Path $keystore)) { throw "keytool did not create $keystore" }

Set-Content -Path (Join-Path $moduleDir "keystore.properties") -Value @"
storeFile=watchdsh-release.jks
storePassword=$password
keyAlias=$Alias
keyPassword=$password
"@

Write-Host "created signing key:"
Write-Host "  keystore : $keystore"
Write-Host "  alias    : $Alias"
Write-Host "  config   : $moduleDir\keystore.properties"
Write-Host ""
Write-Host "Release builds sign automatically when that config is present."
