#!/usr/bin/env bash
#
# make-handover-zip.sh -- package the project for handing to someone else.
#
# Run this instead of zipping the folder. It deliberately strips the files that
# will break somebody else's machine:
#
#   agent/local.properties      absolute macOS/Linux SDK path
#   agent/keystore.properties   absolute macOS/Linux keystore path
#   node_modules, build dirs    huge, and platform-specific
#   .gradle, .wrangler          machine state
#
# and it refuses to include the release keystore by default. The keystore is the
# release identity: whoever holds it can ship updates to the app. CI already has
# it (the KEYSTORE_BASE64 secret), so it is not needed to build.
#
#   ./tools/make-handover-zip.sh                 # excludes the keystore
#   ./tools/make-handover-zip.sh --with-keystore # only if the recipient needs it
#
# Tell the recipient to read HANDOVER.md first. If they are on Windows, also tell
# them not to run ./check-all.sh but .\check-all.cmd.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WITH_KEYSTORE=0
for arg in "$@"; do
  case "$arg" in
    --with-keystore) WITH_KEYSTORE=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

NAME="android-break-handover-$(date +%Y%m%d)"
STAGE="$(mktemp -d)/$NAME"
mkdir -p "$STAGE"
trap 'rm -rf "$(dirname "$STAGE")"' EXIT

echo "staging to $STAGE"

# git archive gives exactly the tracked files, which is the cleanest possible
# source: no gitignored file can slip in by accident.
cd "$ROOT"
git archive --format=tar HEAD | tar -x -C "$STAGE"

# Belt and braces. If this ever runs on a tree with no git history, remove them
# explicitly instead.
rm -f "$STAGE/agent/local.properties" \
      "$STAGE/agent/keystore.properties" \
      "$STAGE/relay/.dev.vars" \
      "$STAGE/relay/package-lock.json.bak"
rm -rf "$STAGE/node_modules" "$STAGE/relay/node_modules" \
       "$STAGE/agent/build" "$STAGE/agent/app/build" \
       "$STAGE/agent/.gradle" "$STAGE/relay/.wrangler" \
       "$STAGE/tools/out" "$STAGE/.github"

if [ "$WITH_KEYSTORE" -eq 0 ] && [ -f "$ROOT/agent/keystore.jks" ]; then
  echo "  excluding agent/keystore.jks (release signing key)"
  echo "  pass --with-keystore if the recipient genuinely needs it"
  echo "  the source of truth for CI is the KEYSTORE_BASE64 Actions secret"
fi

cat > "$STAGE/UNPACK-AND-READ-ME.txt" <<'EOF'
Break Remote -- handover package
================================

1. Read HANDOVER.md. It has the remaining steps, in order.

2. Prefer a git clone over this zip:
       git clone https://github.com/Sanjaykts/android-break.git
   The zip omits gitignored files, and the clone omits them too. If you use
   this zip instead, the two files that would have broken your build are
   already removed for you:
       agent/local.properties      (held a macOS SDK path)
       agent/keystore.properties   (held a macOS keystore path)

3. Windows? Use the .cmd files:
       .\check-all.cmd
       .\demo-preflight.cmd
       .\demo-start.cmd
       .\demo-freeze.cmd
   Not the .sh files. The .cmd files invoke PowerShell with
   -ExecutionPolicy Bypass, so a locked-down machine will not block them.

4. Environment setup: docs/SETUP.md

5. The release signing key (agent\keystore.jks) is NOT in this package by
   default. If you need to sign locally, ask for it, or let CI sign from the
   KEYSTORE_BASE64 secret. Whoever holds that key can ship updates to the app.
EOF

OUT="$ROOT/$NAME.zip"
rm -f "$OUT"
cd "$(dirname "$STAGE")"
zip -qr "$OUT" "$NAME" 2>/dev/null || {
  # No zip binary. tar is fine; Windows 11 can extract .tar.gz natively, and
  # 7-Zip handles it everywhere.
  OUT="$ROOT/$NAME.tar.gz"
  tar czf "$OUT" "$NAME"
}

echo
echo "wrote $OUT"
echo "  size:  $(du -h "$OUT" | cut -f1)"
echo "  files: $(find "$STAGE" -type f | wc -l | tr -d ' ')"
echo
echo "Before sending it:"
echo "  - confirm the keystore is NOT in it   (unzip -l \"$OUT\" | grep -i jks)"
echo "  - send it over a channel you trust; it contains source, not secrets,"
echo "    but the repo is public anyway so the source is not the concern"
echo "  - tell the recipient to read HANDOVER.md"
