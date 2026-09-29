#!/usr/bin/env bash
#
# lab-up.sh — bring the isolated lab up on an analyst workstation.
#
# Proposal section 6. Works on Kali Linux, any Debian derivative, and macOS.
# Deliberately dependency-light: the analyst workstation may be a fresh VM with
# nothing on it, and a lab that needs a 2 GB toolchain cannot be stood up in the
# fifteen minutes before a demonstration.
#
#   ./tools/lab/lab-up.sh          set up
#   ./tools/lab/lab-up.sh --check  verify, change nothing
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODE="${1:-setup}"
ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILED=$((FAILED+1)); }
FAILED=0

have() { command -v "$1" >/dev/null 2>&1; }

printf '\033[1mLab bring-up\033[0m  (%s)\n\n' "$MODE"

# ── 1. host prerequisites ────────────────────────────────────────────────────
printf '\033[1m1. Host prerequisites\033[0m\n'
if have node; then
  v=$(node -v | sed 's/v//')
  ok "node $v"
  major=${v%%.*}
  [ "$major" -ge 22 ] 2>/dev/null || bad "node >= 22 required (found $v)"
else
  bad "node is not installed"
fi

if have npx; then ok "npx available"; else bad "npx is not installed"; fi

if have curl; then ok "curl available"; else bad "curl is not installed"; fi

# Optional: present on Kali, absent elsewhere. The lab works without them, so
# they are a warning rather than a failure.
for t in tcpdump tshark; do
  if have "$t"; then ok "$t available (traffic capture)"; else warn "$t not found -- install for packet-capture evidence (proposal section 11)"; fi
done

# ── 2. relay dependencies ─────────────────────────────────────────────────────
printf '\n\033[1m2. Relay server\033[0m\n'
if [ -d "$ROOT/relay/node_modules" ]; then
  ok "relay dependencies present"
else
  if [ "$MODE" = "check" ]; then
    bad "relay/node_modules missing -- run: cd relay && npm install"
  else
    warn "installing relay dependencies (large: Puppeteer downloads a browser)"
    (cd "$ROOT/relay" && npm install --silent) && ok "relay dependencies installed" \
      || bad "npm install failed"
  fi
fi

# ── 3. local secrets ──────────────────────────────────────────────────────────
printf '\n\033[1m3. Lab secrets\033[0m\n'
if [ -f "$ROOT/relay/.dev.vars" ]; then
  ok "relay/.dev.vars present"
  # The lab never uses the production tokens. Warn loudly if it looks like it.
  if grep -qE 'TOKEN="dev-' "$ROOT/relay/.dev.vars"; then
    ok "using development tokens (correct for a lab)"
  else
    warn ".dev.vars does not look like dev tokens. The lab should never run on production credentials."
  fi
else
  bad "relay/.dev.vars missing. Create it with lab-only tokens:
      cd relay
      python3 -c \"import secrets;print(secrets.token_urlsafe(32))\""
fi

# ── 4. network isolation ──────────────────────────────────────────────────────
printf '\n\033[1m4. Network isolation (proposal section 6)\033[0m\n'
if [ "$MODE" != "check" ]; then
  warn "isolation is enforced at the firewall or hypervisor level, not by this script."
  cat <<'EOF'
      Lab requirements:
        - the telemetry server and the device must be on an isolated network
        - outbound internet blocked for the device during the exercise
        - only the lab server address allowlisted
        - download any dependencies BEFORE the window, not during it

      See tools/lab/allowlist.sh for the concrete rules.
EOF
fi

# ── 5. the lab build ──────────────────────────────────────────────────────────
printf '\n\033[1m5. Lab app build\033[0m\n'
if [ -d "$ROOT/agent/labapp" ]; then
  ok "labapp module present"
  if [ -f "$ROOT/agent/labapp/build/outputs/apk/debug/labapp-debug.apk" ]; then
    ok "lab app already built"
  elif [ "$MODE" = "check" ]; then
    bad "lab app not built -- cd agent && ./gradlew :labapp:assembleDebug"
  else
    warn "building the lab app (first build downloads Gradle)"
    (cd "$ROOT/agent" && ./gradlew :labapp:assembleDebug -q) \
      && ok "lab app built" || bad "lab app build failed"
  fi
else
  bad "agent/labapp missing"
fi

# ── 6. permission policy ──────────────────────────────────────────────────────
printf '\n\033[1m6. Permission policy (proposal sections 5 and 10)\033[0m\n'
if [ -d "$ROOT/relay/node_modules" ] && [ -f "$ROOT/agent/labapp/build/outputs/apk/debug/labapp-debug.apk" ]; then
  if (cd "$ROOT/relay" && node tools/permission-policy.mjs >/dev/null 2>&1); then
    ok "lab app holds only its documented permissions"
  else
    bad "permission policy violated -- run: cd relay && node tools/permission-policy.mjs"
  fi
else
  warn "skipped: lab app not built"
fi

# ── 6b. training-target policy ────────────────────────────────────────────────
printf '\n\033[1m6b. Training-target policy (proposal section 10, D2-D5 and D7)\033[0m\n'
if [ -f "$ROOT/agent/toylab/build/outputs/apk/debug/toylab-debug.apk" ] && [ -d "$ROOT/relay/node_modules" ]; then
  if (cd "$ROOT/relay" && node tools/toy-policy.mjs >/dev/null 2>&1); then
    ok "each training flaw is present, and none can reach anything real"
  else
    bad "training-target policy violated -- run: cd relay && node tools/toy-policy.mjs"
  fi
else
  warn "skipped: training targets not built (./gradlew :toylab:assembleDebug)"
fi

printf '\n%s\n' "────────────────────────────────────────────────────────────────"
if [ "$FAILED" -gt 0 ]; then
  printf '\033[31m%d check(s) failed. The lab is not ready.\033[0m\n' "$FAILED"
  exit 1
fi
printf '\033[32mLab is ready.\033[0m Start the server with:\n  cd relay && npm run dev\n'
printf 'Then open the landing page on the device and the dashboard on this host.\n'
