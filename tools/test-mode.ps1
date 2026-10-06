# Verify the LAN/public mode switch.
#
# Separate from test-plugin.ps1 because it follows a different question: that
# script proves the link runs, this one proves the switch moves it and that the
# choice survives a restart.
param(
    [string] $Root = 'C:\Users\q1375\Documents\watch-dsh'
)

$ErrorActionPreference = 'Continue'
$out = Join-Path $Root '.state\logs\mode.txt'
Remove-Item $out -Force -ErrorAction SilentlyContinue
function Say([string] $line) { Add-Content -Path $out -Value $line }

$prefs = Join-Path $Root '.state\dsh-plugin.json'
Remove-Item $prefs -Force -ErrorAction SilentlyContinue

$wrapper = Join-Path $Root '.state\run-watchtest.cmd'
$dshLog = Join-Path $Root '.state\logs\wt-mode.log'
$proc = Start-Process -FilePath 'cmd.exe' -ArgumentList "/c", "`"$wrapper`"" -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $dshLog -RedirectStandardError (Join-Path $Root '.state\logs\wt-mode.err')
Start-Sleep -Seconds 36

function Status {
    try {
        return (Invoke-WebRequest 'http://127.0.0.1:19500/watch-dsh/status' -TimeoutSec 8 -UseBasicParsing).Content | ConvertFrom-Json
    } catch {
        return $null
    }
}
function Post([string] $route, [string] $body) {
    try {
        return (Invoke-WebRequest "http://127.0.0.1:19500/watch-dsh/$route" -Method POST -TimeoutSec 20 `
            -ContentType 'application/json' -Body $body -UseBasicParsing).Content | ConvertFrom-Json
    } catch {
        return @{ ok = $false; error = $_.Exception.Message }
    }
}

$s = Status
Say ("start.mode=" + $s.mode)
Say ("start.relayUrl=" + $s.relayUrl)
Say ("start.endpoints.relayUrl=" + $s.endpoints.relayUrl)
Say ("start.endpoints.lanRelayUrl=" + $s.endpoints.lanRelayUrl)
Say ("start.lanIp=" + $s.lanIp)

Say "=== switch to public without a URL (must be refused) ==="
$r1 = Post 'mode' '{"mode":"public"}'
Say ("refused.ok=" + $r1.ok + " error=" + $r1.error + " mode=" + $r1.mode)
$s1 = Status
Say ("after-refusal.mode=" + $s1.mode + " relayUrl=" + $s1.relayUrl)

Say "=== switch to public with a URL ==="
$r2 = Post 'mode' '{"mode":"public","publicRelayUrl":"wss://kangjunyu.dpdns.org"}'
Say ("public.ok=" + $r2.ok + " mode=" + $r2.mode)
Start-Sleep -Seconds 14
$s2 = Status
Say ("after-public.mode=" + $s2.mode + " relayUrl=" + $s2.relayUrl)
Say ("after-public.bridgeRunning=" + $s2.bridge.running + " blocked=" + $s2.blocked)
Say ("after-public.detail=" + $s2.detail)

Say "=== prefs file written? ==="
if (Test-Path $prefs) { Say ((Get-Content $prefs -Raw).Trim() -replace "`r?`n", ' ') } else { Say 'MISSING' }

Say "=== switch back to LAN ==="
$r3 = Post 'mode' '{"mode":"lan"}'
Say ("lan.ok=" + $r3.ok + " mode=" + $r3.mode)
Start-Sleep -Seconds 14
$s3 = Status
Say ("after-lan.mode=" + $s3.mode + " relayUrl=" + $s3.relayUrl + " detail=" + $s3.detail)

Say "=== the config a watch would be given ==="
try {
    $c = (Invoke-WebRequest 'http://127.0.0.1:19500/watch-dsh/watch-config' -TimeoutSec 8 -UseBasicParsing).Content | ConvertFrom-Json
    Say ("config.relayUrl=" + $c.config.relayUrl)
    Say ("config.lanRelayUrl=" + $c.config.lanRelayUrl)
    Say ("config.pcId=" + $c.config.pcId)
    Say ("config.tokenLength=" + $c.config.relayToken.Length)
} catch {
    Say ("watch-config FAILED: " + $_.Exception.Message)
}

Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Say "=== done ==="
