#!/usr/bin/env bash
#
# make-qr.sh -- generate the APK download QR code for enroll.pdf.
#
# The APK is published to a *rolling* GitHub release, so this URL is a constant:
#
#   https://github.com/OWNER/REPO/releases/download/apk-latest/agent.apk
#
# It never needs regenerating when a new build ships. That is the entire reason
# the release is a rolling tag rather than a per-commit tag -- if the URL moved,
# every printed sheet and every laminated card would be dead.
#
#   ./tools/make-qr.sh https://github.com/OWNER/REPO/releases/download/apk-latest/agent.apk
#   ./tools/make-qr.sh --verify   # just check that the URL resolves

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/tools/out/apk-download.png"
URL="${1:-}"

if [ "${URL:-}" = "--verify" ]; then
  URL="${2:-}"
  [ -n "$URL" ] || { echo "usage: $0 --verify <url>" >&2; exit 2; }
fi

if [ -z "$URL" ]; then
  echo "usage: $0 <apk download url>" >&2
  echo "  expected shape: https://github.com/OWNER/REPO/releases/download/apk-latest/agent.apk" >&2
  exit 2
fi

case "$URL" in
  https://*) ;;
  *) echo "refusing to encode a non-https URL: $URL" >&2; exit 2 ;;
esac

if [ "${1:-}" = "--verify" ]; then
  echo "checking $URL"
  # -L because GitHub redirects asset downloads to a CDN.
  code=$(curl -sIL -o /dev/null -w '%{http_code}' --max-time 20 "$URL" || echo 000)
  size=$(curl -sIL --max-time 20 "$URL" 2>/dev/null \
    | tr -d '\r' | sed -n 's/^[Cc]ontent-[Ll]ength: *//p' | tail -1)
  echo "  HTTP $code"
  [ -n "$size" ] && echo "  $size bytes"
  if [ "$code" != "200" ]; then
    echo "  WARNING: the QR would encode a URL that does not resolve yet."
    echo "  The build workflow prints this URL when it publishes."
  else
    echo "  ok -- safe to print"
  fi
  exit 0
fi

mkdir -p "$(dirname "$OUT")"

# Prefer a local generator; fall back to the API so this works with no install.
if command -v qrencode >/dev/null 2>&1; then
  qrencode -o "$OUT" -s 12 -m 4 "$URL"
  echo "wrote $OUT (qrencode)"
elif python3 -c "import qrcode" 2>/dev/null; then
  python3 - "$URL" "$OUT" <<'PY'
import sys, qrcode
url, out = sys.argv[1], sys.argv[2]
img = qrcode.make(url, box_size=12, border=4)
img.save(out)
PY
  echo "wrote $OUT (python qrcode)"
else
  echo "No QR encoder available. Install one, then re-run:" >&2
  echo "  brew install qrencode" >&2
  echo "  # or: pip3 install 'qrcode[pil]'" >&2
  exit 1
fi

echo
echo "URL encoded:"
echo "  $URL"
echo
echo "Print this at least 25mm square. Test it with a second phone from the"
echo "distance a person will actually scan it from -- a QR code that needs a
squint is a QR code that fails on the day."
