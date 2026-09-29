#!/usr/bin/env bash
#
# collect-device-evidence.sh — capture the Android-control evidence that needs a
# physical device (proposal sections 5 and 11).
#
# Everything this script gathers is read-only inspection. It asks the platform to
# describe its own state; it changes nothing and exploits nothing.
#
#   ./tools/lab/collect-device-evidence.sh                 # via adb
#   ./tools/lab/collect-device-evidence.sh --no-adb        # what to run by hand
#
# Output lands in lab-evidence/device-<timestamp>/ and is the raw material for
# section 11. Sanitise before it leaves the lab.
#
set -uo pipefail

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="lab-evidence/device-$STAMP"
mkdir -p "$OUT"

have_adb() { command -v adb >/dev/null 2>&1 && adb devices | grep -qE "^$1\s+device$"; }

if [ "${1:-}" = "--no-adb" ] || ! command -v adb >/dev/null 2>&1; then
  cat <<EOF
adb is not available, so nothing was collected.

Run these on the lab device, either from a workstation with adb or from a shell.
Each one is a read-only query.

  SELinux  (proposal section 5, B3)
    getenforce                     enforcing | permissive
    getsebool -a | grep -i http     network security policy
    logcat -b all -d | grep -i "avc:.*denied"
    ls -Z /data/data                label on app data directories

  Verified boot  (section 5, B5)
    getprop ro.boot.verifiedbootstate    green | yellow | red
    getprop ro.boot.bootverified         Boot Verified state
    getprop ro.boot.flash.locked         flash lock state

  Sandbox  (section 5, B1)
    Attempt a cross-app read with no grant and record the SecurityException.
    From the lab app, query another app's provider without permission; the denial
    message is the evidence.

  App signing  (section 5, B4) — already automated in CI, but capture for the pack:
    apksigner verify --print-certs <apk>
    dumpsys package <package> | grep -A2 "signatures"

  Play Protect  (section 5, B7)
    Screenshot the Play Protect warning shown when the training target is
    installed from outside the store. Do NOT attempt to suppress it.

  Installed packages and permissions  (section 10, D6)
    pm list packages -3
    dumpsys package <pkg> | grep -A40 "requested permissions"

Artifacts to capture
  [ ] every screenshot of every permission prompt (section 11)
  [ ] the output of the commands above, unedited
  [ ] a note of the device model and Android version, into docs/COMPATIBILITY.md
EOF
  exit 2
fi

SERIAL="${ANDROID_SERIAL:-$(adb devices | awk '$2=="device"{print $1; exit}')}"
if [ -z "$SERIAL" ]; then
  echo "no adb device connected" >&2
  exit 2
fi
echo "collecting from $SERIAL -> $OUT"

run() {
  local name="$1"; shift
  { echo "\$ $*"; "$@"; } > "$OUT/$name.txt" 2>&1
  printf '  %-32s %s\n' "$name" "$(wc -l < "$OUT/$name.txt" | tr -d ' ') lines"
}

echo
echo "device identity"
run device-identity sh -c "adb -s $SERIAL shell getprop ro.product.model; adb -s $SERIAL shell getprop ro.build.version.release; adb -s $SERIAL shell getprop ro.build.version.sdk; adb -s $SERIAL shell getprop ro.build.fingerprint"

echo
echo "SELinux (section 5, B3)"
run selinux-enforcing sh -c "adb -s $SERIAL shell getenforce"
run selinux-booleans sh -c "adb -s $SERIAL shell getsebool -a"
run selinux-denials sh -c "adb -s $SERIAL logcat -b all -d | grep -i 'avc:.*denied' | head -100"
run app-data-labels sh -c "adb -s $SERIAL shell ls -Z /data/data | head -60"

echo
echo "verified boot (section 5, B5)"
run verified-boot sh -c "adb -s $SERIAL shell getprop ro.boot.verifiedbootstate; adb -s $SERIAL shell getprop ro.boot.bootverified; adb -s $SERIAL shell getprop ro.boot.flash.locked"

echo
echo "sandbox and signing (section 5, B1, B4)"
run installed-packages sh -c "adb -s $SERIAL shell pm list packages -3"
run app-signing sh -c "adb -s $SERIAL shell dumpsys package dev.breakremote.agent | grep -A2 signatures"
run requested-permissions sh -c "adb -s $SERIAL shell dumpsys package dev.breakremote.lab | grep -A40 'requested permissions'"

echo
echo "synthetic dataset inventory (proposal section 12)"
run synthetic-records sh -c "adb -s $SERIAL shell run-as dev.breakremote.lab ls -R files 2>&1 | head -40"

echo
echo "wrote $OUT"
cat <<EOF

Next
  [ ] screenshot every runtime permission prompt as it appears
  [ ] copy this directory into the section 11 evidence pack
  [ ] sanitise before it leaves the lab -- see lab/AUTHORIZATION.md section 8
  [ ] record the device model and Android version in docs/COMPATIBILITY.md

Nothing here modifies the device. Every command is a read-only query.
EOF
