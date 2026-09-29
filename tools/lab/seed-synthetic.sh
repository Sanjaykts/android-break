#!/usr/bin/env bash
#
# seed-synthetic.sh — put synthetic SMS and contacts on an emulator or lab device
# (proposal section 7, steps 5-6).
#
# Why this exists:
#
# `SyntheticData.seedSms` tries to insert through ContentResolver and gets a
# SecurityException on any device where our app is not the default SMS handler.
# That is the platform working correctly, not a bug, and the app degrades to an
# in-memory dataset. But an in-memory dataset cannot demonstrate the thing the
# proposal actually cares about: an app reading a real content provider *after*
# the user consents.
#
# So this writes the same records the app would have written, tagged with the
# same LABONLY- marker, via adb. The app then reads them through the ordinary
# permission-gated path. Nothing here bypasses a permission on the device: adb
# shell runs as the shell user, which is how a developer would stage test data.
#
# Requires an emulator or an adb-debuggable device. Never run against a personal
# phone -- see lab/AUTHORIZATION.md section 3.
#
#   ./tools/lab/seed-synthetic.sh            # seed
#   ./tools/lab/seed-synthetic.sh --show     # list what we put there
#   ./tools/lab/seed-synthetic.sh --purge    # remove it
#
set -uo pipefail

MARKER="LABONLY"
PKG="dev.breakremote.lab"
MODE="${1:-seed}"

if ! command -v adb >/dev/null 2>&1; then
  cat <<EOF
adb is not available.

This helper only makes sense for an emulator or a device with USB debugging
enabled. On a physical lab device, prefer letting the app attempt the insert
itself and accepting the SecurityException -- the refusal is part of the
section 5 B2 lesson.

Without adb, the in-app path still works:
  - SyntheticData.seedSms / seedContacts insert directly when permitted
  - and fall back to an in-app dataset when not
EOF
  exit 2
fi

SERIAL="${ANDROID_SERIAL:-$(adb devices | awk '$2=="device"{print $1; exit}')}"
if [ -z "$SERIAL" ]; then
  echo "no adb device connected" >&2
  exit 2
fi
sh_() { adb -s "$SERIAL" shell "$@"; }

# The app's marker is LABONLY- followed by a three-digit index. Match that so
# tools/lab/reset.sh can verify a clean teardown afterwards.
addr() { echo "$MARKER-$1"; }
dt()   { echo "$(( 1735689600000 + $1 * 60000 ))"; }   # fixed epoch, ms

seed_sms() {
  local bodies=(
    "Lab test message: enrollment confirmed for session."
    "Lab test message: synthetic appointment at 14:00, room B."
    "Lab test message: do not action. This record is test data only."
    "Lab test message: permission prompt screenshot pending."
    "Lab test message: relay handshake acknowledged."
    "Lab test message: end of synthetic dataset."
  )
  local i=0
  for b in "${bodies[@]}"; do
    printf "  sms %s -> %s\n" "$(addr "$i")" "$b"
    sh_ content insert \
      --uri "content://sms/inbox" \
      --bind "address:$(addr "$i")" \
      --bind "body:$b" \
      --bind "date:$(dt "$i")" \
      --bind "read:1" >/dev/null 2>&1 \
      || echo "     (insert refused -- already present, or provider restricted)"
    i=$((i + 1))
  done
}

seed_contacts() {
  local names=(Alpha Bravo Charlie Delta Echo)
  local i=0
  for n in "${names[@]}"; do
    printf "  contact %s Contact %s\n" "$MARKER" "$n"
    sh_ content insert \
      --uri "content://com.android.contacts/rawContacts" \
      --bind "account_type:local" \
      --bind "account_name:$MARKER" >/dev/null 2>&1 \
      || echo "     (raw contact insert refused)"
    sh_ content insert \
      --uri "content://com.android.contacts/data" \
      --bind "mimetype:vnd.android.cursor.item/name" \
      --bind "data1:$MARKER Contact $n" >/dev/null 2>&1 \
      || echo "     (name insert refused)"
    i=$((i + 1))
  done
}

show() {
  echo "SMS records matching $MARKER:"
  sh_ content query --uri "content://sms/inbox" 2>/dev/null \
    | tr ',' '\n' | grep -i "$MARKER" | sed 's/^/  /' || echo "  (none)"
  echo
  echo "Contacts matching $MARKER:"
  sh_ content query --uri "content://com.android.contacts/contacts" 2>/dev/null \
    | tr ',' '\n' | grep -i "$MARKER" | sed 's/^/  /' || echo "  (none)"
}

purge() {
  echo "removing every $MARKER record"
  sh_ content delete --uri "content://sms/inbox" --where "address LIKE '$MARKER%'" 2>&1 | sed 's/^/  /'
  sh_ content delete --uri "content://com.android.contacts/rawContacts" \
    --where "account_name='$MARKER'" 2>&1 | sed 's/^/  /'
}

case "$MODE" in
  --show)  show ;;
  --purge) purge ;;
  seed)
    echo "seeding synthetic records on $SERIAL"
    echo
    seed_sms
    echo
    seed_contacts
    echo
    echo "Seeded. Now in the lab app, grant Read SMS and Read Contacts and use the"
    echo "consent rows -- they read these records through the normal gated path."
    echo
    echo "  ./tools/lab/seed-synthetic.sh --show"
    echo "  ./tools/lab/reset.sh          # verify a clean teardown"
    ;;
  *) sed -n '20,26p' "$0"; exit 2 ;;
esac
