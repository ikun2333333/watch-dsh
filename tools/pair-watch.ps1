# Pair the watch from the PC, in one command.
#
# Two ways the watch learns how to reach this PC, both easier to get right from
# here than by hand:
#
#   config     the PC writes a config file and pushes it to the watch (default)
#   discovery  the watch scans the LAN itself; nothing is pushed
#
# The config route is the reliable one for a first pairing, because it does not
# depend on the watch's Wi-Fi picking up a broadcast.
#
# Usage:
#   .\tools\pair-watch.ps1                     # push a config and restart the app
#   .\tools\pair-watch.ps1 -Method discovery   # leave the watch to scan
#   .\tools\pair-watch.ps1 -Serial <serial>    # pick a device explicitly
#
# Every failure is reported and the window is held open, so running this by
# double-clicking shows the reason instead of vanishing.

[CmdletBinding()]
param(
  [string] $Root = "",
  [ValidateSet("config", "discovery")] [string] $Method = "config",
  [string] $Serial = "",
  [string] $Package = "dev.watchdsh",
  # Hold the window open when finished. Pair-Watch.cmd sets this, because a window
  # opened by double-clicking closes the moment the script ends.
  [switch] $Pause
)

$ErrorActionPreference = "Stop"

# $Root is resolved here rather than as a param default. `$PSScriptRoot` is empty
# when cmd launches PowerShell on this script's behalf, which is exactly how
# Pair-Watch.cmd runs it, and a default built from it fails during parameter
# binding — before any output, so the window just disappears.
if ([string]::IsNullOrEmpty($Root)) {
  $Root = if ([string]::IsNullOrEmpty($PSScriptRoot)) { (Get-Location).Path } else { Split-Path -Parent $PSScriptRoot }
}
if (-not (Test-Path $Root)) { throw "the repository root '$Root' does not exist; pass -Root explicitly" }
$Root = (Resolve-Path $Root).Path

$script:Root = $Root
$script:Node = Join-Path $Root "tools\node\node.exe"
$script:Adb = Join-Path $Root "tools\android\sdk\platform-tools\adb.exe"
$script:StateDir = Join-Path $Root ".state"
$script:LogDir = Join-Path $script:StateDir "logs"
$script:StepCount = 0

function Wait-ForExit {
  param([int] $Code)
  if ($Pause) {
    Write-Host ""
    Read-Host "Press Enter to close" | Out-Null
  }
  exit $Code
}

# adb and node write ordinary progress to stderr, which PowerShell treats as an
# error under the strict preference above. The exit code decides success, so the
# preference is relaxed for the duration of each native call.
function Invoke-Native {
  param([string] $Command, [string[]] $Arguments, [switch] $AllowFailure)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & $Command @Arguments 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  if (-not $AllowFailure -and $code -ne 0) {
    $text = ($output | Out-String).Trim()
    throw "$([System.IO.Path]::GetFileName($Command)) exited with code $code`n$text"
  }
  return $output
}

function Write-Step([string] $Message) {
  $script:StepCount += 1
  Write-Host "[$($script:StepCount)] $Message" -ForegroundColor Green
}

function Write-Note([string] $Message) {
  Write-Host "    $Message" -ForegroundColor DarkGray
}

