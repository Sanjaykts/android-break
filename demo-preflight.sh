#!/usr/bin/env bash
#
# demo-preflight.sh -- red/green checks before walking on stage.
#
# Run this from a cold start, on the demo laptop, on the demo network. Every
# check prints PASS or FAIL, and the script exits non-zero if anything failed, so
# it can be the first thing you do and the last thing you check.
#
#   ./demo-preflight.sh
#
# Environment:
#   RELAY_URL       relay base URL  (required)
#   CONSOLE_TOKEN   console token   (required)
#
# Neither is baked in. The whole point of the pre-flight is that a failure here
# is discovered on the laptop, not on stage.

set -uo pipefail

RELAY_URL="${RELAY_URL:-}"
CONSOLE_TOKEN="${CONSOLE_TOKEN:-}"

if [ -t 1 ]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; DIM=$'\033[2m'; OFF=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; BOLD=""; DIM=""; OFF=""
fi

fails=0
warns=0

pass() { printf "  %sPASS%s  %s\n" "$GREEN" "$OFF" "$1"; }
fail() { printf "  %sFAIL%s  %s\n" "$RED" "$OFF" "$1"; fails=$((fails + 1)); }
warn() { printf "  %sWARN%s  %s\n" "$YELLOW" "$OFF" "$1"; warns=$((warns + 1)); }
head2() { printf "\n%s%s%s\n" "$BOLD" "$1" "$OFF"; }

need() {
  local var_name="$1" value="${2:-}"
  if [ -z "$value" ]; then
    fail "$var_name is not set"
    return 1
  fi
  return 0
}

printf "%sBreak Remote -- demo pre-flight%s\n" "$BOLD" "$OFF"
printf "%s%s%s\n" "$DIM" "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$OFF"

# ── 1. configuration ─────────────────────────────────────────────────────────
head2 "1. Configuration"

if need "RELAY_URL" "$RELAY_URL"; then
  pass "RELAY_URL is set"
  case "$RELAY_URL" in
    https://*|wss://*) pass "relay is TLS" ;;
    http://127.0.0.1*|http://localhost*) pass "relay is local http (fine for dev, not for a demo)" ;;
    *) fail "RELAY_URL is not https/wss -- getUserMedia needs a secure context" ;;
  esac
fi
if need "CONSOLE_TOKEN" "$CONSOLE_TOKEN"; then
  pass "CONSOLE_TOKEN is set"
fi

# ── 2. the demo laptop itself ────────────────────────────────────────────────
head2 "2. Demo laptop"

if command -v curl >/dev/null 2>&1; then
  pass "curl available"
else
  fail "curl is not installed (needed for the relay checks)"
fi

# A browser that cannot do canvas capture cannot record the demo.
if [ -d "/Applications/Google Chrome.app" ] || [ -d "/Applications/Chromium.app" ]; then
  pass "Chrome or Chromium found"
elif command -v google-chrome >/dev/null 2>&1; then
  pass "google-chrome found"
else
  warn "no Chrome found -- the console and the recorder need it"
fi

if [ "$(uname)" = "Darwin" ]; then
  # Autolock mid-demo is the single most common self-inflicted failure.
  if pmset -g custom 2>/dev/null | grep -qE "sleep [0-9]+$"; then
    sleep_min=$(pmset -g custom 2>/dev/null | sed -n 's/.*sleep \([0-9]*\)$/\1/p' | head -1)
    if [ -n "$sleep_min" ] && [ "$sleep_min" -le 10 ] 2>/dev/null; then
      warn "laptop display sleeps after ${sleep_min}min -- run: caffeinate -dimsu -w $$ &"
    else
      pass "laptop sleep looks fine (${sleep_min:-unknown} min)"
    fi
  fi
fi

# ── 3. network reachability ──────────────────────────────────────────────────
head2 "3. Network"

if [ -n "$RELAY_URL" ]; then
# Normalise the relay URL for HTTP probes while preserving the scheme, so the
# same script works against a local `wrangler dev` on http and a deployed worker
# on https. The scheme is checked separately rather than assumed.
RELAY_SCHEME="${RELAY_URL%%://*}"
http_base="${RELAY_URL#*://}"
http_base="${http_base%/ws/agent}"
http_base="${http_base%/ws/console}"
if [ "$RELAY_SCHEME" = "wss" ]; then RELAY_SCHEME="https"; fi

  if health=$(curl -fsS --max-time 10 "${RELAY_SCHEME}://${http_base}/health" 2>/dev/null); then
    if printf '%s' "$health" | grep -q '"ok":true'; then
      pass "relay /health responded ok"
    else
      fail "relay /health returned unexpected body: $health"
    fi
  else
    fail "cannot reach relay /health at https://${http_base}/health"
  fi

  if devices=$(curl -fsS --max-time 10 \
      "${RELAY_SCHEME}://${http_base}/devices?token=${CONSOLE_TOKEN}" 2>/dev/null); then
    count=$(printf '%s' "$devices" | grep -o '"id"' | wc -l | tr -d ' ')
    if [ "$count" -gt 0 ]; then
      pass "relay reports $count device(s) connected"
    else
      fail "relay reachable but no device is connected -- is the app running on the phone?"
    fi
  else
    fail "relay rejected the console token (401) or is unreachable"
  fi

  # A venue firewall that allows TCP but throttles WebSockets is the failure mode
  # that only shows up as a slow demo, so measure it now rather than then.
  if command -v nc >/dev/null 2>&1; then
    host="${http_base%%:*}"; port="${http_base##*:}"
    if [ "$host" = "$http_base" ]; then
      port=443
      [ "$RELAY_SCHEME" = "http" ] && port=80
    fi
    if nc -z -G 5 "$host" "$port" 2>/dev/null; then
      pass "tcp/$port reachable to $host"
    else
      fail "tcp/$port not reachable to $host"
    fi
  fi
fi

# ── 4. the phone ─────────────────────────────────────────────────────────────
head2 "4. Phone"

cat <<'EOF'
  These cannot be checked from the laptop. Confirm each on the phone itself:

    [ ] app installed from the browser link, and still installed
    [ ] Accessibility  -> Break Remote Control  -> ON
    [ ] battery use    -> Unrestricted
    [ ] screen timeout -> 30 minutes or Never
    [ ] screen sharing -> allowed, live view flowing in the console
    [ ] phone is on cellular data, laptop is on a different network
    [ ] phone is unlocked and awake (no PIN prompt, screen on)
    [ ] screen is NOT rotated away from the orientation you will present
    [ ] nothing sensitive is on screen (notifications, messages, photos)
EOF

if [ "$warns" -gt 0 ]; then
  printf "\n  %d warning(s). Warnings are advisory; failures are not.\n" "$warns"
fi

printf "\n%s%s%s\n" "$BOLD" "────────────────────────────────────────────────" "$OFF"
if [ "$fails" -gt 0 ]; then
  printf "%s%d CHECK(S) FAILED%s -- do not go on stage yet.\n" "$RED$BOLD" "$fails" "$OFF"
  exit 1
fi
printf "%sAll automated checks passed.%s Work through the phone list above.\n" "$GREEN$BOLD" "$OFF"
exit 0
