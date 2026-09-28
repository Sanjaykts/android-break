<#
.SYNOPSIS
    Break Remote -- run every automated check.

.DESCRIPTION
    Android build + lint + unit tests, then four relay suites against a real local
    Worker (wrangler dev). Hibernation, tag routing and byte preservation only
    exist in the real runtime, so the suites deliberately do not use a mock.

.PARAMETER Quick
    Skip the 30-second frame-relay load test.

.EXAMPLE
    .\check-all.ps1
    .\check-all.ps1 -Quick
#>

param([switch]$Quick)

$ErrorActionPreference = 'Continue'
# These scripts live at the repo root, so $PSScriptRoot IS the repo root.
# Taking its parent silently points one level above the repository, which makes
# every path resolve to somewhere that does not exist.
$RepoRoot = $PSScriptRoot
$Port = 8787

$script:Results = [System.Collections.ArrayList]::new()

function Add-Result($name, $status) { [void]$script:Results.Add(@{ Name = $name; Status = $status }) }
function Step($m) { Write-Host ""; Write-Host "-- $m" -ForegroundColor White }

function Show-Summary {
    Write-Host ""
    Write-Host ("  " + ("-" * 54)) -ForegroundColor DarkGray
    $failed = 0
    foreach ($r in $script:Results) {
        switch ($r.Status) {
            "PASS" { Write-Host "  PASS  $($r.Name)" -ForegroundColor Green }
            "SKIP" { Write-Host "  SKIP  $($r.Name)" -ForegroundColor Yellow }
            default { Write-Host "  FAIL  $($r.Name)" -ForegroundColor Red; $failed++ }
        }
    }
    Write-Host ("  " + ("-" * 54)) -ForegroundColor DarkGray
    Write-Host ""
    if ($failed -gt 0) {
        Write-Host "  $failed check(s) failed." -ForegroundColor Red
        Write-Host "  See the console output above and docs/TROUBLESHOOTING.md" -ForegroundColor DarkGray
        exit 1
    }
    Write-Host "  All automated checks pass." -ForegroundColor Green
    Write-Host "  Still unverified: that a tap on the laptop produces a real tap on a" -ForegroundColor DarkGray
    Write-Host "  real phone. That needs a human and the demo device." -ForegroundColor DarkGray
    exit 0
}

Write-Host "Break Remote -- full check" -ForegroundColor White
Write-Host (Get-Date -Format "yyyy-MM-dd HH HH:mm:ss") -ForegroundColor DarkGray

# ── Android ─────────────────────────────────────────────────────────────────
Step "Android: build, lint, unit tests"

$sdk = $env:ANDROID_HOME
if ([string]::IsNullOrWhiteSpace($sdk)) { $sdk = $env:ANDROID_SDK_ROOT }
if ([string]::IsNullOrWhiteSpace($sdk) -or -not (Test-Path $sdk)) {
    # Common default install locations on Windows.
    $guess = "$env:LOCALAPPDATA\Android\Sdk"
    if (Test-Path $guess) { $sdk = $guess; $env:ANDROID_HOME = $guess }
}

if ([string]::IsNullOrWhiteSpace($sdk) -or -not (Test-Path $sdk)) {
    Write-Host "  SKIP  no Android SDK found" -ForegroundColor Yellow
    Write-Host "        set ANDROID_HOME, or install to $env:LOCALAPPDATA\Android\Sdk" -ForegroundColor DarkGray
    Write-Host "        see docs/SETUP.md" -ForegroundColor DarkGray
    Add-Result "android" "SKIP"
} else {
    Write-Host "  sdk:  $sdk" -ForegroundColor DarkGray
    # Pick the wrapper for the platform so this script is not Windows-only, and so
    # its logic can be exercised on a macOS or Linux dev box.
    $Gradlew = if ($IsWindows -or $env:OS -eq "Windows_NT") { ".\gradlew.bat" } else { "./gradlew" }
    Push-Location (Join-Path $RepoRoot "agent")
    & $Gradlew :app:assembleRelease :app:lintDebug :app:testDebugUnitTest 2>&1 |
        Select-Object -Last 12 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
    $rc = $LASTEXITCODE
    Pop-Location

    if ($rc -eq 0) {
        $apk = Join-Path $RepoRoot "agent\app\build\outputs\apk\release\app-release.apk"
        if (Test-Path $apk) {
            Write-Host "  ok    APK built ($((Get-Item $apk).Length) bytes)" -ForegroundColor Green
            Add-Result "android" "PASS"
        } else {
            Write-Host "  FAIL  build reported success but no APK was produced" -ForegroundColor Red
            Add-Result "android" "FAIL"
        }
    } else {
        Write-Host "  FAIL  gradle exited $rc" -ForegroundColor Red
        Add-Result "android" "FAIL"
    }
}

