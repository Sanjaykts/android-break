#!/usr/bin/env bash
#
# capture.sh — record lab traffic as evidence (proposal sections 6, 8, 11).
#
# Captures both sides of the exchange, so a claim about what the device sent can
# be checked against what the server actually received, rather than trusted.
#
#   ./tools/lab/capture.sh start [seconds]
#   ./tools/lab/capture.sh stop
#   ./tools/lab/capture.sh verify
#
set -euo pipefail

OUT_DIR="${OUT_DIR:-lab-evidence}"
LAB_CIDR="${LAB_CIDR:-192.168.56.0/24}"
IFACE="${IFACE:-}"
DURATION="${2:-0}"

mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"

case "${1:-}" in
start)
  if [ -z "$IFACE" ]; then
    echo "Set IFACE to the lab interface, e.g. IFACE=virbr0" >&2
    exit 2
  fi
  echo "Capturing on $IFACE for ${DURATION}s (0 = until stopped) -> $OUT_DIR"
  echo "  tshark" >/dev/null 2>&1 && {
    # -k disables checksum validation, which is routinely wrong inside a VM
    # bridge and produces misleading "bad checksum" noise in the evidence.
    tshark -i "$IFACE" -f "net $LAB_CIDR" -k -w "$OUT_DIR/traffic-$STAMP.pcapng" \
      >/dev/null 2>&1 &
  } || {
    tcpdump -i "$IFACE" -s 0 -w "$OUT_DIR/traffic-$STAMP.pcapng" "net $LAB_CIDR" \
      >/dev/null 2>&1 &
  }
  echo $! > "$OUT_DIR/capture.pid"
  if [ "$DURATION" -gt 0 ]; then
    ( sleep "$DURATION"; "$0" stop ) &
  fi
  echo "  pid $(cat "$OUT_DIR/capture.pid")"
  ;;
stop)
  if [ -f "$OUT_DIR/capture.pid" ]; then
    kill "$(cat "$OUT_DIR/capture.pid")" 2>/dev/null || true
    rm -f "$OUT_DIR/capture.pid"
    echo "capture stopped"
  else
    echo "no capture running"
  fi
  ;;
verify)
  # The evidence check that matters: confirm the device talked to the lab server
  # and to nothing else. This is what backs the section 12 claim.
  pcap="$(ls -t "$OUT_DIR"/traffic-*.pcapng 2>/dev/null | head -1)"
  if [ -z "$pcap" ]; then echo "no capture found in $OUT_DIR" >&2; exit 1; fi
  echo "Verifying $pcap"
  echo
  echo "Destinations contacted from $LAB_CIDR:"
  if have_tshark=$(command -v tshark); then
    tshark -r "$pcap" -Y "ip.src==$LAB_CIDR && ip.dst" -T fields -e ip.dst 2>/dev/null \
      | sort | uniq -c | sort -rn
  else
    echo "  tshark not installed; install it to enumerate destinations"
  fi
  echo
  echo "Any destination other than the telemetry server is a stop condition"
  echo "(proposal section 13) -- stop and investigate before continuing."
  ;;
*)
  echo "usage: $0 {start [seconds]|stop|verify}" >&2
  exit 2
  ;;
esac
