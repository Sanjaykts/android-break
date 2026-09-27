#!/usr/bin/env bash
#
# demo-freeze.sh -- the last gate before the day.
#
# Two jobs:
#
#   1. Re-run every automated check. A green suite is necessary, not sufficient.
#   2. Verify the things that are *not* automated and that people skip, which is
#      how a "ready" demo turns out to have no fallback video.
#
# It deliberately FAILS while demo.mp4 is missing. That is the point: the
# prerecorded fallback is mandatory, and the only reliable time to discover it is
# missing is before you are on stage rather than during.
#
#   ./demo-freeze.sh
#
# After this passes: NO CODE CHANGES. Write down anything you find and fix it
# after the demo.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -t 1 ]; then
  B=$'\033[1m'; G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; D=$'\033[2m'; O=$'\033[0m'
else
  B=""; G=""; R=""; Y=""; D=""; O=""
fi

fails=0
pass() { printf "  %sPASS%s  %s\n" "$G" "$O" "$1"; }
fail() { printf "  %sFAIL%s  %s\n" "$R" "$O" "$1"; fails=$((fails + 1)); }
warn() { printf "  %sWARN%s  %s\n" "$Y" "$O" "$1"; }
head2() { printf "\n%s%s%s\n" "$B" "$1" "$O"; }

printf "%sBreak Remote — demo freeze gate%s\n" "$B" "$O"
printf "%s%s%s\n" "$D" "$(date '+%Y-%m-%d %H:%M:%S')" "$O"

# ── 1. automated suite ─────────────────────────────────────────────────────
head2 "1. Automated checks"
if "$ROOT/check-all.sh" --quick > /tmp/brk-freeze.log 2>&1; then
  pass "check-all.sh"
  grep -E "^  (PASS|FAIL)" /tmp/brk-freeze.log | sed 's/^/    /'
else
  fail "check-all.sh"
  grep -E "^  (PASS|FAIL)|^  - " /tmp/brk-freeze.log | sed 's/^/    /' | head -12
fi

# ── 2. the fallback video ──────────────────────────────────────────────────
head2 "2. Prerecorded fallback video"
DEMO_MP4="$ROOT/demo.mp4"
if [ -f "$DEMO_MP4" ]; then
  size=$(stat -f%z "$DEMO_MP4" 2>/dev/null || stat -c%s "$DEMO_MP4")
  if [ "$size" -gt 200_000 ]; then
    pass "demo.mp4 exists (${size} bytes)"
  else
    fail "demo.mp4 is only ${size} bytes -- that is a placeholder, not a video"
  fi
  # A rehearsal capture with a mock phone is worse than nothing: the audience
  # will notice, and the presenter will not, because it looks like a real run.
  if head -c 4000 "$DEMO_MP4" 2>/dev/null | strings | grep -qiE "rehearsal|mock phone|placeholder"; then
    fail "demo.mp4 is marked as a rehearsal or placeholder capture"
  else
    pass "demo.mp4 is not marked as a placeholder"
  fi
  if [ -f "$ROOT/console-rehearsal.webm" ]; then
    warn "console-rehearsal.webm exists -- do NOT use it as the fallback"
  fi
else
  fail "demo.mp4 is MISSING -- the fallback ladder has no first rung"
  printf "        record it once the phone is enrolled:\n"
  printf "          cd relay && node tools/record-demo.mjs --url \$RELAY_URL --device <id>\n"
fi

# ── 3. deployment ──────────────────────────────────────────────────────────
head2 "3. Deployment"
if [ -n "${RELAY_URL:-}" ]; then
  # Preserve the scheme so a local `wrangler dev` can be checked too, while a
  # deployed wss:// relay still gets an https probe.
  scheme="${RELAY_URL%%://*}"
  base="${RELAY_URL#*://}"
  base="${base%/ws/agent}"; base="${base%/ws/console}"
  [ "$scheme" = "wss" ] && scheme="https"
  if curl -fsS --max-time 10 "${scheme}://${base}/health" 2>/dev/null | grep -q '"ok":true'; then
    pass "relay is live at $RELAY_URL"
  else
    fail "relay is not responding at $RELAY_URL"
  fi
else
  warn "RELAY_URL not set -- cannot check the relay. export it before the demo."
fi

# ── 4. published APK ───────────────────────────────────────────────────────
head2 "4. Published APK"
APK_URL="https://github.com/Sanjaykts/android-break/releases/download/apk-latest/agent.apk"
code=$(curl -sIL -o /dev/null -w '%{http_code}' --max-time 25 "$APK_URL" 2>/dev/null)
if [ "$code" = "200" ]; then
  pass "the install link resolves (HTTP 200)"
else
  fail "the install link returns HTTP ${code:-000} -- re-run the build workflow"
fi

# ── 5. enrollment material ─────────────────────────────────────────────────
head2 "5. Enrollment material"
if [ -f "$ROOT/tools/out/enroll.html" ]; then
  if grep -q "SHOT_" "$ROOT/tools/out/enroll.html" 2>/dev/null; then
    fail "enroll.html still has unfilled screenshot placeholders"
  else
    pass "enroll.html is complete"
  fi
  if [ -f "$ROOT/tools/out/apk-download.png" ]; then
    pass "QR code present"
  else
    fail "QR code missing -- run tools/make-qr.sh"
  fi
else
  fail "tools/out/enroll.html missing -- run tools/make-enroll-pdf.sh"
fi

# ── 6. things a human must confirm ─────────────────────────────────────────
head2 "6. Manual confirmations (cannot be checked from here)"
cat <<'EOF'
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
EOF

# ── summary ────────────────────────────────────────────────────────────────
printf "\n%s%s%s\n" "$B" "──────────────────────────────────────────────────────" "$O"
if [ "$fails" -gt 0 ]; then
  printf "%s%d gate(s) failed.%s Do not freeze, and definitely do not go on stage.\n" "$R$B" "$fails" "$O"
  exit 1
fi
printf "%sAll automated gates pass.%s\n" "$G$B" "$O"
printf "%sWork through section 6, then freeze. No code changes after this point.%s\n" "$B" "$O"
