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
#
# The port is discovered rather than assumed, because the obvious sources are both
# wrong in the case that matters. `DSH_WEB_URL` exists only in the shell that
# launched the Harness - not in the fresh environment a double-click creates - and
# the bridge's own default of 3080 is not where a Harness started with `--port`
# listens. Assuming either produced "the Harness is not serving on 3080" while it
# was plainly serving on 19387.
function Find-Harness {
  $candidates = @()
  if (-not [string]::IsNullOrEmpty($DshUrl)) { $candidates += $DshUrl }
  if (-not [string]::IsNullOrEmpty($env:DSH_WEB_URL)) { $candidates += $env:DSH_WEB_URL }
  # 3080 is the bridge's default, so a Harness started without --port lands there.
  # The rest are ports a Harness is commonly given by hand or by the desktop app.
  foreach ($candidatePort in @(3080, 19387, 3000, 8080)) {
    $candidates += "http://127.0.0.1:$candidatePort"
  }

  foreach ($candidate in $candidates) {
    $port = ([Uri]$candidate).Port
    if ($port -gt 0 -and (Test-Port $port)) { return $candidate }
  }
  return $null
}

$found = Find-Harness
if ($found -eq $null) {
  Write-Host "No Harness is serving on any port this script knows about." -ForegroundColor Red
  Write-Host "Checked: 3080 (the bridge default), 19387, 3000, 8080." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Start one, then run this again:" -ForegroundColor Yellow
  Write-Host "  dsh web --port 3080 --no-open" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Or point this script at one that is already running:" -ForegroundColor Yellow
  Write-Host "  .\tools\remote-bridge.ps1 -DshUrl http://127.0.0.1:<port>" -ForegroundColor Yellow
  exit 1
}
$DshUrl = $found
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
  # Passed explicitly rather than left to the environment: the bridge would
  # otherwise fall back to its own default of 3080, which is not where this
  # Harness is, so discovering the port here would fix nothing.
  "--dsh", $DshUrl,
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
