#!/usr/bin/env bash
#
# One-time release key generation. See plan.md section 7.
#
#   ./tools/make-keystore.sh
#
# The resulting agent/keystore.jks is the release identity for this project. It is
# gitignored and must be backed up somewhere durable and private. NEVER regenerate
# or rotate it: a new key changes the APK signature, and Android will refuse to
# upgrade an installed app signed with the previous key -- the phone owner would
# have to uninstall first, which breaks the "upgrade in place" story.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KS="$ROOT/agent/keystore.jks"
PROPS="$ROOT/agent/keystore.properties"

if [ -f "$KS" ]; then
  echo "keystore already exists at $KS -- refusing to overwrite."
  echo "Rotating this key breaks in-place upgrades. See the note above."
  exit 1
fi

echo "Generating release keystore..."
keytool -genkeypair -v \
  -keystore "$KS" \
  -storetype PKCS12 \
  -keyalg RSA -keysize 4096 -validity 10950 \
  -alias agent-release \
  -storepass "${KEYSTORE_PASSWORD:?set KEYSTORE_PASSWORD}" \
  -keypass "${KEY_PASSWORD:?set KEY_PASSWORD}" \
  -dname "CN=Break Remote Agent, OU=Engineering, O=Break Remote, L=, ST=, C=US"

cat > "$PROPS" <<EOF
KEYSTORE_PATH=$KS
KEYSTORE_PASSWORD=$KEYSTORE_PASSWORD
KEY_ALIAS=agent-release
KEY_PASSWORD=$KEY_PASSWORD
EOF

chmod 600 "$KS" "$PROPS"
echo
echo "Wrote $KS and $PROPS (both gitignored)."
echo "Back the keystore up now, privately. Losing it means the next release cannot"
echo "be installed as an update on any phone that already has this app."
