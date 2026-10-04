# Deploy the Cloudflare Worker relay, for using the watch away from home.
#
# Why a Worker: your PC is behind NAT and has no public address, so something with
# a stable public name has to be reachable by both sides. A Worker is the cheapest
# such thing - a free Cloudflare account covers it, there is no server to keep
# running, and the free tier allows 100k requests a day, which this use is nowhere
# near. Both the bridge and the watch then dial *out* to it, which is why no port
# forwarding and no static IP are needed.
#
# The Worker never sees a prompt, a reply, or an approval. Those are sealed end to
# end with AES-256-GCM under the pairing secret, which the Worker does not have.
# It routes opaque frames by pc id and cannot read what it carries.
#
# Usage:  .\tools\deploy-relay.ps1
#
# One step cannot be automated: `wrangler login` opens a browser and needs your
# approval. This script stops there with instructions rather than pretending it
# can proceed.

[CmdletBinding()]
param(
  [string] $Root = "",
  [string] $WorkerName = "watch-dsh-relay",
  # Where wrangler is installed. Kept inside the project so nothing global changes.
  [string] $WranglerVersion = "4"
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrEmpty($Root)) {
  $Root = if ([string]::IsNullOrEmpty($PSScriptRoot)) { (Get-Location).Path } else { Split-Path -Parent $PSScriptRoot }
}
$Root = (Resolve-Path $Root).Path

$node = Join-Path $Root "tools\node\node.exe"
$npm = "C:\Users\q1375\AppData\Local\Programs\node-v24.19.0-win-x64\npm.cmd"
$bridgeDir = Join-Path $Root "packages\dsh-bridge"
$stateDir = Join-Path $Root ".state"
$tokenFile = Join-Path $stateDir "relay-token"

foreach ($tool in @($node, $npm)) {
  if (-not (Test-Path $tool)) { throw "missing $tool" }
}
if (-not (Test-Path (Join-Path $bridgeDir "wrangler.toml"))) {
  throw "missing wrangler.toml in $bridgeDir"
}

# npm and wrangler write progress to stderr, which the strict preference above
# would treat as fatal. The exit code decides whether a step worked.
function Invoke-Tool {
  param([string] $Command, [string[]] $Arguments, [string] $WorkingDirectory)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & $Command @Arguments 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  return @{ Output = $output; Code = $code }
}

function Write-Step([string] $Message) { Write-Host "==> $Message" -ForegroundColor Green }
function Write-Note([string] $Message) { Write-Host "    $Message" -ForegroundColor DarkGray }

# --- 1. a relay token must exist, because the Worker needs the same one ---------
Write-Step "checking the relay token"
if (-not (Test-Path $tokenFile)) {
  $generated = Invoke-Tool $node @((Join-Path $Root "tools\gen-secret.mjs"), "token") $Root
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
  Set-Content -Path $tokenFile -Value ($generated.Output | Select-Object -First 1) -NoNewline
  Write-Note "generated a new relay token"
}
$token = (Get-Content $tokenFile -Raw).Trim()
if ($token.Length -lt 32) { throw "the relay token at $tokenFile looks too short to be one" }
Write-Note "using the token already at .state\relay-token ($($token.Length) characters)"

# --- 2. wrangler, installed locally so nothing global changes -------------------
Write-Step "installing wrangler (once, into the project)"
# npm hoists to the nearest existing node_modules, which for this layout is the
# repository root rather than packages/dsh-bridge, so both are searched rather than
# assuming one. The earlier version assumed the bridge directory and reported
# "could not be installed" while wrangler was in fact installed and working.
function Find-Wrangler {
  foreach ($base in @($Root, $bridgeDir)) {
    $candidate = Join-Path $base "node_modules\wrangler\bin\wrangler.js"
    if (Test-Path $candidate) { return $candidate }
  }
  return $null
}

$localWrangler = Find-Wrangler
if ($localWrangler) {
  Write-Note "already installed at $localWrangler"
} else {
  Write-Note "this downloads a few tens of MiB and may take a minute"
  $install = Invoke-Tool $npm @("install", "--prefix", $bridgeDir, "--no-save", "--no-audit", "--no-fund", "wrangler@$WranglerVersion") $bridgeDir
  $localWrangler = Find-Wrangler
  if ($install.Code -ne 0 -or -not $localWrangler) {
    Write-Host ""
    Write-Host "wrangler could not be installed." -ForegroundColor Red
    $install.Output | Select-Object -Last 15 | ForEach-Object { Write-Host "    $_" }
    throw "npm install wrangler failed"
  }
}
Write-Note "wrangler $((& $node $localWrangler --version 2>&1 | Select-Object -First 1)) at $localWrangler"

# wrangler must run from a directory it was installed for, or it cannot resolve its
# own dependencies.
$wranglerRoot = Split-Path (Split-Path (Split-Path $localWrangler -Parent) -Parent) -Parent

function Invoke-Wrangler {
  param([string[]] $Arguments, [switch] $AllowFailure)
  # Run from the layer wrangler was installed into, which is where wrangler.toml is
  # found relative to as well.
  $result = Invoke-Tool $node (@($localWrangler) + $Arguments) $bridgeDir
  if (-not $AllowFailure -and $result.Code -ne 0) {
    throw "wrangler $($Arguments -join ' ') failed (exit $($result.Code)):`n$($result.Output | Out-String)"
  }
  return $result
}

