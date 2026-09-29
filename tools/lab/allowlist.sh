#!/usr/bin/env bash
#
# allowlist.sh — isolate the lab network (proposal sections 6 and 13).
#
# The point is not "block the internet". The point is that every observed
# connection is accounted for by construction, so proposal section 12's "no real
# personal data leaves the device" becomes provable from the capture rather than
# asserted.
#
# This prints and optionally applies the rules. It does not guess your interface
# names -- it shows you what it would do first.
#
#   ./tools/lab/allowlist.sh --show     print the rules, change nothing
#   ./tools/lab/allowlist.sh --apply    apply them (needs root)
#
set -euo pipefail

LAB_CIDR="${LAB_CIDR:-192.168.56.0/24}"     # the isolated lab subnet
SERVER_IP="${SERVER_IP:-192.168.56.1}"      # the host running the telemetry server
IFACE="${IFACE:-}"

MODE="${1:---show}"

cat <<EOF

Lab network isolation
=====================

Scope: $LAB_CIDR   server: $SERVER_IP

Rules
-----
  1. The lab subnet may reach the telemetry server and nothing else.
  2. The device may not resolve external DNS.
  3. All other outbound traffic from the lab subnet is dropped and logged.
  4. The host itself keeps its normal connectivity, so you can still read this.

Why 2 and 3 rather than a blanket block: if DNS is blocked but the route is not,
an app can still reach an IP literal. Both are required for the capture to mean
anything.

Before you apply
----------------
  - confirm the subnet above is genuinely isolated. If $LAB_CIDR is your
    office or home LAN, do not apply these rules.
  - confirm nothing you need runs on the lab subnet during the exercise.
  - take a snapshot, so you can undo this in one step.

EOF

if [ "$MODE" != "--apply" ]; then
  cat <<'EOF'
Not applying. Review the above, then re-run with --apply.

  sudo iptables-save > ~/lab-iptables.backup   # take a snapshot first
  sudo ./tools/lab/allowlist.sh --apply
  sudo iptables-restore < ~/lab-iptables.backup   # to undo

EOF
  exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "--apply needs root" >&2
  exit 1
fi
if [ -z "$IFACE" ]; then
  echo "Set IFACE to the lab interface, e.g. IFACE=virbr0" >&2
  exit 2
fi

# Validate before touching anything: a typo here could lock you out of your own
# machine, which during a demonstration is worse than no isolation at all.
if ! ip route show dev "$IFACE" >/dev/null 2>&1; then
  echo "IFACE=$IFACE does not exist. Nothing was changed." >&2
  exit 2
fi

echo "Applying isolation on $IFACE..."

# Allow the analyst host to keep working. Added first so a mistake does not
# disconnect the person running the exercise.
iptables -I INPUT -i "$IFACE" -j ACCEPT
iptables -I FORWARD -i "$IFACE" -o "$IFACE" -j ACCEPT

# DNS and external traffic out of the lab subnet.
iptables -I FORWARD -i "$IFACE" -d "$SERVER_IP" -j ACCEPT
iptables -I FORWARD -i "$IFACE" -p udp --dport 53 -j LOG --log-prefix "LAB-DNS-BLOCK "
iptables -I FORWARD -i "$IFACE" -p udp --dport 53 -j DROP
iptables -I FORWARD -i "$IFACE" -p tcp --dport 53 -j LOG --log-prefix "LAB-DNS-BLOCK "
iptables -I FORWARD -i "$IFACE" -p tcp --dport 53 -j DROP
iptables -I FORWARD -i "$IFACE" -j LOG --log-prefix "LAB-EGRESS-BLOCK "
iptables -I FORWARD -i "$IFACE" -j DROP

echo
echo "Applied. Blocked attempts are in the kernel log:"
echo "  sudo dmesg | grep LAB-"
echo
echo "Undo:"
echo "  sudo iptables-restore < ~/lab-iptables.backup"
