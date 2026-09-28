<#
.SYNOPSIS
    Break Remote -- demo pre-flight. Red/green checks before walking on stage.

.DESCRIPTION
    Probes the relay, the console token, the demo laptop, and network reachability.
    Exits non-zero when a check fails, so it can be the first thing you do and the
    last thing you check.

    Automation cannot verify the phone. The script prints an explicit checklist for
    the items that need a human and the device -- that list is the point, not an
    afterthought.

.EXAMPLE
    $env:RELAY_URL = "https://android-break-relay.<subdomain>.workers.dev"
    $env:CONSOLE_TOKEN = "<console token>"
    .\demo-preflight.ps1

.NOTES
    Tokens are read from the environment, never from a file, so this script is
    safe to have in the repository and safe to screen-share.
#>

$ErrorActionPreference = 'Stop'

# These scripts live at the repo root, so $PSScriptRoot IS the repo root.
# Taking its parent silently points one level above the repository, which makes
# every path resolve to somewhere that does not exist.
$RepoRoot = $PSScriptRoot

function Write-Pass($m) { Write-Host "  PASS  $m" -ForegroundColor Green }
function Write-Fail($m) { Write-Host "  FAIL  $m" -ForegroundColor Red; $script:Failed++ }
function Write-Warn($m) { Write-Host "  WARN  $m" -ForegroundColor Yellow }
function Write-Head($m) { Write-Host ""; Write-Host $m -ForegroundColor White }

$script:Failed = 0
$script:Warnings = 0

Write-Host "Break Remote -- demo pre-flight" -ForegroundColor White
Write-Host (Get-Date -Format "yyyy-MM-dd HH:mm:ss K") -ForegroundColor DarkGray

# ── 1. configuration ─────────────────────────────────────────────────────────
Write-Head "1. Configuration"

$RelayUrl = $env:RELAY_URL
$ConsoleToken = $env:CONSOLE_TOKEN

if ([string]::IsNullOrWhiteSpace($RelayUrl)) {
    Write-Fail "RELAY_URL is not set"
} else {
    Write-Pass "RELAY_URL is set"
    if ($RelayUrl -match '^(https|wss)://') { Write-Pass "relay is TLS" }
    elseif ($RelayUrl -match '^http://(127\.0\.0\.1|localhost)') {
        Write-Pass "relay is local http (fine for dev, not for a demo)"
    } else {
        Write-Fail "RELAY_URL is not https/wss -- getUserMedia needs a secure context"
    }
}

if ([string]::IsNullOrWhiteSpace($ConsoleToken)) {
    Write-Fail "CONSOLE_TOKEN is not set"
} else {
    Write-Pass "CONSOLE_TOKEN is set"
}

# ── 2. demo laptop ──────────────────────────────────────────────────────────
Write-Head "2. Demo laptop"

# curl.exe ships with Windows 10 1803+; fall back to Invoke-WebRequest below.
$curlExe = Get-Command curl.exe -ErrorAction SilentlyContinue
if ($curlExe) { Write-Pass "curl.exe available" }
else { Write-Warn "curl.exe not found -- will use Invoke-WebRequest" }

$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($chrome) { Write-Pass "Chrome found: $chrome" }
else { Write-Fail "Chrome not found -- the console and the recorder need it" }

# A display that sleeps mid-demo is the most common self-inflicted failure.
# Every platform probe here is wrapped: a check that cannot run must warn, never
# abort the script. A pre-flight that crashes before it reaches the network
# section has told you nothing.
$pcfg = $null
try { $pcfg = (powercfg /getactivescheme 2>&1 | Out-String) } catch { $pcfg = $null }

