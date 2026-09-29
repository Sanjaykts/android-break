#!/usr/bin/env bash
#
# reset.sh — return the lab to a known-clean state (proposal sections 7.10, 12).
#
# Takes a before-and-after inventory, so "we cleaned up" is evidence rather than a
# claim. Run it at the end of every demonstration.
#
#   ./tools/lab/reset.sh                 inventory, reset, re-inventory, diff
#   ./tools/lab/reset.sh --inventory     just show current state, change nothing
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LAB_URL="${LAB_URL:-http://127.0.0.1:8787}"
TOKEN="${CONSOLE_TOKEN:-}"
OUT_DIR="${OUT_DIR:-lab-evidence}"
mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"

# No argument means "do the full reset". The previous form resolved a missing
# argument to --inventory, so the default invocation silently only printed a
# report and wiped nothing -- which is the one outcome this script must not have.
ACTION="${1:-reset}"
if [ "$#" -gt 0 ] && [ "$1" = "--inventory" ]; then ACTION="inventory"; fi

inventory() {
  local label="$1"
  echo "── inventory: $label ──"
  if [ -n "$TOKEN" ] && curl -fsS --max-time 5 "$LAB_URL/lab/sessions?token=$TOKEN" >/dev/null 2>&1; then
    curl -fsS --max-time 5 "$LAB_URL/lab/sessions?token=$TOKEN" \
      | tr ',' '\n' | grep -E 'session_id|event_count' | sed 's/^/  /' || echo "  no sessions"
  else
    echo "  lab server not reachable at $LAB_URL (this is fine if it is already stopped)"
  fi
  echo
}

echo "Lab reset -- $STAMP"
echo

inventory "before"

if [ "$ACTION" = "reset" ]; then
  echo "Wiping telemetry store..."
  if [ -z "$TOKEN" ]; then
    echo "  CONSOLE_TOKEN not set; skipping the server-side wipe."
    echo "  Set it if you want the evidence store cleared too."
  else
    curl -fsS -X POST "$LAB_URL/lab/reset" \
      -H 'content-type: application/json' \
      -H "Authorization: Bearer $TOKEN" \
      -d '{"confirm":"RESET_LAB"}' >/dev/null \
      && echo "  telemetry store cleared" \
      || echo "  reset refused -- check the token"
  fi
  echo
fi

inventory "after"

cat <<EOF

Manual steps that a script cannot do for you
--------------------------------------------
  [ ] uninstall the lab app from the device
  [ ] delete any synthetic SMS/contacts the platform refused to let the app
      remove (Settings, or 'adb shell pm clear' in a lab)
  [ ] restore the emulator snapshot, or re-enrol the device to a clean state
  [ ] remove the app's synthetic files if uninstall left them
  [ ] confirm the device is back on the organisation's baseline

Two things worth recording as findings rather than fixing
--------------------------------------------------------
  - an app normally cannot write or delete from the SMS provider, so synthetic
    SMS may need to be removed by hand
  - these two lines are therefore evidence about the SMS permission model, not
    a defect in the lab app
EOF
