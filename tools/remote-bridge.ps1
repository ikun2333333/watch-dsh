# Start the bridge so a watch on mobile data can reach this PC.
#
# The LAN scripts put a relay on the local network and point the bridge at it. This
# one is the opposite case: the watch is away, so both sides dial out to a public
# relay instead. There is no local listener and no port forwarding involved - this
# PC connects out to the relay, the watch connects out to the same relay, and the
# relay routes between them.
#
# That means this window is the link. Close it and the watch has nothing to reach,
# which is the one operational cost of using the watch away from home.
#
# Usage:  .\tools\remote-bridge.ps1
# Stop:   press Ctrl+C in this window

[CmdletBinding()]
param(
  [string] $Root = "",
  [string] $Relay = "wss://kangjunyu.dpdns.org",
  [string] $DshUrl = ""
)

$ErrorActionPreference = "Stop"

# $Root is resolved here rather than as a param default: $PSScriptRoot is empty when
# cmd launches PowerShell on this script's behalf, and a default built from it fails
# during parameter binding, before any output.
if ([string]::IsNullOrEmpty($Root)) {
  $Root = if ([string]::IsNullOrEmpty($PSScriptRoot)) { (Get-Location).Path } else { Split-Path -Parent $PSScriptRoot }
}
$Root = (Resolve-Path $Root).Path

$node = Join-Path $Root "tools\node\node.exe"
$preload = Join-Path $Root "tools\resolve-public.mjs"
$stateDir = Join-Path $Root ".state"
$tokenFile = Join-Path $stateDir "relay-token"
$bridge = Join-Path $Root "packages\dsh-bridge\src\main.mjs"
$logDir = Join-Path $stateDir "logs"

foreach ($required in @($node, $bridge, $tokenFile)) {
  if (-not (Test-Path $required)) {
    throw "missing $required"
  }
}
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

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

# --- the Harness has to be running, because the bridge is its client ------------
# Without it the bridge exits immediately, and the watch then reports a connection
# it cannot use - a failure that looks like a relay problem and is not one.
if ([string]::IsNullOrEmpty($DshUrl)) {
  $DshUrl = if ([string]::IsNullOrEmpty($env:DSH_WEB_URL)) { "http://127.0.0.1:3080" } else { $env:DSH_WEB_URL }
}
$dshPort = ([Uri]$DshUrl).Port
if ($dshPort -le 0) { $dshPort = 3080 }

if (-not (Test-Port $dshPort)) {
  Write-Host "The Harness is not serving on port $dshPort." -ForegroundColor Red
  Write-Host "Start it first, in another window:" -ForegroundColor Yellow
  Write-Host "  dsh web --port $dshPort --no-open" -ForegroundColor Yellow
  exit 1
}
Write-Host "harness : $DshUrl" -ForegroundColor DarkGray

# --- stop any bridge already running, so this one owns the pc id ----------------
# A relay keeps one bridge per pc id, so a second one silently replaces the first:
# the displaced process stays alive, keeps its own view of which watches exist, and
# goes on answering with stale state. Two of them is worse than none.
$existing = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*dsh-bridge*main.mjs*" }
foreach ($process in $existing) {
  Write-Host "stopping an existing bridge (pid $($process.ProcessId))" -ForegroundColor DarkGray
  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}
if ($existing) { Start-Sleep -Seconds 2 }

# --- dial the public relay -----------------------------------------------------
# resolve-public.mjs is preloaded because this network's resolver answers the
# Cloudflare API and workers.dev names with addresses that are not Cloudflare's.
# Without it the connection times out in a way that looks like the relay is down.
$preloadUrl = "file:///" + ($preload -replace '\\', '/')
Write-Host "relay   : $Relay" -ForegroundColor Green
Write-Host ""
Write-Host "The watch must be configured with this same relay address." -ForegroundColor Cyan
Write-Host "Keep this window open; the watch cannot reach this PC without it." -ForegroundColor Cyan
Write-Host ""

$arguments = @(
  "--import", $preloadUrl, $bridge,
  "--relay", $Relay,
  "--token-file", $tokenFile,
  "--state", $stateDir
)

# Run in this window rather than detached: the bridge's output is the only way to
# see whether a watch actually attached, which is the first thing to check when the
# watch says it cannot connect.
$exitCode = 0
try {
  & $node @arguments
  $exitCode = $LASTEXITCODE
} catch {
  $exitCode = 1
  Write-Host ""
  Write-Host "The bridge stopped: $($_.Exception.Message)" -ForegroundColor Red
} finally {
  Write-Host ""
  Write-Host "The bridge has stopped. The watch can no longer reach this PC." -ForegroundColor Yellow
}
exit $exitCode