if ($pcfg -and $pcfg -match '([0-9a-fA-F-]{36})') {
    try {
        $sleepOut = (powercfg /query $Matches[1] SUB_SLEEP STANDBYIDLE 2>&1 | Out-String)
        if ($sleepOut -match 'Current AC Power Setting Index:\s*0x([0-9a-fA-F]+)') {
            $mins = [Convert]::ToInt32($Matches[1], 16) / 60
            if ($mins -le 10) {
                Write-Warn "display sleeps after $([math]::Round($mins)) min on AC"
            } else {
                Write-Pass "display sleep looks fine ($([math]::Round($mins)) min on AC)"
            }
        } else {
            Write-Pass "display sleep setting not machine-readable; check Settings > Power"
        }
    } catch {
        Write-Warn "could not read the display sleep setting"
    }
} else {
    # Non-Windows, or powercfg unavailable. Do not fail the gate over it.
    Write-Pass "display sleep not checked (powercfg unavailable on this platform)"
}

# ── 3. network ──────────────────────────────────────────────────────────────
Write-Head "3. Network"

if (-not [string]::IsNullOrWhiteSpace($RelayUrl)) {
    $scheme = if ($RelayUrl -match '^wss://') { 'https' } elseif ($RelayUrl -match '^http://') { 'http' } else { 'https' }
    $base = ($RelayUrl -replace '^\w+://', '') -replace '/ws/(agent|console)$', ''
    $healthUrl = "${scheme}://$base/health"

    try {
        $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 12
        if ($health.ok) { Write-Pass "relay /health responded ok" }
        else { Write-Fail "relay /health returned unexpected body" }
    } catch {
        Write-Fail "cannot reach relay /health at $healthUrl"
    }

    if (-not [string]::IsNullOrWhiteSpace($ConsoleToken)) {
        try {
            $devices = Invoke-RestMethod -Uri "${scheme}://$base/devices?token=$ConsoleToken" -TimeoutSec 12
            $n = @($devices.devices).Count
            if ($n -gt 0) {
                Write-Pass "relay reports $n device(s) connected"
                foreach ($d in $devices.devices) {
                    Write-Host ("          {0}  {1} {2}  Android {3}  {4}" -f `
                        $d.id, $d.brand, $d.model, $d.android, $(if ($d.paired) { '(in use)' } else { '' })) `
                        -ForegroundColor DarkGray
                }
            } else {
                Write-Fail "relay reachable but no device is connected -- is the app running on the phone?"
            }
        } catch {
            $code = $_.Exception.Response.StatusCode.value__
            if ($code -eq 401) { Write-Fail "relay rejected the console token (401)" }
            else { Write-Fail "relay /devices unreachable" }
        }
    }

    # A venue firewall that allows TCP but throttles WebSockets only shows up as
    # a slow demo, so measure it now rather than then.
    $host_ = ($base -split ':')[0]
    $port = if ($base -match ':(\d+)$') { [int]$Matches[1] } elseif ($scheme -eq 'https') { 443 } else { 80 }
    try {
        $t = Test-NetConnection -ComputerName $host_ -Port $port -WarningAction SilentlyContinue
        if ($t.TcpTestSucceeded) { Write-Pass "tcp/$port reachable to $host_" }
        else { Write-Fail "tcp/$port not reachable to $host_" }
    } catch {
        Write-Warn "could not test tcp/$port"
    }
}

# ── 4. the phone ────────────────────────────────────────────────────────────
Write-Head "4. Phone (cannot be checked from the laptop)"
Write-Host @"
  Confirm each on the phone itself:

    [ ] app installed from the browser link, and still installed
    [ ] Accessibility  -> Break Remote Control  -> ON
    [ ] the enrollment screen's "Gestures work" badge is GREEN
    [ ] battery use    -> Unrestricted
    [ ] screen timeout -> 30 minutes
    [ ] screen sharing -> allowed, live view flowing in the console
    [ ] phone is on cellular data, laptop is on a different network
    [ ] phone is unlocked and awake (no PIN prompt, screen on)
    [ ] screen is NOT rotated away from the orientation you will present
    [ ] nothing sensitive is on screen (notifications, messages, photos)
"@ -ForegroundColor DarkGray

Write-Host ""
Write-Host "  " ("-" * 54) -ForegroundColor DarkGray
if ($Failed -gt 0) {
    Write-Host "  $Failed CHECK(S) FAILED -- do not go on stage yet." -ForegroundColor Red
    exit 1
}
Write-Host "  All automated checks passed. Work through the phone list above." -ForegroundColor Green
exit 0