# --- one TCP probe, used to decide whether a bridge is already running ---------
function Test-Port([int] $Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $client.Connect("127.0.0.1", $Port)
    return $true
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

# --- find the watch ------------------------------------------------------------
function Resolve-Device {
  if ($Serial -ne "") { return $Serial }

  # `adb devices` prints a header, blank lines, then "<serial>\t<state>". A
  # wireless-debugging serial looks like
  # adb-XXXXXXXXXXXX-XXXXXX._adb-tls-connect._tcp, so the serial is everything
  # before the trailing state field, not the first whitespace-separated token.
  $serials = @()
  foreach ($line in (Invoke-Native $script:Adb @("devices") -AllowFailure)) {
    $trimmed = "$line".Trim()
    if ($trimmed -eq "" -or $trimmed -like "List of devices*") { continue }
    if ($trimmed -match '^(\S+)\s+device$') { $serials += $Matches[1] }
  }
  if ($serials.Count -eq 0) {
    throw @"
No watch is connected over adb.

On the watch: Settings > About watch > Software > tap "Software version" 5 times,
then Developer options > Wireless debugging > on. Note the IP and port it shows,
then run:

  $($script:Adb) connect <ip>:<port>
"@
  }
  if ($serials.Count -gt 1) {
    Write-Note "several devices found; using $($serials[0]) (pass -Serial to choose another)"
  }
  return $serials[0]
}

# --- the work ------------------------------------------------------------------
function Invoke-Pairing {
  foreach ($tool in @($script:Node, $script:Adb)) {
    if (-not (Test-Path $tool)) {
      throw "missing $tool - run tools\bootstrap-android.ps1 first"
    }
  }
  New-Item -ItemType Directory -Force -Path $script:LogDir | Out-Null

  # 1. A bridge has to be running. A stale relay is worse than none, because the
  #    watch would be told to pair against an address nothing is listening on.
  #    Whether this run started it is reported, so a later problem is not confused
  #    with an older process that happens to still be up.
  if (Test-Port 8787) {
    Write-Step "a relay is already listening on 8787 (started by an earlier run)"
  } else {
    Write-Step "starting the relay and the bridge"
    $tokenFile = Join-Path $script:StateDir "relay-token"
    if (-not (Test-Path $tokenFile)) {
      $token = Invoke-Native $script:Node @((Join-Path $script:Root "tools\gen-secret.mjs"), "token")
      Set-Content -Path $tokenFile -Value $token -NoNewline
      Write-Note "generated a relay token"
    }
    Start-Process -FilePath $script:Node -WindowStyle Hidden `
      -ArgumentList @((Join-Path $script:Root "packages\dsh-bridge\src\relay.mjs"), "--port", "8787",
        "--host", "0.0.0.0", "--token-file", $tokenFile) `
      -RedirectStandardOutput (Join-Path $script:LogDir "relay.log") `
      -RedirectStandardError (Join-Path $script:LogDir "relay.err")
    Start-Sleep -Seconds 3
    Start-Process -FilePath $script:Node -WindowStyle Hidden `
      -ArgumentList @((Join-Path $script:Root "packages\dsh-bridge\src\main.mjs"), "--relay", "ws://127.0.0.1:8787",
        "--token-file", $tokenFile, "--state", $script:StateDir) `
      -RedirectStandardOutput (Join-Path $script:LogDir "bridge.log") `
      -RedirectStandardError (Join-Path $script:LogDir "bridge.err")
    Start-Sleep -Seconds 6

    if (-not (Test-Port 8787)) {
      throw "the relay did not start; see $(Join-Path $script:LogDir 'relay.err')"
    }
  }

  # 2. Write the config the watch will import.
  Write-Step "writing the watch config"
  Invoke-Native $script:Node @(
    (Join-Path $script:Root "packages\dsh-bridge\src\main.mjs"),
    "--relay", "ws://127.0.0.1:8787",
    "--token-file", (Join-Path $script:StateDir "relay-token"),
    "--state", $script:StateDir,
    "--write-config"
  ) | Where-Object { "$_" -match "wrote a watch config" } | ForEach-Object { Write-Note "$_" }
  $configPath = Join-Path $script:StateDir "watch-config.json"
  if (-not (Test-Path $configPath)) { throw "the bridge did not write $configPath" }

  # 3. Find the watch.
  $device = Resolve-Device
  Write-Step "using device $device"
  $deviceArgs = @("-s", $device)

  if ($Method -eq "discovery") {
    Write-Host ""
    Write-Host "Open the watch app and tap 'Find my PC'." -ForegroundColor Cyan
    Write-Host "Discovery answers on udp 8788; nothing needs to be typed."
    return
  }

  # 4. Push the config where the app reads it.
  $remoteDir = "/sdcard/Android/data/$Package/files"
  Write-Step "pushing the config to $remoteDir"
  Invoke-Native $script:Adb ($deviceArgs + @("shell", "mkdir", "-p", $remoteDir)) | Out-Null
  Invoke-Native $script:Adb ($deviceArgs + @("push", $configPath, "$remoteDir/watch-config.json")) |
    Where-Object { "$_" -match "pushed" } | ForEach-Object { Write-Note "$_" }

  # 5. Restart the app so it imports on launch.
  Write-Step "restarting the watch app"
  Invoke-Native $script:Adb ($deviceArgs + @("shell", "am", "force-stop", $Package)) -AllowFailure | Out-Null
  Start-Sleep -Seconds 2
  Invoke-Native $script:Adb ($deviceArgs + @("shell", "input", "keyevent", "KEYCODE_WAKEUP")) -AllowFailure | Out-Null
  Invoke-Native $script:Adb ($deviceArgs + @("shell", "am", "start", "-n", "$Package/dev.watchdsh.MainActivity")) -AllowFailure | Out-Null

  Start-Sleep -Seconds 12

  Write-Host ""
  Write-Host "--- what the watch recorded ---" -ForegroundColor Cyan
  $diagLines = Invoke-Native $script:Adb ($deviceArgs + @("shell", "cat", "$remoteDir/diagnostics.log")) -AllowFailure
  # Joined into one string for matching: `-match` on a string array returns the
  # matching elements rather than setting $Matches, so the count would be lost.
  $diagText = ($diagLines | Out-String)
  foreach ($line in $diagLines) { Write-Host "    $line" }

  Write-Host ""
  if ($diagText -match "handshake: sessions=(\d+)") {
    Write-Host "Paired: the watch reached the harness and read $($Matches[1]) sessions." -ForegroundColor Green
  } elseif ($diagText -match "link=Connected") {
    Write-Host "Connected, but the handshake did not finish. See the log above." -ForegroundColor Yellow
  } else {
    Write-Host "The watch did not connect. The log above says why." -ForegroundColor Yellow
  }
  Write-Host "The config file is deleted by the app once imported, so the credential" -ForegroundColor DarkGray
  Write-Host "does not stay on external storage." -ForegroundColor DarkGray
}

# --- entry point ---------------------------------------------------------------
$exitCode = 0
try {
  Invoke-Pairing
} catch {
  $exitCode = 1
  Write-Host ""
  Write-Host "PAIRING FAILED" -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  # A positional-parameter failure and a genuine fault look the same here, so the
  # raw error is printed rather than swallowed.
  if ($_.InvocationInfo -and $_.InvocationInfo.PositionMessage) {
    Write-Host ""
    Write-Host $_.InvocationInfo.PositionMessage -ForegroundColor DarkGray
  }
}

Wait-ForExit $exitCode
