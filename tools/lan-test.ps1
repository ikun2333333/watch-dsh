# Start the LAN test setup: relay plus bridge, both reachable from the watch.
#
# This is the fastest way to validate the whole chain, because it needs no
# Cloudflare account, no tunnel, and no public address: the watch talks to this
# PC directly over Wi-Fi. It is also the lower-latency path once it works.
#
# The relay binds every interface so the watch can reach it, while the bridge
# reports this machine's LAN address to paste into the app (0.0.0.0 is not
# dialable).
#
# Usage:  pwsh -File tools\lan-test.ps1
# Stop:   press Ctrl+C in this window (both processes are children of it)

[CmdletBinding()]
param(
  [string] $Root = "",
  [int] $Port = 8787
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
$stateDir = Join-Path $Root ".state"
$tokenFile = Join-Path $stateDir "relay-token"
$logs = Join-Path $stateDir "logs"

if (-not (Test-Path $node)) { throw "node not found at $node" }
New-Item -ItemType Directory -Force -Path $stateDir, $logs | Out-Null

# Reuse an existing token so a watch that is already paired keeps working.
# Generation goes through node's crypto.randomBytes: Get-Random is not a CSPRNG,
# and this token is the trust anchor for who may drive the agent.
if (-not (Test-Path $tokenFile)) {
  $token = & $node (Join-Path $Root "tools\gen-secret.mjs") token
  Set-Content -Path $tokenFile -Value $token -NoNewline
  Write-Host "generated a new relay token at $tokenFile"
}

# Report the address the watch should use, and warn if there is nothing to reach.
$lan = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
  Select-Object -First 1

if (-not $lan) {
  Write-Warning "No LAN IPv4 address found. The watch cannot reach this PC over Wi-Fi right now."
} else {
  Write-Host ""
  Write-Host "  The watch must be on the same Wi-Fi network." -ForegroundColor Cyan
  Write-Host "  Watch's Relay URL will be:  ws://$($lan.IPAddress):$Port" -ForegroundColor Cyan
  Write-Host ""
}

# The relay listens on every interface, and the bridge dials it over loopback.
#
# Dialling the LAN address instead would break the moment DHCP hands this machine
# a different address: the bridge would keep reaching for an address it no longer
# holds. Loopback is always correct, and the bridge already reports the LAN
# address it finds so the banner shows something the watch can dial.
$relayUrl = "ws://127.0.0.1:$Port"

# Starting a second relay on a port that is already taken kills both: the new one
# dies with EADDRINUSE, and the old one's PC link is closed by the new one's
# upgrade handler, which then looks like a mysterious reconnect loop. So a port
# that is already serving is reported rather than raced.
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

if (Test-Port $Port) {
  Write-Host ""
  Write-Host "Something is already listening on port $Port." -ForegroundColor Yellow
  Write-Host "That is usually a bridge from an earlier run. Either use it as-is, or stop it first:"
  Write-Host ""
  Write-Host "  Get-Process node | Where-Object { `$_.Path -like '*watch-dsh*' } | Stop-Process -Force"
  Write-Host ""
  Write-Host "Or run this with another port:  .\tools\lan-test.ps1 -Port 8790" -ForegroundColor Cyan
  $running = Get-Content (Join-Path $logs "bridge.log") -ErrorAction SilentlyContinue | Select-Object -Last 12
  if ($running) {
    Write-Host ""
    Write-Host "The running bridge last reported:" -ForegroundColor Cyan
    $running | Write-Host
  }
  exit 1
}

Write-Host "starting relay on 0.0.0.0:$Port ..." -ForegroundColor Green
$relay = Start-Process -FilePath $node -PassThru -NoNewWindow -ArgumentList @(
  (Join-Path $Root "packages\dsh-bridge\src\relay.mjs"),
  "--port", "$Port", "--host", "0.0.0.0", "--token-file", $tokenFile
) -RedirectStandardOutput (Join-Path $logs "relay.log") -RedirectStandardError (Join-Path $logs "relay.err")

Start-Sleep -Seconds 3

Write-Host "starting bridge ..." -ForegroundColor Green
$bridge = Start-Process -FilePath $node -PassThru -NoNewWindow -ArgumentList @(
  (Join-Path $Root "packages\dsh-bridge\src\main.mjs"),
  "--relay", $relayUrl,
  "--token-file", $tokenFile,
  "--state", $stateDir
) -RedirectStandardOutput (Join-Path $logs "bridge.log") -RedirectStandardError (Join-Path $logs "bridge.err")

Start-Sleep -Seconds 6

# A relay that died immediately is the one failure worth naming precisely, since
# its symptom (the bridge retrying forever) does not point at the cause.
if ($relay.HasExited) {
  Write-Host ""
  Write-Host "The relay exited immediately (code $($relay.ExitCode))." -ForegroundColor Red
  Get-Content (Join-Path $logs "relay.err") -ErrorAction SilentlyContinue | Write-Host
  if ($bridge -and -not $bridge.HasExited) { Stop-Process -Id $bridge.Id -Force -ErrorAction SilentlyContinue }
  exit 1
}

# Surface the pairing banner, which is the whole point of starting these.
Write-Host ""
Get-Content (Join-Path $logs "bridge.log") -ErrorAction SilentlyContinue | Write-Host
$bridgeErr = Get-Content (Join-Path $logs "bridge.err") -ErrorAction SilentlyContinue
if ($bridgeErr) { Write-Host "bridge stderr:" -ForegroundColor Yellow; $bridgeErr | Write-Host }
$relayErr = Get-Content (Join-Path $logs "relay.err") -ErrorAction SilentlyContinue
if ($relayErr) { Write-Host "relay stderr:" -ForegroundColor Yellow; $relayErr | Write-Host }

Write-Host ""
Write-Host "Both are running. Logs:" -ForegroundColor Green
Write-Host "  $logs\relay.log"
Write-Host "  $logs\bridge.log"
Write-Host ""
Write-Host "Press Ctrl+C to stop both."

# Wait-Process raises if either process has already exited, which happens on a
# normal Ctrl+C and would otherwise print a misleading "no process found" error.
$exitCode = 0
try {
  $ids = @($relay.Id, $bridge.Id) | Where-Object { $_ }
  while ($true) {
    $alive = @($ids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    if ($alive.Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
  }
} catch {
  $exitCode = 1
  Write-Host ""
  Write-Host "LAN setup stopped: $($_.Exception.Message)" -ForegroundColor Red
} finally {
  foreach ($process in @($relay, $bridge)) {
    if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  }
  Write-Host "stopped."
}
exit $exitCode
