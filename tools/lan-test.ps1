# Start the LAN test setup: Harness web server, relay, and bridge.
#
# This is the fastest way to validate the whole chain, because it needs no
# Cloudflare account, no tunnel, and no public address: the watch talks to this
# PC directly over Wi-Fi. It is also the lower-latency path once it works.
#
# The Harness itself is part of the setup and is started here. The bridge is a
# client of the Harness, so without it the bridge exits immediately with
# "connect ECONNREFUSED 127.0.0.1:3080" and the watch has nothing to talk to.
#
# The relay binds every interface so the watch can reach it, while the bridge
# reports this machine's LAN address to paste into the app (0.0.0.0 is not
# dialable).
#
# Usage:  pwsh -File tools\lan-test.ps1
# Stop:   press Ctrl+C in this window (all processes are children of it)

[CmdletBinding()]
param(
  [string] $Root = "",
  [int] $Port = 8787,
  [int] $DshPort = 3080
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

# --- the Harness must be running, because the bridge is its client ------------
#
# A port probe is used rather than starting `dsh web` blindly: a Harness already
# running on this port is usually the one the user is working in, and replacing it
# would disconnect their own session for no reason.
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

$dshEntry = "C:\Users\q1375\AppData\Local\Programs\node-v24.19.0-win-x64\node_modules\@deepseek-ai\dsh\lib\bin.js"
# The Harness runs on the Node it ships against, not whatever `node` happens to be
# on PATH: a shell started before the toolchain was installed can resolve an older
# runtime, which fails in ways that look like a Harness problem.
$dshNode = Join-Path $Root "tools\node\node.exe"
if (-not (Test-Path $dshNode)) { $dshNode = $node }
$dshProcess = $null

# Probe the port the bridge will use, so this script never starts a Harness that
# the bridge then ignores. DSH_WEB_URL is set whenever the Harness was launched
# from another shell; it names a session that is already running, and that session
# is the one worth driving. It therefore takes precedence over -DshPort, because
# it is the variable the bridge itself reads.
$dshUrl = $env:DSH_WEB_URL
if (-not [string]::IsNullOrEmpty($dshUrl)) {
  $configuredPort = ([Uri]$dshUrl).Port
  if ($configuredPort -gt 0 -and $configuredPort -ne $DshPort) {
    Write-Host "using the Harness named by DSH_WEB_URL ($dshUrl) instead of port $DshPort" -ForegroundColor DarkGray
    $DshPort = $configuredPort
  }
}

if (Test-Port $DshPort) {
  Write-Host "the Harness is already serving on $DshPort; the watch will drive that session" -ForegroundColor Green
} elseif (-not (Test-Path $dshEntry)) {
  throw @"
The Harness web server is not running on port $DshPort, and it could not be
started automatically because this file does not exist:

  $dshEntry

Start it yourself, then run this script again:

  dsh web --port $DshPort --no-open
"@
} else {
  Write-Host "starting the Harness web server on $DshPort ..." -ForegroundColor Green
  # -WindowStyle Hidden rather than -NoNewWindow: with its console redirected the
  # Harness exits before it binds, leaving both log files empty, which reads as a
  # mysterious failure. A hidden window gives it a console while staying out of the
  # way. --no-open is used because the bridge authenticates exactly as a browser
  # does, so there is no reason to launch a browser for a server the watch drives.
  $dshProcess = Start-Process -FilePath $dshNode -PassThru -WindowStyle Hidden -ArgumentList @(
    $dshEntry, "web", "--port", "$DshPort", "--no-open"
  ) -RedirectStandardOutput (Join-Path $logs "dsh.log") -RedirectStandardError (Join-Path $logs "dsh.err")

  Start-Sleep -Seconds 12
  if (-not (Test-Port $DshPort)) {
    Write-Host ""
    Write-Host "The Harness did not start on $DshPort." -ForegroundColor Red
    if ($dshProcess -and $dshProcess.HasExited) {
      Write-Host "  it exited immediately with code $($dshProcess.ExitCode)" -ForegroundColor Red
    }
    $dshErr = Get-Content (Join-Path $logs "dsh.err") -ErrorAction SilentlyContinue
    if ($dshErr) {
      Write-Host "  dsh.err:" -ForegroundColor Red
      $dshErr | Select-Object -First 10 | ForEach-Object { Write-Host "    $_" }
    } else {
      Write-Host "  dsh.err is empty; the process produced no output at all" -ForegroundColor Red
    }
    if ($dshProcess -and -not $dshProcess.HasExited) { Stop-Process -Id $dshProcess.Id -Force -ErrorAction SilentlyContinue }
    exit 1
  }
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
if (Test-Port $Port) {
  Write-Host ""
  Write-Host "Something is already listening on port $Port." -ForegroundColor Yellow
  Write-Host "That is usually a relay from an earlier run, and if it is, this PC is"
  Write-Host "already reachable by the watch - nothing needs restarting."
  Write-Host ""
  Write-Host "To start fresh instead, stop it first:"
  Write-Host ""
  Write-Host "  Get-Process node | Where-Object { `$_.Path -like '*watch-dsh*' } | Stop-Process -Force"
  Write-Host ""
  Write-Host "Or run this on another port:  .\tools\lan-test.ps1 -Port $($Port + 3)" -ForegroundColor Cyan
  $running = Get-Content (Join-Path $logs "bridge.log") -ErrorAction SilentlyContinue | Select-Object -Last 12
  if ($running) {
    Write-Host ""
    Write-Host "The running bridge last reported:" -ForegroundColor Cyan
    $running | Write-Host
  }
  # The exit code is what tells the wrapper whether anything was actually running,
  # so it does not announce that processes stopped when none were ever started.
  exit 2
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
  # Only processes this script started are waited on. A Harness that was already
  # serving is deliberately left alone, because it may be the one the user is
  # working in.
  $ids = @($relay.Id, $bridge.Id, $dshProcess.Id) | Where-Object { $_ }
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
  foreach ($process in @($relay, $bridge, $dshProcess)) {
    if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  }
  Write-Host "stopped."
}
exit $exitCode