# --- 3. is this machine already signed in? -------------------------------------
Write-Step "checking Cloudflare sign-in"
$whoami = Invoke-Wrangler @("whoami") -AllowFailure
$signedIn = $whoami.Code -eq 0 -and ($whoami.Output | Out-String) -match "You are logged in|associated with the account"

if (-not $signedIn) {
  Write-Host ""
  Write-Host "Cloudflare sign-in is needed, and only you can do it." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Run this in a terminal, approve it in the browser it opens, then run this" -ForegroundColor Cyan
  Write-Host "script again:" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "  cd $bridgeDir"
  Write-Host "  `"$node`" `"$localWrangler`" login"
  Write-Host ""
  Write-Host "No Cloudflare account yet? Create a free one at https://dash.cloudflare.com/sign-up" -ForegroundColor Cyan
  Write-Host "(email and password only; no domain and no payment method needed)." -ForegroundColor Cyan
  Write-Host ""
  Write-Host "What wrangler said:" -ForegroundColor DarkGray
  $whoami.Output | Select-Object -Last 6 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
  exit 3
}
Write-Note ($whoami.Output | Select-Object -First 3 | Out-String).Trim()

# --- 4. the shared token becomes a Worker secret -------------------------------
Write-Step "setting the RELAY_TOKEN secret"
# `--stdin` reads the value from the pipe, which keeps the token out of the command
# line and therefore out of any process listing.
$previous = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  $secretOutput = ($token | & $node $localWrangler secret put RELAY_TOKEN --stdin 2>&1 | Out-String)
  $secretCode = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $previous
}
if ($secretCode -ne 0) {
  Write-Host ""
  Write-Host "Setting the secret failed." -ForegroundColor Red
  ($secretOutput -split "`n") | Select-Object -Last 10 | ForEach-Object { Write-Host "    $_" }
  Write-Host ""
  Write-Host "Set it by hand instead, pasting this value when prompted:" -ForegroundColor Yellow
  Write-Host "  cd $bridgeDir ; `"$node`" `"$localWrangler`" secret put RELAY_TOKEN" -ForegroundColor Yellow
  exit 4
}
Write-Note $secretOutput.Trim()

# --- 5. deploy ------------------------------------------------------------------
Write-Step "deploying the Worker"
$deploy = Invoke-Wrangler @("deploy")
$deployText = ($deploy.Output | Out-String)
$deploy.Output | Where-Object { $_ -match "workers.dev|Deployed|Uploaded|https://" } | ForEach-Object { Write-Note "$_" }

$url = [regex]::Match($deployText, 'https://[a-z0-9.\-]+\.workers\.dev').Value
if ([string]::IsNullOrEmpty($url)) {
  Write-Host ""
  Write-Host "The Worker deployed, but its URL could not be read from the output above." -ForegroundColor Yellow
  Write-Host "Copy the https://....workers.dev address wrangler printed." -ForegroundColor Yellow
} else {
  $wss = $url -replace '^https://', 'wss://'
  Write-Host ""
  Write-Host "Deployed: $url" -ForegroundColor Green
  Write-Host ""
  Write-Host "The watch's Relay URL is:" -ForegroundColor Cyan
  Write-Host "  $wss" -ForegroundColor Cyan

  # --- 6. verify it actually answers -------------------------------------------
  Write-Step "checking the relay answers"
  $check = Invoke-Tool $node @("-e", "const r = await fetch('$url/healthz'); console.log(r.status, (await r.text()).trim());") $Root
  $check.Output | ForEach-Object { Write-Note "$_" }

  # --- 7. write the watch config for this relay --------------------------------
  Write-Step "writing a watch config pointing at the Worker"
  $configOut = Join-Path $stateDir "watch-config-remote.json"
  $config = Invoke-Tool $node @(
    (Join-Path $bridgeDir "src\main.mjs"),
    "--relay", $wss,
    "--token-file", $tokenFile,
    "--state", $stateDir,
    "--write-config"
  ) $Root
  $config.Output | Where-Object { $_ -match "wrote a watch config" } | ForEach-Object { Write-Note "$_" }
  if (Test-Path (Join-Path $stateDir "watch-config.json")) {
    Move-Item (Join-Path $stateDir "watch-config.json") $configOut -Force
    Write-Note "config written to .state\watch-config-remote.json"
  }

  Write-Host ""
  Write-Host "Next:" -ForegroundColor Cyan
  Write-Host "  1. Restart the bridge pointed at the Worker:"
  Write-Host "       node packages\dsh-bridge\src\main.mjs --relay $wss ``"
  Write-Host "           --token-file .state\relay-token --state .state"
  Write-Host "  2. On the watch, enter that wss:// URL as the Relay URL."
  Write-Host "     The relay token and pairing secret are unchanged."
  Write-Host ""
  Write-Host "The bridge must keep running for the watch to reach the Harness." -ForegroundColor Yellow
}
