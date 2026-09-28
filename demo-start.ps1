<#
.SYNOPSIS
    Break Remote -- one action before walking on stage.

.DESCRIPTION
    Health-checks the relay, then opens the console fullscreen with the device
    already paired. If no device is connected it says so instead of showing an
    empty list.

.EXAMPLE
    $env:RELAY_URL = "https://android-break-relay.<subdomain>.workers.dev"
    $env:CONSOLE_TOKEN = "<console token>"
    .\demo-start.ps1
#>

$ErrorActionPreference = 'Stop'

function Die($m) { Write-Host $m -ForegroundColor Red; exit 1 }

if ([string]::IsNullOrWhiteSpace($env:RELAY_URL))     { Die "RELAY_URL is not set" }
if ([string]::IsNullOrWhiteSpace($env:CONSOLE_TOKEN)) { Die "CONSOLE_TOKEN is not set" }

$scheme = if ($env:RELAY_URL -match '^wss://') { 'https' } elseif ($env:RELAY_URL -match '^http://') { 'http' } else { 'https' }
$base = ($env:RELAY_URL -replace '^\w+://', '') -replace '/ws/(agent|console)$', ''

Write-Host "Break Remote" -ForegroundColor White

try {
    $health = Invoke-RestMethod -Uri "${scheme}://$base/health" -TimeoutSec 10
    if (-not $health.ok) { Die "relay /health returned unexpected body" }
    Write-Host "  ok    relay healthy" -ForegroundColor Green
} catch {
    Die "relay is not responding at ${scheme}://$base/health"
}

try {
    $devices = Invoke-RestMethod -Uri "${scheme}://$base/devices?token=$($env:CONSOLE_TOKEN)" -TimeoutSec 10
    $n = @($devices.devices).Count
    if ($n -eq 0) {
        Write-Host "  warn  no device connected -- is the app running on the phone?" -ForegroundColor Yellow
    } else {
        Write-Host "  ok    $n device(s) connected" -ForegroundColor Green
        foreach ($d in $devices.devices) {
            Write-Host ("        {0}  {1} {2}  Android {3}" -f $d.id, $d.brand, $d.model, $d.android) -ForegroundColor DarkGray
        }
    }
} catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -eq 401) { Die "relay rejected the console token (401)" }
    Die "relay /devices unreachable"
}

$url = "${scheme}://$base/?token=$($env:CONSOLE_TOKEN)"
Write-Host ""
Write-Host "  opening $url" -ForegroundColor White
Write-Host "  fullscreen is automatic; press F to toggle" -ForegroundColor DarkGray

$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($chrome) {
    # --start-fullscreen so the projector shows the console, not browser chrome.
    Start-Process $chrome -ArgumentList @('--start-fullscreen', $url)
} else {
    Start-Process $url
    Write-Host "  (Chrome not found at a standard path; opened the default browser)" -ForegroundColor Yellow
}
