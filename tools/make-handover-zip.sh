#!/usr/bin/env bash
#
# make-handover-zip.sh -- build a complete, self-contained handover package.
#
# The package is meant to be *usable*, not just readable. It contains:
#
#   apk/agent.apk          the built, signed, ready-to-install APK
#   DO-NOT-FORWARD/        the release signing key, so the recipient can sign
#   tools/out/             the QR code and enrollment sheet, already generated
#   everything tracked     full source, docs, tests, both platforms' scripts
#
# It strips only what genuinely cannot travel: dependency trees, build caches,
# and the two files holding absolute paths from the machine that built it.
#
#   ./tools/make-handover-zip.sh
#   ./tools/make-handover-zip.sh --no-secrets     # leave the signing key out
#   ./tools/make-handover-zip.sh --name my-team
#
# Read the inventory it prints before sending.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WITH_SECRETS=1
NAME_OVERRIDE=""

for arg in "$@"; do
  case "$arg" in
    --no-secrets) WITH_SECRETS=0 ;;
    --name=*) NAME_OVERRIDE="${arg#--name=}" ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

NAME="${NAME_OVERRIDE:-android-break-handover-$(date +%Y%m%d)}"
WORK="$(mktemp -d)"
STAGE="$WORK/$NAME"
mkdir -p "$STAGE"
trap 'rm -rf "$WORK"' EXIT

log() { printf "  %s\n" "$1"; }

echo "staging $NAME"

# ── 1. source, exactly what is committed ─────────────────────────────────────
# git archive is the cleanest possible source: no gitignored file can slip in.
cd "$ROOT"
git archive --format=tar HEAD | tar -x -C "$STAGE"
log "source: $(find "$STAGE" -type f | wc -l | tr -d ' ') tracked files"

# Strip what cannot travel, or that holds absolute paths from this machine.
rm -f  "$STAGE/agent/local.properties" \
       "$STAGE/agent/keystore.properties" \
       "$STAGE/relay/.dev.vars"
rm -rf "$STAGE/node_modules" "$STAGE/relay/node_modules" \
       "$STAGE/agent/build" "$STAGE/agent/app/build" \
       "$STAGE/agent/.gradle" "$STAGE/relay/.wrangler" \
       "$STAGE/.github"

# ── 2. the built APK ────────────────────────────────────────────────────────
mkdir -p "$STAGE/apk"
# Prefer the PUBLISHED release, not a local build. The QR code shipped in this
# package points at the rolling release URL, so the APK beside it has to be the
# same artifact or the two disagree. A local build is a fallback for when the
# network is unavailable.
APK_SRC=""
APK_FROM=""
URL="https://github.com/Sanjaykts/android-break/releases/download/apk-latest/agent.apk"
log "fetching the published release (the QR code in this package points here)..."
if curl -fsSL --max-time 120 -o "$STAGE/apk/agent.apk" "$URL"; then
  APK_SRC="$STAGE/apk/agent.apk"
  APK_FROM="published release"
else
  log "  could not reach GitHub, falling back to the local build"
  if [ -f "$ROOT/agent/app/build/outputs/apk/release/app-release.apk" ]; then
    cp "$ROOT/agent/app/build/outputs/apk/release/app-release.apk" "$STAGE/apk/agent.apk"
    APK_SRC="$STAGE/apk/agent.apk"
    APK_FROM="local build (MATCHES NOTHING the QR code points at)"
  fi
fi

