# End-to-end check of the watch-dsh plugin.
#
# One process, writing results to a file: capturing a child's output through the
# harness has been unreliable, and a file survives however the caller is torn
# down. Results go to a log rather than stdout so that nothing here depends on
# stdio plumbing.
param(
    [string] $Root = 'C:\Users\q1375\Documents\watch-dsh'
)

$ErrorActionPreference = 'Continue'
$out = Join-Path $Root '.state\logs\e2e.txt'
Remove-Item $out -Force -ErrorAction SilentlyContinue

function Say([string] $line) {
    Add-Content -Path $out -Value $line
}

$node = Join-Path $Root 'tools\node\node.exe'
$wrapper = Join-Path $Root '.state\run-watchtest.cmd'
$dshLog = Join-Path $Root '.state\logs\wt-e2e.log'

Say "=== starting the test instance ==="
$proc = Start-Process -FilePath 'cmd.exe' -ArgumentList "/c", "`"$wrapper`"" -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $dshLog -RedirectStandardError (Join-Path $Root '.state\logs\wt-e2e.err')
Start-Sleep -Seconds 38

Say ("dsh_listening=" + [bool](netstat -ano | Select-String ':19500.*LISTENING'))
Say ("relay_listening=" + [bool](netstat -ano | Select-String ':8787.*LISTENING'))

Say "=== status before a watch ==="
try {
    $j = (Invoke-WebRequest 'http://127.0.0.1:19500/watch-dsh/status' -TimeoutSec 8 -UseBasicParsing).Content | ConvertFrom-Json
    Say ("detail=" + $j.detail)
    Say ("relay.pid=" + $j.relay.pid + " bridge.pid=" + $j.bridge.pid)
    Say ("pcId=" + $j.bridge.pcId + " watchId=" + $j.bridge.watchId)
} catch {
    Say ("status FAILED: " + $_.Exception.Message)
}

Say "=== attaching a simulated watch ==="
$token = (Get-Content (Join-Path $Root '.state\relay-token') -Raw).Trim()
$script = @'
const ws = new WebSocket('ws://127.0.0.1:8787/watch?token=' + encodeURIComponent(process.argv[1]) + '&pc=mcphonk');
ws.addEventListener('open', () => console.log('OPEN'));
ws.addEventListener('message', (e) => console.log('MSG ' + String(e.data).slice(0, 60)));
ws.addEventListener('error', () => console.log('ERR'));
setTimeout(() => { try { ws.close(); } catch {} process.exit(0); }, 9000);
'@
$watchOut = & $node -e $script $token 2>&1
Say ("watch output: " + (($watchOut | Select-Object -First 4) -join ' ;; '))

Start-Sleep -Seconds 2
Say "=== status after the watch ==="
try {
    $j2 = (Invoke-WebRequest 'http://127.0.0.1:19500/watch-dsh/status' -TimeoutSec 8 -UseBasicParsing).Content | ConvertFrom-Json
    Say ("detail=" + $j2.detail)
    Say ("watchId=" + $j2.bridge.watchId + " heartbeat=" + $j2.bridge.heartbeat)
    Say ("bridge log tail: " + (($j2.log.bridge | Select-Object -Last 3) -join ' ;; '))
} catch {
    Say ("status FAILED: " + $_.Exception.Message)
}

Say "=== stopping ==="
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Say ("dsh_listening_after=" + [bool](netstat -ano | Select-String ':19500.*LISTENING'))
Say ("relay_listening_after=" + [bool](netstat -ano | Select-String ':8787.*LISTENING'))
Say "=== done ==="
