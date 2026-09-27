#!/usr/bin/env bash
#
# demo-start.sh -- one action before walking on stage.
#
# Health-checks the relay, then opens the console fullscreen with the device
# already paired. If the device is not connected it says so instead of showing
# an empty list.
#
#   RELAY_URL=https://... CONSOLE_TOKEN=... ./demo-start.sh
#
# Tokens are read from the environment, never from this file, so the script is
# safe to have in the repository and in a screen share.

set -uo pipefail

RELAY_URL="${RELAY_URL:-}"
CONSOLE_TOKEN="${CONSOLE_TOKEN:-}"

if [ -t 1 ]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; BOLD=$'\033[1m'; OFF=$'\033[0m'
else
  RED=""; GREEN=""; BOLD=""; OFF=""
fi

die() { printf "%s%s%s\n" "$RED$BOLD" "$1" "$OFF" >&2; exit 1; }

[ -n "$RELAY_URL" ]     || die "RELAY_URL is not set"
[ -n "$CONSOLE_TOKEN" ] || die "CONSOLE_TOKEN is not set"

# Normalise for HTTP probes while preserving the scheme, so this also works
# against a local `wrangler dev`.
RELAY_SCHEME="${RELAY_URL%%://*}"
http_base="${RELAY_URL#*://}"
http_base="${http_base%/ws/agent}"
http_base="${http_base%/ws/console}"
if [ "$RELAY_SCHEME" = "wss" ]; then RELAY_SCHEME="https"; fi

printf "%sBreak Remote%s\n" "$BOLD" "$OFF"

if ! health=$(curl -fsS --max-time 8 "${RELAY_SCHEME}://${http_base}/health" 2>/dev/null); then
  die "relay is not responding at https://${http_base}/health"
fi
printf "  %sok%s    relay healthy\n" "$GREEN" "$OFF"

devices=$(curl -fsS --max-time 8 "${RELAY_SCHEME}://${http_base}/devices?token=${CONSOLE_TOKEN}" 2>/dev/null) \
  || die "relay rejected the console token (401)"

count=$(printf '%s' "$devices" | grep -o '"id"' | wc -l | tr -d ' ')
if [ "$count" -eq 0 ]; then
  printf "  %swarn%s  no device connected -- is the app running on the phone?\n" "$RED" "$OFF"
else
  printf "  %sok%s    %s device(s) connected\n" "$GREEN" "$OFF" "$count"
fi

# Keep the laptop awake for the duration. A sleeping display mid-demo is the most
# common self-inflicted failure and costs a whole beat.
if [ "$(uname)" = "Darwin" ] && command -v caffeinate >/dev/null 2>&1; then
  caffeinate -dimsu -w $$ >/dev/null 2>&1 &
  disown 2>/dev/null || true
  printf "  %sok%s    display sleep inhibited\n" "$GREEN" "$OFF"
fi

url="${RELAY_SCHEME}://${http_base}/?token=${CONSOLE_TOKEN}"
printf "\n  opening %s\n" "$url"
printf "  %sfullscreen is automatic; press F to toggle%s\n" "$DIM" "$OFF" 2>/dev/null || true

open "$url" 2>/dev/null || xdg-open "$url" 2>/dev/null || {
  die "could not open a browser -- open this manually: $url"
}
