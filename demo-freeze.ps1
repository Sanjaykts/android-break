<#
.SYNOPSIS
    Break Remote -- the demo freeze gate. The last check before the day.

.DESCRIPTION
    Re-runs every automated check, then verifies the things a laptop cannot see
    and people skip: that demo.mp4 exists and is not a placeholder, that the
    relay is live, that the install link resolves, and that the enrollment sheet
    has no unfilled screenshot gaps.

    It FAILS while demo.mp4 is missing. That is the point. The fallback ladder has
    to be complete before you are on stage, and the only reliable time to discover
    it is incomplete is before you are on stage.

.EXAMPLE
    $env:RELAY_URL = "https://android-break-relay.<subdomain>.workers.dev"
    .\demo-freeze.ps1
#>

$ErrorActionPreference = 'Continue'
# These scripts live at the repo root, so $PSScriptRoot IS the repo root.
# Taking its parent silently points one level above the repository, which makes
# every path resolve to somewhere that does not exist.
$RepoRoot = $PSScriptRoot
$ApkUrl = "https://github.com/Sanjaykts/android-break/releases/download/apk-latest/agent.apk"

$script:Failed = 0
function Write-Pass($m) { Write-Host "  PASS  $m" -ForegroundColor Green }
function Write-Fail($m) { Write-Host "  FAIL  $m" -ForegroundColor Red; $script:Failed++ }
function Write-Warn($m) { Write-Host "  WARN  $m" -ForegroundColor Yellow }
function Step($m) { Write-Host ""; Write-Host "-- $m" -ForegroundColor White }

Write-Host "Break Remote -- demo freeze gate" -ForegroundColor White
Write-Host (Get-Date -Format "yyyy-MM-dd HH:mm:ss") -ForegroundColor DarkGray

# ── 1. automated suite ──────────────────────────────────────────────────────
# Prefer the sibling PowerShell checker, and fall back to the shell one so this
# script also works on a macOS/Linux dev box.
$CheckAllPs1 = Join-Path $RepoRoot "check-all.ps1"
$CheckAllSh  = Join-Path $RepoRoot "check-all.sh"

Step "1. Automated checks"
if (Test-Path $CheckAllPs1) {
    & $CheckAllPs1 -Quick 2>&1 | Select-Object -Last 14 | ForEach-Object {
        $line = $_.ToString()
        $col = if ($line -match "FAIL") { "Red" } elseif ($line -match "SKIP") { "Yellow" } else { "DarkGray" }
        Write-Host "  $line" -ForegroundColor $col
    }
    $rc = $LASTEXITCODE
} elseif (Test-Path $CheckAllSh) {
    & bash $CheckAllSh --quick 2>&1 | Select-Object -Last 14 | ForEach-Object {
        Write-Host "  $($_.ToString())" -ForegroundColor DarkGray
    }
    $rc = $LASTEXITCODE
} else {
    Write-Fail "neither check-all.ps1 nor check-all.sh found"
    $rc = 1
}
if ($rc -eq 0) { Write-Pass "automated checks" } else { Write-Fail "automated checks (see docs/TROUBLESHOOTING.md)" }

# ── 2. the fallback video ───────────────────────────────────────────────────
Step "2. Prerecorded fallback video"
$DemoMp4 = Join-Path $RepoRoot "demo.mp4"
if (Test-Path $DemoMp4) {
    $size = (Get-Item $DemoMp4).Length
    if ($size -gt 200000) {
        Write-Pass "demo.mp4 exists ($size bytes)"
    } else {
        Write-Fail "demo.mp4 is only $size bytes -- that is a placeholder, not a video"
    }
    # A rehearsal capture with a mock phone is worse than nothing: the audience
    # will notice, and the presenter will not, because it looks like a real run.
    $head = [System.IO.File]::ReadAllBytes($DemoMp4)[0..([Math]::Min(200000, $size) - 1)]
    $text = -join ($head | ForEach-Object { [char]$_ })
    if ($text -match '(?i)rehearsal|mock phone|placeholder') {
        Write-Fail "demo.mp4 is marked as a rehearsal or placeholder capture"
    } else {
        Write-Pass "demo.mp4 is not marked as a placeholder"
    }
} else {
    Write-Fail "demo.mp4 is MISSING -- the fallback ladder has no first rung"
    Write-Host "        record it once the phone is enrolled:" -ForegroundColor DarkGray
    Write-Host "          cd relay; node tools/record-demo.mjs --url %RELAY_URL% --device <id>" -ForegroundColor DarkGray
}
if (Test-Path (Join-Path $RepoRoot "console-rehearsal.webm")) {
    Write-Warn "console-rehearsal.webm exists -- do NOT use it as the fallback"
}