# ── relay ───────────────────────────────────────────────────────────────────
Step "Relay: dependencies"
Push-Location (Join-Path $RepoRoot "relay")
if (-not (Test-Path "node_modules")) {
    Write-Host "  installing relay dependencies..."
    & npm install 2>&1 | Select-Object -Last 3 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
}

Step "Relay: typecheck"
& npm run typecheck 2>&1 | Select-Object -Last 3 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
if ($LASTEXITCODE -eq 0) {
    Write-Host "  ok" -ForegroundColor Green
    Add-Result "typecheck" "PASS"
} else {
    Write-Host "  FAIL  (run: cd relay; npm install)" -ForegroundColor Red
    Add-Result "typecheck" "FAIL"
}

if ($script:Results | Where-Object { $_.Name -eq 'typecheck' -and $_.Status -eq 'FAIL' }) {
    Pop-Location
    Write-Host "`nCannot start the relay suites without a working install." -ForegroundColor Red
    Show-Summary
}

# ── start a local Worker ────────────────────────────────────────────────────
Step "Relay: starting a local Worker"

# $env:TEMP exists on Windows; macOS/Linux use $TMPDIR.
$tmpDir = if ($env:TEMP) { $env:TEMP } elseif ($env:TMPDIR) { $env:TMPDIR } else { [System.IO.Path]::GetTempPath() }
$log = Join-Path $tmpDir "brk-wrangler.log"
$logErr = "$log.err"
# npx is npx.cmd on Windows and plain npx everywhere else.
$npx = if ($IsWindows -or $env:OS -eq "Windows_NT") { "npx.cmd" } else { "npx" }
$IsWin = $IsWindows -or $env:OS -eq "Windows_NT"
$startArgs = @{
    FilePath               = $npx
    ArgumentList           = @("wrangler", "dev", "--port", "$Port", "--ip", "127.0.0.1")
    WorkingDirectory       = (Join-Path $RepoRoot "relay")
    RedirectStandardOutput = $log
    RedirectStandardError  = $logErr
    PassThru               = $true
}
# -WindowStyle only exists on Windows PowerShell / Windows.
if ($IsWin) { $startArgs["WindowStyle"] = "Hidden" }
$proc = Start-Process @startArgs

$up = $false
for ($i = 1; $i -le 60; $i++) {
    Start-Sleep -Seconds 1
    try {
        $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
        if ($h.ok) { Write-Host "  ok    up after ${i}s" -ForegroundColor Green; $up = $true; break }
    } catch { }
}
if (-not $up) {
    Write-Host "  FAIL  worker did not start" -ForegroundColor Red
    if (Test-Path $log) { Get-Content $log -Tail 20 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray } }
    if (Test-Path $logErr) { Get-Content $logErr -Tail 10 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray } }
    if ($proc) { Stop-Process $proc -Force -ErrorAction SilentlyContinue }
    # Record the suites as failed. Skipping them silently and then reporting
    # "all checks pass" is the single most misleading thing this script could do.
    foreach ($s in @("e2e", "console", "record")) { Add-Result $s "FAIL" }
    if (-not $Quick) { Add-Result "load" "FAIL" }
    Pop-Location
    Show-Summary
}

function Invoke-Suite($label, $script, [string[]]$extra = @()) {
    Step $label
    & node $script @extra 2>&1 | Select-String -Pattern "passed,|PASS:|FAIL:|^  - " |
        Select-Object -Last 6 | ForEach-Object {
            $line = $_.ToString()
            $col = if ($line -match "FAIL|^\s+- ") { 'Red' } else { 'DarkGray' }
            Write-Host "  $line" -ForegroundColor $col
        }
    if ($LASTEXITCODE -eq 0) { Add-Result $label "PASS" } else { Add-Result $label "FAIL" }
}

$ws = "ws://127.0.0.1:$Port"
$h  = "http://127.0.0.1:$Port"
Invoke-Suite "e2e"     "tools/e2e.mjs"          @("--url", $ws)
Invoke-Suite "console" "tools/console-smoke.mjs" @("--url", $h)
Invoke-Suite "record"  "tools/record-smoke.mjs"  @("--url", $h)
if (-not $Quick) {
    Invoke-Suite "load" "tools/loadtest.mjs" @("--url", $ws, "--fps", "10", "--kb", "40", "--seconds", "30")
} else {
    Add-Result "load" "SKIP"
}

Pop-Location
Stop-Process $proc -Force -ErrorAction SilentlyContinue
Remove-Item $logErr -ErrorAction SilentlyContinue
Show-Summary
