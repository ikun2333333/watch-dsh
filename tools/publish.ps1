# Publish this repository to GitHub.
#
# The first push needs one interactive step that cannot be automated: GitHub
# authentication. Git Credential Manager opens a browser, you approve, and the
# token it obtains is reused afterwards. This script does everything else, and
# stops with a clear message if a step needs you.
#
# Usage:
#   .\tools\publish.ps1                          # public repo named watch-dsh
#   .\tools\publish.ps1 -Name my-name -Private

[CmdletBinding()]
param(
  [string] $Root = "",
  [string] $Name = "watch-dsh",
  [string] $Owner = "",
  [switch] $Private,
  [string] $Description = "Control DeepSeek Harness from a Samsung Galaxy Watch 6"
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrEmpty($Root)) {
  $Root = if ([string]::IsNullOrEmpty($PSScriptRoot)) { (Get-Location).Path } else { Split-Path -Parent $PSScriptRoot }
}
$Root = (Resolve-Path $Root).Path

# --- 1. find git ---------------------------------------------------------------
# MinGit is installed per-user by winget and is not on PATH in a shell that
# started before the install, so it is located explicitly.
function Find-Git {
  $fromPath = Get-Command git -ErrorAction SilentlyContinue
  if ($fromPath) { return $fromPath.Source }
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"),
    (Join-Path $env:LOCALAPPDATA "Programs"),
    "C:\Program Files"
  )
  foreach ($base in $candidates) {
    if (-not (Test-Path $base)) { continue }
    $found = Get-ChildItem $base -Recurse -Filter "git.exe" -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match '\\cmd\\git\.exe$' } | Select-Object -First 1
    if ($found) { return $found.FullName }
  }
  throw "git was not found. Install it with:  winget install --id Git.MinGit"
}

$git = Find-Git
Write-Host "git: $git" -ForegroundColor DarkGray

# Git writes progress to stderr, which the strict preference above would treat as
# a fatal error; the exit code is what decides whether a step worked.
function Invoke-Git {
  param([string[]] $Arguments, [switch] $AllowFailure)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & $git -C $Root @Arguments 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  if (-not $AllowFailure -and $code -ne 0) {
    throw "git $($Arguments -join ' ') failed (exit $code):`n$(($output | Out-String).Trim())"
  }
  return $output
}

if (-not (Test-Path (Join-Path $Root ".git"))) {
  throw "no git repository at $Root; run this from the project root"
}

# --- 2. refuse to publish secrets ----------------------------------------------
# Publishing a token or a signing key is not recoverable by deleting the commit:
# it stays in the repository's history and in any fork. So this is checked before
# anything leaves the machine.
Write-Host ""
Write-Host "[1] checking that nothing sensitive is tracked" -ForegroundColor Green
$tracked = Invoke-Git @("ls-files")
$forbidden = $tracked | Where-Object {
  $_ -like '.state/*' -or
  $_ -like '*.jks' -or $_ -like '*.keystore' -or
  $_ -like '*/keystore.properties' -or
  $_ -like '*/watch-config.json' -or
  $_ -like '*/pairing-secret' -or $_ -like '*/relay-token' -or
  $_ -like '*.apk' -or $_ -like '*.aab'
}
if ($forbidden) {
  Write-Host "  these tracked files must not be published:" -ForegroundColor Red
  $forbidden | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
  throw "remove them from the index first (git rm --cached <path>) and add them to .gitignore"
}

# A credential value in a tracked text file is the same mistake in a different
# shape, and is easy to make by pasting real command output into a document.
$stateDir = Join-Path $Root ".state"
$secrets = @()
foreach ($file in @("relay-token", "pairing-secret")) {
  $path = Join-Path $stateDir $file
  if (Test-Path $path) { $secrets += (Get-Content $path -Raw).Trim() }
}
if (Test-Path (Join-Path $stateDir "watch-config.json")) {
  $config = Get-Content (Join-Path $stateDir "watch-config.json") -Raw | ConvertFrom-Json
  if ($config.relayToken) { $secrets += $config.relayToken }
  if ($config.pairingSecret) { $secrets += $config.pairingSecret }
}
$leaks = @()
foreach ($relative in $tracked) {
  $full = Join-Path $Root $relative
  if (-not (Test-Path $full)) { continue }
  $text = Get-Content $full -Raw -ErrorAction SilentlyContinue
  if (-not $text) { continue }
  foreach ($secret in $secrets) {
    if ($secret.Length -gt 8 -and $text.Contains($secret)) { $leaks += $relative; break }
  }
}
if ($leaks) {
  Write-Host "  real credentials appear in tracked files:" -ForegroundColor Red
  $leaks | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
  throw "replace the credential values with placeholders before publishing"
}
Write-Host "  clean: $($tracked.Count) tracked files, no credentials or build output" -ForegroundColor DarkGray

