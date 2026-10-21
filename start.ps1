# mission-control launcher
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1 -Port 7500 -NoBrowser
#
# Starts node server.js, waits for it to answer, opens the browser, and stays
# attached so Ctrl+C stops the server. Windows PowerShell 5.1 compatible:
# no '&&', no ternary, no null-coalescing.

[CmdletBinding()]
param(
    [int]$Port = 7373,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

# --- locate the project ----------------------------------------------------
$root = $PSScriptRoot
if ([string]::IsNullOrEmpty($root)) { $root = Split-Path -Parent $MyInvocation.MyCommand.Path }
if ([string]::IsNullOrEmpty($root)) { $root = (Get-Location).Path }

$serverJs = Join-Path $root 'server.js'
if (-not (Test-Path $serverJs)) {
    Write-Host "ERROR: server.js not found at $serverJs" -ForegroundColor Red
    exit 1
}

# --- node present? ---------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) {
    Write-Host "ERROR: 'node' is not on PATH. Install Node 20+ and try again." -ForegroundColor Red
    exit 1
}

# --- port already taken? ---------------------------------------------------
$inUse = $false
$holder = $null
if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    try {
        $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
        if ($null -ne $conn) {
            $inUse = $true
            try { $holder = (Get-Process -Id $conn.OwningProcess -ErrorAction Stop).ProcessName } catch { $holder = "pid $($conn.OwningProcess)" }
        }
    } catch {
        # no listener on that port -> Get-NetTCPConnection throws; that's fine
    }
} else {
    $lines = netstat -ano | Select-String -Pattern ":$Port\s.*LISTENING"
    if ($null -ne $lines) { $inUse = $true }
}

if ($inUse) {
    Write-Host ""
    Write-Host "ERROR: port $Port is already in use" -ForegroundColor Red
    if ($null -ne $holder) { Write-Host "       held by: $holder" -ForegroundColor Red }
    Write-Host "       Stop that process, or run: .\start.ps1 -Port 7500" -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

# --- start the server ------------------------------------------------------
$url = "http://127.0.0.1:$Port/"
Write-Host ""
Write-Host "mission-control" -ForegroundColor Cyan
Write-Host "  $url" -ForegroundColor Cyan
Write-Host "  Ctrl+C to stop"
Write-Host ""

# Exec node directly (no cmd.exe wrapper) so Ctrl+C / Stop-Process reaches it
# instead of orphaning the node child.
$proc = Start-Process -FilePath $node.Source `
                      -ArgumentList @('server.js', '--port', "$Port") `
                      -WorkingDirectory $root `
                      -NoNewWindow -PassThru

if (-not $?) {
    Write-Host "ERROR: failed to start node." -ForegroundColor Red
    exit 1
}

try {
    # --- wait for it to actually listen (max ~15s) -------------------------
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        if ($proc.HasExited) { break }
        try {
            $c = New-Object System.Net.Sockets.TcpClient
            $c.Connect('127.0.0.1', $Port)
            $c.Close()
            $ready = $true
            break
        } catch {
            Start-Sleep -Milliseconds 250
        }
    }

    if ($proc.HasExited) {
        Write-Host "ERROR: node exited immediately (exit code $($proc.ExitCode)). See output above." -ForegroundColor Red
        exit 1
    }
    if (-not $ready) {
        Write-Host "ERROR: server did not start listening on $Port within 15s." -ForegroundColor Red
        try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
        exit 1
    }

    # --- open the browser --------------------------------------------------
    if (-not $NoBrowser) {
        try { Start-Process $url | Out-Null } catch {
            Write-Host "(could not open a browser automatically - open $url yourself)" -ForegroundColor Yellow
        }
    }

    Wait-Process -Id $proc.Id
}
finally {
    if ($null -ne $proc -and -not $proc.HasExited) {
        Write-Host ""
        Write-Host "stopping mission-control (pid $($proc.Id))..."
        try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
    }
}
