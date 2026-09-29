#!/usr/bin/env bash
#
# seed-synthetic.sh -- stage synthetic records for the consent-gated read.
#
# ## What this actually does, and why
#
# The lab app's "Read synthetic SMS" / "Read synthetic contacts" rows exist to
# demonstrate one thing: that an app cannot read a content provider until the
# user grants it, and that the read fails before that. To show a *successful*
# consented read there has to be something in the provider to read.
#
# `SyntheticData.seedSms` / `seedContacts` try to insert directly. On a modern
# Android device that fails, and it is supposed to -- a non-default app cannot
# write another app's SMS or contacts. That refusal is the section 5 B2 lesson,
# and it is left visible rather than engineered around.
#
# So this stages the records from the host instead. Two mechanisms, and they do
# not have the same reach:
#
#   SMS       `adb emu sms send` -- the emulator's own radio console. It injects
#             through the radio, exactly like an incoming message, so the record
#             is a genuine inbox row and the app reads it over the ordinary
#             permission-gated path. Emulator only.
#
#   Contacts  NOT POSSIBLE on Android 11+. Neither the shell user nor a
#             non-default app may write the contacts provider; Android 14
#             answers with UnsupportedOperationException. Verified on API 34.
#             This script reports that rather than pretending, and the app falls
#             back to its visible in-app dataset.
#
# Nothing here bypasses a permission on the device. The app still has to be
# granted READ_SMS before it can read any of it.
#
#   ./tools/lab/seed-synthetic.sh           # stage
#   ./tools/lab/seed-synthetic.sh --show    # list what is there
#   ./tools/lab/seed-synthetic.sh --purge   # remove it
#
set -uo pipefail

MODE="${1:-seed}"
SERIAL="${ANDROID_SERIAL:-$(adb devices 2>/dev/null | awk '$2=="device"{print $1; exit}')}"

if ! command -v adb >/dev/null 2>&1; then
  cat <<'EOF'
adb is not available, so nothing was staged.

Without a host, let the app attempt the insert itself. It will be refused on any
modern Android device, and the refusal is the section 5 B2 lesson:

  - SyntheticData.seedSms / seedContacts try a ContentResolver insert
  - and fall back to a visible in-app dataset when the platform refuses

A host with adb lets you stage real inbox rows via the emulator radio, so the
consented read has something real to read.
EOF
  exit 2
fi
[ -z "$SERIAL" ] && { echo "no adb device connected" >&2; exit 2; }
sh_() { adb -s "$SERIAL" shell "$@"; }

# The app's marker is LABONLY-. The emulator radio console treats the first
# argument as a sender address, so the marker has to live in the body, and the
# sender has to look like a phone number or the console splits it oddly
# (observed: "LABONLY-001" arrived as "001").
BODIES=(
  "Lab test message: enrollment confirmed for session."
  "Lab test message: synthetic appointment at 14:00, room B."
  "Lab test message: do not action. This record is test data only."
  "Lab test message: permission prompt screenshot pending."
  "Lab test message: relay handshake acknowledged."
  "Lab test message: end of synthetic dataset."
)

seed_sms() {
  echo "  SMS -- via the emulator radio console"
  local i=1
  for b in "${BODIES[@]}"; do
    # $(( )) arithmetic is fine here; this is host-side, not device-side.
    local sender
    sender=$(printf "+155501%02d" "$i")
    if adb -s "$SERIAL" emu sms send "$sender" "LABONLY- $b" >/dev/null 2>&1; then
      printf '    %s  LABONLY- %s\n' "$sender" "${b:0:44}"
    else
      printf '    %s  FAILED to stage\n' "$sender"
    fi
    i=$((i + 1))
  done
}

seed_contacts() {
  echo
  echo "  Contacts -- NOT possible, and this is the platform working correctly"
  local err
  err=$(sh_ "content insert --user 0 --uri content://com.android.contacts/rawContacts --bind account_type:s:local" 2>&1)
  if printf '%s' "$err" | grep -qi "unsupportedoperation\|securityexception\|permission"; then
    echo "    confirmed on this device: the contacts provider refuses the writer"
    printf '    %s\n' "$(printf '%s' "$err" | head -2 | tr -d '\r' | head -1)"
  else
    echo "    this device accepted the insert; verify with --show"
  fi
  echo
  echo "    A non-default app cannot write contacts on Android 11+, and the shell"
  echo "    user cannot either. So the app's contact row demonstrates the refusal"
  echo "    and its visible in-app dataset instead. If the demonstration needs real"
  echo "    provider rows, the lab app has to be the default contacts handler --"
  echo "    a role the user grants on purpose, which is itself worth showing."
}

show() {
  echo "  SMS rows containing LABONLY-:"
  sh_ "content query --user 0 --uri content://sms/inbox --projection address:body" 2>/dev/null \
    | tr ',' '\n' | grep -i labonly | sed 's/^/    /' || echo "    (none)"
  echo
  echo "  Contacts containing LABONLY:"
  sh_ "content query --user 0 --uri content://contacts/contacts --projection display_name" 2>/dev/null \
    | tr -d '\r' | grep -i labonly | sed 's/^/    /' || echo "    (none -- expected; see above)"
}

purge() {
  echo "  removing staged SMS"
  # No supported host-side delete on Android 11+; uninstall the messaging app's
  # data or wipe the emulator. The reset script documents the verified route.
  local n
  n=$(sh_ "content query --user 0 --uri content://sms/inbox --projection body" 2>/dev/null \
      | tr ',' '\n' | grep -ci labonly)
  if [ "${n:-0}" -gt 0 ]; then
    echo "    $n LABONLY- rows present; the provider exposes no host-side delete"
    echo "    wipe the emulator to clear them, or uninstall the default SMS app"
  else
    echo "    none present"
  fi
}

case "$MODE" in
  --show)  show ;;
  --purge) purge ;;
  seed)
    echo "staging synthetic records on $SERIAL"
    echo
    seed_sms
    seed_contacts
    echo
    echo "  Next: in the lab app, grant Read SMS and use the consent row."
    echo "  It reads these inbox rows through the normal gated path."
    ;;
  *) sed -n '28,32p' "$0"; exit 2 ;;
esac
