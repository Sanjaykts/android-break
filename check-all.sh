#!/usr/bin/env bash
#
# check-all.sh -- run every automated check this project has.
#
# One command to answer "is anything broken?". Runs the Android build, the
# protocol unit tests, and all four relay suites against a real local Worker.
#
#   ./check-all.sh              full run
#   ./check-all.sh --quick      skip the 30s load test
#
# What this CANNOT tell you is whether dispatchGesture produces real touch
# events on a real handset. That needs a human and a phone, and it is the one
# thing the whole project rests on. See docs/COMPATIBILITY.md.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

if [ -t 1 ]; then
  B=$'\033[1m'; G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; D=$'\033[2m'; O=$'\033[0m'
else
  B=""; G=""; R=""; Y=""; D=""; O=""
fi

declare -a NAMES=() RESULTS=()
fails=0
port=8787

section() { printf "\n%s── %s %s\n" "$B" "$1" "$O"; }
record()  { NAMES+=("$1"); RESULTS+=("$2"); [ "$2" = "FAIL" ] && fails=$((fails+1)); return 0; }

cleanup() {
  [ -n "${WRANGLER_PID:-}" ] && kill "$WRANGLER_PID" 2>/dev/null
}
trap cleanup EXIT

printf "%sBreak Remote — full check%s\n" "$B" "$O"
printf "%s%s%s\n" "$D" "$(date '+%Y-%m-%d %H:%M:%S')" "$O"

# ── Android ─────────────────────────────────────────────────────────────────
section "Android: build, lint, unit tests"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"

if [ ! -d "$ANDROID_HOME" ]; then
  record "android" SKIP
  printf "  %sSKIP%s  no Android SDK at %s\n" "$Y" "$O" "$ANDROID_HOME"
  printf "        install with tools/install-sdk.sh\n"
else
  # Redirect to the log first and grep the file afterwards. Piping into `grep -q`
  # would close the pipe on first match, SIGPIPE the writer, and -- because this
  # script runs with `pipefail` -- report a perfectly good build as a failure.
  (cd "$ROOT/agent" && ./gradlew :app:assembleRelease :app:lintDebug \
        :app:testDebugUnitTest > /tmp/brk-android.log 2>&1)
  gradle_rc=$?
  if [ $gradle_rc -eq 0 ] && grep -qE "BUILD SUCCESSFUL" /tmp/brk-android.log; then
    APK="$ROOT/agent/app/build/outputs/apk/release/app-release.apk"
    if [ -f "$APK" ]; then
      if "$ANDROID_HOME/build-tools/34.0.0/apksigner" verify "$APK" >/dev/null 2>&1; then
        printf "  %sok%s    signed APK, %s bytes\n" "$G" "$O" "$(stat -f%z "$APK" 2>/dev/null || stat -c%s "$APK")"
        record "android" PASS
      else
        printf "  %sFAIL%s  APK is not signed\n" "$R" "$O"
        record "android" FAIL
      fi
    else
      printf "  %sFAIL%s  no APK produced\n" "$R" "$O"
      record "android" FAIL
    fi
  else
    printf "  %sFAIL%s  see /tmp/brk-android.log\n" "$R" "$O"
    tail -25 /tmp/brk-android.log
    record "android" FAIL
  fi
fi

# ── relay ───────────────────────────────────────────────────────────────────
section "Relay: typecheck"
if (cd "$ROOT/relay" && [ -d node_modules ] && npm run typecheck >/dev/null 2>&1); then
  printf "  %sok%s\n" "$G" "$O"
  record "typecheck" PASS
else
  printf "  %sFAIL%s  (run: cd relay && npm install)\n" "$R" "$O"
  record "typecheck" FAIL
fi

if [ "${NAMES[1]:-}" = "FAIL" ]; then
  printf "\n%sCannot start the relay suites without a working install.%s\n" "$R" "$O"
  exit 1
fi

section "Relay: starting a local Worker"
(cd "$ROOT/relay" && npx wrangler dev --port "$port" --ip 127.0.0.1 > /tmp/brk-wrangler.log 2>&1) &
WRANGLER_PID=$!
up=0
for i in $(seq 1 60); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
    printf "  %sok%s    up after %ss\n" "$G" "$O" "$i"; up=1; break
  fi
  sleep 1
done
if [ "$up" -ne 1 ]; then
  printf "  %sFAIL%s  worker did not start\n" "$R" "$O"
  tail -20 /tmp/brk-wrangler.log
  printf "\n%sRelay suites skipped.%s\n" "$R" "$O"
  exit 1
fi

run_suite_exit() {
  local label="$1" cmd="$2"
  printf "\n%s── %s %s\n" "$B" "$label" "$O"
  (cd "$ROOT/relay" && eval "$cmd" > "/tmp/brk-$label.log" 2>&1)
  local rc=$?
  grep -E "passed, .* failed|PASS:|FAIL:" "/tmp/brk-$label.log" | sed 's/^/  /' | tail -3
  if [ $rc -eq 0 ]; then record "$label" PASS; else
    printf "  %sFAIL%s  see /tmp/brk-%s.log\n" "$R" "$O" "$label"
    grep -E "^  - " "/tmp/brk-$label.log" | sed 's/^/  /' | head -5
    record "$label" FAIL
  fi
}

run_suite_exit "e2e"    "node tools/e2e.mjs --url ws://127.0.0.1:$port"
run_suite_exit "console" "node tools/console-smoke.mjs --url http://127.0.0.1:$port"
run_suite_exit "record"  "node tools/record-smoke.mjs --url http://127.0.0.1:$port"
if [ "$QUICK" -eq 0 ]; then
  run_suite_exit "load" "node tools/loadtest.mjs --url ws://127.0.0.1:$port --fps 10 --kb 40 --seconds 30"
else
  record "load" SKIP
fi

# ── summary ─────────────────────────────────────────────────────────────────
printf "\n%s%s%s\n" "$B" "──────────────────────────────────────────────────────" "$O"
for i in "${!NAMES[@]}"; do
  case "${RESULTS[$i]}" in
    PASS) printf "  %sPASS%s  %s\n" "$G" "$O" "${NAMES[$i]}" ;;
    SKIP) printf "  %sSKIP%s  %s\n" "$Y" "$O" "${NAMES[$i]}" ;;
    *)    printf "  %sFAIL%s  %s\n" "$R" "$O" "${NAMES[$i]}" ;;
  esac
done
printf "%s%s%s\n" "$B" "──────────────────────────────────────────────────────" "$O"

if [ "$fails" -gt 0 ]; then
  printf "%s%d check(s) failed.%s\n" "$R$B" "$fails" "$O"
  exit 1
fi
printf "%sAll automated checks pass.%s\n" "$G$B" "$O"
printf "%sStill unverified: that a tap on the laptop produces a real tap on a\n" "$D"
printf "real phone. That needs a human and the demo device.%s\n" "$O"