# --- 3. make sure there is something to push -----------------------------------
Write-Host ""
Write-Host "[2] checking the commit" -ForegroundColor Green
$status = Invoke-Git @("status", "--porcelain")
if ($status) {
  Write-Host "  uncommitted changes:" -ForegroundColor Yellow
  $status | Select-Object -First 10 | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
  Write-Host "  commit them first, or they will not be published" -ForegroundColor Yellow
}
$head = (Invoke-Git @("rev-parse", "--short", "HEAD") | Select-Object -First 1)
$subject = (Invoke-Git @("log", "-1", "--pretty=%s") | Select-Object -First 1)
Write-Host "  HEAD $head - $subject" -ForegroundColor DarkGray

# --- 4. work out the remote ----------------------------------------------------
Write-Host ""
Write-Host "[3] resolving the remote" -ForegroundColor Green
$existing = Invoke-Git @("remote", "get-url", "origin") -AllowFailure
if ($LASTEXITCODE -eq 0 -and $existing) {
  Write-Host "  origin already set to $($existing | Select-Object -First 1)" -ForegroundColor DarkGray
} else {
  if ([string]::IsNullOrEmpty($Owner)) {
    # Ask GitHub who the stored credential belongs to, so the URL is right without
    # the user having to know their own login name.
    Write-Host "  no origin yet; determining your GitHub account" -ForegroundColor DarkGray
    $login = $null
    try {
      $api = Invoke-RestMethod -Uri "https://api.github.com/user" -Headers @{ "User-Agent" = "watch-dsh" } -TimeoutSec 15
      $login = $api.login
    } catch {
      $login = $null
    }
    if (-not $login) {
      throw @"
Could not determine your GitHub account without signing in.

Either pass it explicitly:
  .\tools\publish.ps1 -Owner <your-github-login>

or create the repository in the browser at https://github.com/new (name: $Name,
public, and do NOT add a README or .gitignore), then run this script again.
"@
    }
    $Owner = $login
    Write-Host "  account: $Owner" -ForegroundColor DarkGray
  }
  $url = "https://github.com/$Owner/$Name.git"
  Invoke-Git @("remote", "add", "origin", $url) | Out-Null
  Write-Host "  origin -> $url" -ForegroundColor DarkGray
}

# --- 5. push -------------------------------------------------------------------
Write-Host ""
Write-Host "[4] pushing to GitHub" -ForegroundColor Green
Write-Host "  If a browser window opens, approve the sign-in for GitHub." -ForegroundColor Cyan
Write-Host "  That approval happens once; the credential is reused afterwards." -ForegroundColor Cyan
Write-Host ""

$previous = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  $pushOutput = & $git -C $Root push -u origin main 2>&1
  $pushCode = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $previous
}
$pushOutput | ForEach-Object { Write-Host "    $_" }

if ($pushCode -ne 0) {
  Write-Host ""
  Write-Host "The push did not succeed." -ForegroundColor Red
  Write-Host "The usual cause is that https://github.com/$Owner/$Name does not exist yet." -ForegroundColor Yellow
  Write-Host "Create it at https://github.com/new with no README and no .gitignore," -ForegroundColor Yellow
  Write-Host "then run this script again." -ForegroundColor Yellow
  exit 1
}

$remote = (Invoke-Git @("remote", "get-url", "origin") | Select-Object -First 1) -replace '\.git$', ''
Write-Host ""
Write-Host "Published: $remote" -ForegroundColor Green
Write-Host ""
Write-Host "Next, on GitHub:" -ForegroundColor Cyan
Write-Host "  - add topics so it can be found: deepseek, wear-os, galaxy-watch, kotlin, self-hosted"
Write-Host "  - the README explains the security model; keep it current if you change the protocol"
