# Run every test that does not need a watch.
#
# These cover the parts where a mistake is invisible or very expensive to find:
# the sealing implementation, the discovery and pairing handshake, the full chain
# from a simulated watch through the relay to the Harness, and the config file's
# refresh rules. Each of them caught a real defect during development.
#
# The watch app itself is not exercised here; that needs the device.
#
# Usage:  .\tools\test-all.ps1

[CmdletBinding()]
param([string] $Root = "")

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrEmpty($Root)) {
  $Root = if ([string]::IsNullOrEmpty($PSScriptRoot)) { (Get-Location).Path } else { Split-Path -Parent $PSScriptRoot }
}
$Root = (Resolve-Path $Root).Path

$node = Join-Path $Root "tools\node\node.exe"
if (-not (Test-Path $node)) { throw "missing $node; run tools\bootstrap-android.ps1 first" }

# The bridge must resolve `ws` and locate the Harness home without help, because
# that is how a launcher runs it. Clearing these proves the fallbacks work rather
# than relying on an environment only a development shell has.
$env:DSH_HOME = $null
$env:DSH_WEB_URL = $null

# --- make sure a relay and bridge are up ---------------------------------------
# The suites talk to a running bridge, and a stale one is worse than none: it may
# hold a different pc id, which makes a correctly-written test fail for a reason
# that has nothing to do with the code under test.
function Test-Port([int] $PortNumber) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $client.Connect("127.0.0.1", $PortNumber)
    return $true
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

$stateDir = Join-Path $Root ".state"
$logDir = Join-Path $stateDir "logs"
$tokenFile = Join-Path $stateDir "relay-token"
$configPath = Join-Path $stateDir "watch-config.json"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

if (-not (Test-Path $tokenFile)) {
  $token = & $node (Join-Path $Root "tools\gen-secret.mjs") token
  Set-Content -Path $tokenFile -Value $token -NoNewline
}

# The bridge is a client of the Harness and exits at once when it cannot reach it,
# so a missing Harness surfaces as "no bridge answered the probe" - which points at
# discovery rather than at the actual cause. Checked here so the message names the
# real problem.
#
# Which port matters, and guessing 3080 is wrong whenever the Harness was launched
# elsewhere: DSH_WEB_URL names the one actually running, and the bridge prefers that
# variable over its own default, so testing 3080 while the Harness serves 19387
# starts a second Harness the bridge then ignores.
$dshUrl = $env:DSH_WEB_URL
if ([string]::IsNullOrEmpty($dshUrl)) { $dshUrl = "http://127.0.0.1:3080" }
$dshPort = ([Uri]$dshUrl).Port
if ($dshPort -le 0) { $dshPort = 3080 }

if (-not (Test-Port $dshPort)) {
  $dshEntry = "C:\Users\q1375\AppData\Local\Programs\node-v24.19.0-win-x64\node_modules\@deepseek-ai\dsh\lib\bin.js"
  if (Test-Path $dshEntry) {
    Write-Host "starting the Harness on $dshPort (the bridge needs it) ..." -ForegroundColor Green
    Start-Process -FilePath $node -WindowStyle Hidden `
      -ArgumentList @($dshEntry, "web", "--port", "$dshPort", "--no-open") `
      -RedirectStandardOutput (Join-Path $logDir "dsh.log") -RedirectStandardError (Join-Path $logDir "dsh.err")
    Start-Sleep -Seconds 12
  }
  if (-not (Test-Port $dshPort)) {
    Write-Host ""
    Write-Host "The Harness is not serving on $dshPort, and the bridge cannot run without it." -ForegroundColor Red
    Get-Content (Join-Path $logDir "dsh.err") -ErrorAction SilentlyContinue | Select-Object -First 8 | ForEach-Object { Write-Host "    $_" }
    throw "start the Harness first: dsh web --port $dshPort --no-open"
  }
}
Write-Host "harness: $dshUrl" -ForegroundColor DarkGray

# A listening port is not enough to conclude the local relay is usable: a bridge
# may be attached to a *remote* relay (the away-from-home setup), in which case the
# local relay has no bridge on it and every suite times out waiting for hello. That
# looks identical to a broken bridge, so the bridge's own log is checked for which
# relay it actually joined.
function Get-AttachedRelay {
  $log = Join-Path $logDir "bridge.log"
  if (-not (Test-Path $log)) { return $null }
  $match = Select-String -Path $log -Pattern 'attached to relay as pc ".*" \((.+)\)' |
    Select-Object -Last 1
  if (-not $match) { return $null }
  return [regex]::Match($match.Line, '\((.+)\)').Groups[1].Value
}