# ── 3. deployment ───────────────────────────────────────────────────────────
Step "3. Deployment"
if (-not [string]::IsNullOrWhiteSpace($env:RELAY_URL)) {
    $scheme = if ($env:RELAY_URL -match '^wss://') { 'https' } elseif ($env:RELAY_URL -match '^http://') { 'http' } else { 'https' }
    $base = ($env:RELAY_URL -replace '^\w+://', '') -replace '/ws/(agent|console)$', ''
    try {
        $h = Invoke-RestMethod -Uri "${scheme}://$base/health" -TimeoutSec 12
        if ($h.ok) { Write-Pass "relay is live at $($env:RELAY_URL)" }
        else { Write-Fail "relay health check returned unexpected body" }
    } catch {
        Write-Fail "relay is not responding at $($env:RELAY_URL)"
    }
} else {
    Write-Warn "RELAY_URL not set -- cannot check the relay. set it before the demo."
}

# ── 4. published APK ────────────────────────────────────────────────────────
Step "4. Published APK"
try {
    $r = Invoke-WebRequest -Uri $ApkUrl -Method Head -TimeoutSec 25 -UseBasicParsing
    Write-Pass "the install link resolves (HTTP $($r.StatusCode))"
} catch {
    Write-Fail "the install link does not resolve -- re-run the build workflow"
}

# ── 5. enrollment material ──────────────────────────────────────────────────
Step "5. Enrollment material"
$Enroll = Join-Path $RepoRoot "tools\out\enroll.html"
if (Test-Path $Enroll) {
    $body = Get-Content $Enroll -Raw
    if ($body -match "SHOT_") {
        Write-Fail "enroll.html still has unfilled screenshot placeholders"
        Write-Host "        add accessibility.png, capture.png and notifications.png" -ForegroundColor DarkGray
        Write-Host "        to tools\out\shots\ and re-run tools\make-enroll-pdf.sh" -ForegroundColor DarkGray
    } else {
        Write-Pass "enroll.html is complete"
    }
} else {
    Write-Fail "tools\out\enroll.html missing -- run tools\make-enroll-pdf.sh"
}
if (Test-Path (Join-Path $RepoRoot "tools\out\apk-download.png")) {
    Write-Pass "QR code present"
} else {
    Write-Fail "QR code missing -- run tools\make-qr.sh"
}

# ── 6. manual confirmations ─────────────────────────────────────────────────
Step "6. Manual confirmations (cannot be checked from here)"
Write-Host @"
  [ ] The phone owner installed the APK themselves, from the browser link
  [ ] Accessibility ON, and the "Gestures work" badge is GREEN
  [ ] Screen timeout set to 30 minutes
  [ ] Battery use set to Unrestricted
  [ ] Screen sharing allowed, live view flowing
  [ ] Phone on 4G, laptop on a different network
  [ ] Phone unlocked, awake, nothing sensitive on screen
  [ ] Rehearsal completed in under 4 minutes -- twice, on consecutive days
  [ ] A 30-minute device soak passed:  node tools/soak-device.mjs --device <id>
  [ ] Model and Android version recorded in docs/COMPATIBILITY.md
  [ ] The three enrollment screenshots captured from THIS phone
  [ ] demo.mp4 played once, end to end, on the demo laptop
"@ -ForegroundColor DarkGray

Write-Host ""
Write-Host ("  " + ("-" * 54)) -ForegroundColor DarkGray
if ($script:Failed -gt 0) {
    Write-Host "  $script:Failed gate(s) failed. Do not freeze, and definitely do not go on stage." -ForegroundColor Red
    exit 1
}
Write-Host "  All automated gates pass." -ForegroundColor Green
Write-Host "  Work through section 6, then freeze. No code changes after this point." -ForegroundColor White
exit 0
