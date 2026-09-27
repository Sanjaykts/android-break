#!/usr/bin/env bash
#
# make-enroll-pdf.sh -- build the one-page-per-screen enrollment sheet.
#
# Produces tools/out/enroll.html, which you open in a browser and print to PDF.
# HTML rather than a generated PDF on purpose: it embeds the QR code and your real
# phone screenshots at whatever size they are, reflows if the content changes, and
# needs no tooling that might not be installed on the demo laptop.
#
#   ./tools/make-enroll-pdf.sh <apk url> [device name]
#
# The three {{SHOT_*}} placeholders are deliberately left visible and labelled.
# An empty gap in a printed instruction sheet reads as a mistake to whoever is
# holding the phone, so this refuses to call the output finished while they are
# unfilled.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/tools/out"
OUT="$OUT_DIR/enroll.html"
TEMPLATE="$ROOT/tools/enroll.template.html"
SHOTS="$OUT_DIR/shots"

URL="${1:-}"
DEVICE="${2:-your phone}"

if [ -z "$URL" ]; then
  cat >&2 <<'EOF'
usage: make-enroll-pdf.sh <apk download url> [device name]

  example:
    ./tools/make-enroll-pdf.sh \
      https://github.com/OWNER/REPO/releases/download/apk-latest/agent.apk \
      "Pixel 8, Android 15"
EOF
  exit 2
fi

case "$URL" in
  https://*) ;;
  *) echo "refusing to embed a non-https download URL: $URL" >&2; exit 2 ;;
esac

[ -f "$TEMPLATE" ] || { echo "missing template: $TEMPLATE" >&2; exit 1; }
mkdir -p "$OUT_DIR" "$SHOTS"

echo "generating $OUT"

# QR first, so the sheet never ships without a working code.
if ! "$ROOT/tools/make-qr.sh" "$URL" > /dev/null 2>&1; then
  echo "  note: no QR encoder available; install one with 'brew install qrencode'" >&2
  QR_PATH=""
  QR_BLOCK='<b>QR CODE MISSING</b><br>run tools/make-qr.sh to generate it'
else
  QR_PATH="apk-download.png"
  QR_BLOCK="<img src=\"$QR_PATH\" alt=\"QR code linking to the app download\" />"
  echo "  + QR code"
fi

python3 - "$TEMPLATE" "$OUT" "$URL" "$DEVICE" "$QR_PATH" "$QR_BLOCK" "$SHOTS" <<'PY'
import sys, pathlib

template, out, url, device, qr_path, qr_block, shots = sys.argv[1:8]
html = pathlib.Path(template).read_text()

html = html.replace("{{APK_URL}}", url)
html = html.replace("{{QR_IMAGE}}", "")
html = html.replace("{{QR_PATH}}", qr_path)
# Collapse the whole QR block when no encoder was available.
html = html.replace(
    '  <img src="%s" alt="QR code linking to the app download" />' % qr_path,
    qr_block,
)

# Substitute a real screenshot if one was captured, otherwise keep the loud
# placeholder so the gap cannot be shipped by accident.
shots_dir = pathlib.Path(shots)
mapping = {
    "{{SHOT_ACCESSIBILITY}}": "accessibility.png",
    "{{SHOT_CAPTURE}}": "capture.png",
    "{{SHOT_NOTIFICATIONS}}": "notifications.png",
}
for token, filename in mapping.items():
    path = shots_dir / filename
    if path.exists():
        html = html.replace(token, '<img src="shots/%s" alt="screenshot" />' % filename)
        print("  + %s" % filename)
    else:
        print("  ! missing shots/%s -- placeholder left in place" % filename)

html = html.replace("{{DEVICE}}", device)
pathlib.Path(out).write_text(html)

# Only claim the sheet is printable when it actually is. Telling someone to print
# a half-finished instruction sheet is worse than telling them nothing.
remaining = [t for t in mapping if t in html]
if remaining:
    print("\nNOT READY TO PRINT. Still to do:")
    for t in remaining:
        print("  - capture %s" % mapping[t])
    print("\n  Put the phone screenshots in %s/" % shots_dir)
    print("  (On the phone: take a screenshot, then pull it however you normally")
    print("   would -- this sheet is for the demo phone owner's own device.)")
    sys.exit(3)
print("\nReady to print.")
PY

echo
echo "Next:"
echo "  open '$OUT'          # then File > Print > Save as PDF"
echo
echo "  A4, portrait, margins 'Default', and tick 'Background graphics' so the"
echo "  step numbers and the callout bars actually print."
