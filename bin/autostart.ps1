# Mission Control autostart / watchdog (run by the "Mission Control" scheduled task
# at logon and every 10 minutes). Starts node server.js if nothing is listening on
# the port; otherwise exits quietly. Node is started detached with its output going
# to server.log / server.err, exactly like the `dash` profile function.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File bin\autostart.ps1
#
# PowerShell 5.1 compatible. Loopback-only on purpose: the phone reaches the
# dashboard through `tailscale serve`, which proxies from 127.0.0.1.
param([int]$Port = 7373)

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$log  = Join-Path $root 'server.log'
$err  = Join-Path $root 'server.err'
$marker = Join-Path $root 'data\autostart.log'

function Note([string]$msg) {
    try {
        $dir = Split-Path -Parent $marker
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
        $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        Add-Content -Path $marker -Value "[$stamp] $msg" -Encoding ascii
        # keep the marker small
        $lines = Get-Content $marker -ErrorAction SilentlyContinue
        if ($lines -and $lines.Count -gt 300) { $lines | Select-Object -Last 200 | Set-Content $marker -Encoding ascii }
    } catch { }
}

$listening = $null
try {
    $listening = Get-NetTCPConnection -LocalPort $Port -LocalAddress 127.0.0.1 -State Listen -ErrorAction Stop | Select-Object -First 1
} catch { $listening = $null }

if ($listening) { exit 0 }   # already running: nothing to do, nothing to log

$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) { Note "node not on PATH; cannot start"; exit 1 }

try {
    Start-Process -FilePath $node.Source -ArgumentList 'server.js' -WorkingDirectory $root `
        -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError $err | Out-Null
    Start-Sleep -Seconds 3
    $ok = $null
    try { $ok = Get-NetTCPConnection -LocalPort $Port -LocalAddress 127.0.0.1 -State Listen -ErrorAction Stop | Select-Object -First 1 } catch { $ok = $null }
    if ($ok) { Note "started mission-control (pid $($ok.OwningProcess))" } else { Note "start attempted but port $Port is not listening yet" }
} catch {
    Note ("failed to start: " + $_.Exception.Message)
    exit 1
}