if [ -n "$APK_SRC" ]; then
  [ "$APK_SRC" != "$STAGE/apk/agent.apk" ] && cp "$APK_SRC" "$STAGE/apk/agent.apk"
  SIZE=$(stat -f%z "$STAGE/apk/agent.apk" 2>/dev/null || stat -c%s "$STAGE/apk/agent.apk")
  log "apk source: $APK_FROM"
  SHA=$(shasum -a 256 "$STAGE/apk/agent.apk" | awk '{print $1}')
  log "apk: $SIZE bytes"

  # Verify the signature rather than trusting the filename. An unsigned or
  # debug-signed APK installs and then silently refuses to run.
  SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
  APKSIGNER="$SDK/build-tools/34.0.0/apksigner"
  if [ -x "$APKSIGNER" ]; then
    if "$APKSIGNER" verify "$STAGE/apk/agent.apk" >/dev/null 2>&1; then
      log "apk signature: VERIFIED"
      # Scheme lines only appear under -v; --print-certs does not emit them, and
      # reading them from the wrong command reports v1 for a v2-signed build.
      if "$APKSIGNER" verify -v "$STAGE/apk/agent.apk" 2>/dev/null \
           | grep -q "v2 scheme (APK Signature Scheme v2): true"; then
        log "apk scheme: v2 (installable on Android 7.0+)"
      else
        log "WARNING: APK is not v2-signed -- v1 only, so it will NOT install"
        log "         on Android 11+ where v1 signatures are rejected"
      fi
      "$APKSIGNER" verify --print-certs "$STAGE/apk/agent.apk" 2>/dev/null \
        | grep "SHA-256 digest" | head -1 | sed 's/^ */  signer /'
    else
      log "WARNING: the APK does NOT verify -- do not ship it"
    fi
  else
    log "note: apksigner not found, signature unverified"
  fi

  echo "$SHA  agent.apk" > "$STAGE/apk/SHA256SUMS.txt"
else
  log "WARNING: no APK in this package. Recipient must run the build."
fi

# ── 3. generated enrolment material ─────────────────────────────────────────
# The QR encodes a permanent URL, so it is correct today and does not need
# regenerating. The sheet has screenshot placeholders until the phone exists.
if [ -f "$ROOT/tools/out/apk-download.png" ]; then
  mkdir -p "$STAGE/tools/out"
  cp "$ROOT/tools/out/apk-download.png" "$STAGE/tools/out/"
  [ -f "$ROOT/tools/out/enroll.html" ] && cp "$ROOT/tools/out/enroll.html" "$STAGE/tools/out/"
  log "enrolment: QR code + sheet included"
fi

# ── 4. the signing key ──────────────────────────────────────────────────────
if [ "$WITH_SECRETS" -eq 1 ] && [ -f "$ROOT/agent/keystore.jks" ]; then
  mkdir -p "$STAGE/DO-NOT-FORWARD"
  cp "$ROOT/agent/keystore.jks" "$STAGE/DO-NOT-FORWARD/"
  cat > "$STAGE/DO-NOT-FORWARD/README.txt" <<'EOF'
DO NOT FORWARD THIS FOLDER
==========================

agent/keystore.jks is the release signing key for the Break Remote Android app.

  alias      agent-release
  passwords  Br34kR3mote!demo   (store and key)
  algorithm  RSA 4096, valid 30 years

Whoever holds this key can ship an update to any phone that has the app
installed. Treat it like a production credential.

Why it is in this package
-------------------------
So the recipient can produce a signed APK locally without waiting for CI. It is
NOT required for that -- CI signs every release from the KEYSTORE_BASE64 Actions
secret. If you would rather not have it, re-run the packaging script with
--no-secrets, or delete this folder.

Rules
-----
1. Never rotate or regenerate it. A new key is a different signing identity.
   Android refuses to install an update signed with a different key, so the
   phone owner would have to uninstall first, losing all enrolment settings and
   forcing the whole setup again.
2. Back it up privately and durably. It cannot be regenerated from GitHub.
3. Do not commit it, and do not send it onward.

To use it locally
-----------------
Create agent/keystore.properties (gitignored, and NOT included here because it
holds a machine-specific absolute path):

    KEYSTORE_PATH=<absolute path to agent/keystore.jks>
    KEYSTORE_PASSWORD=Br34kR3mote!demo
    KEY_ALIAS=agent-release
    KEY_PASSWORD=Br34kR3mote!demo