$localRelay = "ws://127.0.0.1:8787"
$attached = Get-AttachedRelay
$needsBridge = (-not (Test-Port 8787)) -or ($attached -notmatch '^ws://(127\.0\.0\.1|192\.168\.)')

if ($needsBridge) {
  if ($attached -and $attached -notmatch '^ws://(127\.0\.0\.1|192\.168\.)') {
    Write-Host "the running bridge is attached to $attached (a remote relay);" -ForegroundColor Yellow
    Write-Host "starting a local one for these tests so the suites are not measuring that." -ForegroundColor Yellow
  } else {
    Write-Host "starting the relay and the bridge for the tests ..." -ForegroundColor Green
  }

  # If a relay already holds the port, leave it; only the bridge has to be replaced.
  if (-not (Test-Port 8787)) {
    Start-Process -FilePath $node -WindowStyle Hidden `
      -ArgumentList @((Join-Path $Root "packages\dsh-bridge\src\relay.mjs"), "--port", "8787",
        "--host", "0.0.0.0", "--token-file", $tokenFile) `
      -RedirectStandardOutput (Join-Path $logDir "relay.log") -RedirectStandardError (Join-Path $logDir "relay.err")
    Start-Sleep -Seconds 3
    if (-not (Test-Port 8787)) { throw "the relay did not start; see $logDir\relay.err" }
  }

  # Every bridge is stopped, not merely the ones pointed at a remote relay.
  #
  # A relay keeps one bridge per pc id, so a second bridge silently replaces the
  # first: the displaced process stays alive, keeps its own view of which watches
  # exist, and goes on answering frames with stale state. Two of them running is
  # what made the pairing suite fail against a bridge whose log showed a watch id
  # from an earlier run - the tests were talking to one process while another held
  # the slot. Starting from none is the only reliable state.
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*dsh-bridge*main.mjs*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2

  Start-Process -FilePath $node -WindowStyle Hidden `
    -ArgumentList @((Join-Path $Root "packages\dsh-bridge\src\main.mjs"), "--relay", $localRelay,
      "--token-file", $tokenFile, "--state", $stateDir) `
    -RedirectStandardOutput (Join-Path $logDir "bridge.log") -RedirectStandardError (Join-Path $logDir "bridge.err")
  Start-Sleep -Seconds 7
}

# The pc id is whatever the running bridge uses, and only the config file knows
# it. There is no sensible default: a wrong one makes the suites dial a pc that is
# not attached and hang, which looks exactly like a broken bridge.
$pcId = $null
if (Test-Path $configPath) {
  $configured = (Get-Content $configPath -Raw | ConvertFrom-Json).pcId
  if ($configured) { $pcId = $configured }
}
if (-not $pcId) {
  # Before a first pairing there is no config, so the bridge's own default applies.
  $pcId = [System.Net.Dns]::GetHostName().ToLower() -replace '[^a-z0-9-]', '-'
}
$lanAddress = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -like "192.168.*" -or $_.IPAddress -like "10.*" } |
  Select-Object -First 1).IPAddress
$relayUrl = if ($lanAddress) { "ws://${lanAddress}:8787" } else { "ws://127.0.0.1:8787" }
Write-Host "testing against pc=$pcId relay=$relayUrl" -ForegroundColor Cyan

$suites = @(
  @{ Name = "config refresh"; Script = "packages\dsh-bridge\test\config-refresh.mjs"; Args = @() },
  @{ Name = "discovery + pairing"; Script = "packages\dsh-bridge\test\discovery.mjs"; Args = @() },
  @{ Name = "end to end"; Script = "packages\dsh-bridge\test\e2e.mjs"; Args = @("--relay", $relayUrl, "--pc", $pcId, "--seconds", "60") }
)

$failed = @()
foreach ($suite in $suites) {
  $path = Join-Path $Root $suite.Script
  if (-not (Test-Path $path)) {
    Write-Host "SKIP  $($suite.Name) - not present" -ForegroundColor Yellow
    continue
  }
  Write-Host ""
  Write-Host "=== $($suite.Name) ===" -ForegroundColor Cyan
  # Node writes ordinary diagnostics to stderr, which the strict preference above
  # would treat as a fatal error. The exit code is what decides pass or fail.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & $node $path @($suite.Args) 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  $output | ForEach-Object { Write-Host "  $_" }
  if ($code -ne 0) { $failed += $suite.Name }
}

Write-Host ""
if ($failed.Count -eq 0) {
  Write-Host "All suites passed." -ForegroundColor Green
  exit 0
}
Write-Host "Failed: $($failed -join ', ')" -ForegroundColor Red
exit 1