Then:  cd agent && gradlew.bat assembleRelease
EOF
  # keystore.properties is NOT copied: it holds an absolute path from this
  # machine. The README above tells the recipient how to write their own.
  log "secrets: signing key included in DO-NOT-FORWARD/"
else
  log "secrets: signing key EXCLUDED (CI signs from Actions)"
fi

# ── 5. the read-me ──────────────────────────────────────────────────────────
cat > "$STAGE/UNPACK-AND-READ-ME.txt" <<EOF
=========================================================================
  Break Remote -- handover package
  generated $(date '+%Y-%m-%d %H:%M %Z')
=========================================================================

1. READ HANDOVER.md FIRST. It is the entry point: the remaining steps, in
   order, and where every secret lives.

2. THE APK IS IN HERE, READY TO INSTALL
   Path:  apk/agent.apk
   Verify: shasum -a 256 -c apk/SHA256SUMS.txt      (macOS/Linux)
           certutil -hashfile apk\agent.apk SHA256  (Windows)
   You can sideload this straight onto a phone without building anything.

   #############################################################
   #  BUT READ THIS FIRST. THE APK IN HERE WILL NOT CONNECT.   #
   #############################################################

   The APK you are holding was compiled against a PLACEHOLDER relay address:

       wss://android-break-relay.example.workers.dev

   The relay is not deployed yet. Until you deploy it and rebuild, the app
   will install, grant all three permissions, start capture, and then sit
   showing "relay: retrying" forever with no useful error.

   So the order is:

       a) deploy the relay          (docs/DEPLOY.md section 1)
       b) set RELAY_URL and rebuild (docs/DEPLOY.md section 2)
       c) then the APK in this package works

   If you would rather not rebuild, install this one anyway and use it to
   check the enrolment flow. It exercises the permission UI completely --
   only the relay connection is missing.

3. WINDOWS
   Use the .cmd files, not the .sh files:

       .\\check-all.cmd          every automated check
       .\\demo-preflight.cmd     red/green pre-demo checks
       .\\demo-start.cmd         open the console fullscreen
       .\\demo-freeze.cmd        the final gate

   The .cmd files invoke PowerShell with -ExecutionPolicy Bypass, so a
   locked-down machine will not block them. Full setup: docs/SETUP.md

4. FIRST BUILD
   Nothing needs compiling to install the APK, but the test suites do need
   dependencies:

       cd relay
       npm install          (large: Puppeteer downloads a Chromium)

5. WHAT IS HERE
$(cd "$STAGE" && find . -type f | sed 's|^\./||' | sort | awk '{print "     "$0}')

6. IF YOU PREFER A GIT CLONE
       git clone https://github.com/Sanjaykts/android-break.git
   The repo is public. The clone has the same content, minus the built APK.
EOF

# ── 6. package ──────────────────────────────────────────────────────────────
OUT="$ROOT/$NAME.zip"
rm -f "$OUT" "$ROOT/$NAME.tar.gz"
if command -v zip >/dev/null 2>&1; then
  (cd "$WORK" && zip -qr "$OUT" "$NAME")
  ARCHIVE="$OUT"
else
  (cd "$WORK" && tar czf "$ROOT/$NAME.tar.gz" "$NAME")
  ARCHIVE="$ROOT/$NAME.tar.gz"
fi

echo
echo "wrote $ARCHIVE"
echo "  size:  $(du -h "$ARCHIVE" | cut -f1)"
echo "  files: $(find "$STAGE" -type f | wc -l | tr -d ' ')"
echo
echo "inventory:"
find "$STAGE" -maxdepth 2 -mindepth 1 -type d | sed "s|$STAGE|  |" | sort
echo
echo "BEFORE YOU SEND IT:"
echo "  1. read the placeholder-relay warning at the top of this output"
echo "  2. decide whether DO-NOT-FORWARD/ should travel at all"
echo "  3. tell the recipient to read HANDOVER.md first"
echo "  4. if they are on Windows, tell them to use the .cmd files"
