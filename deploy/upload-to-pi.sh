#!/bin/bash
# Synthony Cue — push local app changes to a server Pi over the LAN.
#
# Offline-friendly: needs only network access to the Pi (no internet). It copies
# the running app files, restarts the service, and reloads every display so the
# browsers pick up new HTML/JS.
#
# Usage:
#   ./deploy/upload-to-pi.sh                 # default: gpp-beaconserver-01@10.10.10.1 (field)
#   ./deploy/upload-to-pi.sh gpp-beaconserver-01@synthony.local     # office
#   ./deploy/upload-to-pi.sh gpp-beaconserver-01@192.168.5.212      # office by IP
#
# You'll be asked for the Pi password once for the copy, and once more for the
# sudo restart. Set SYNTHONY_ADMIN_PW if the app's edit password isn't the
# default ("synthony") — only needed for the automatic display reload.
set -euo pipefail

TARGET="${1:-gpp-beaconserver-01@10.10.10.1}"
ADMIN_PW="${SYNTHONY_ADMIN_PW:-synthony}"
LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUSER="${TARGET%@*}"
REMOTE="/home/${RUSER}/synthony-cue-pi-1.0.6"

# One shared SSH connection for every step → the password is asked once.
# StrictHostKeyChecking is off because a field Pi is often re-imaged (new host
# key); this is a trusted LAN tool, not a public host.
CTRL="$HOME/.ssh/cm-synthony-%h-%p-%r"
mkdir -p "$HOME/.ssh"
SSHOPTS=(-o ControlMaster=auto -o ControlPath="$CTRL" -o ControlPersist=180
         -o PreferredAuthentications=password -o PubkeyAuthentication=no
         -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
         -o LogLevel=ERROR)

# The runtime app: the server, the served display/admin assets, and the engines.
PATHS=(server.js public tc output video)

say() { printf '\033[1;36m→ %s\033[0m\n' "$*"; }

say "Target: ${TARGET}:${REMOTE}"
ssh "${SSHOPTS[@]}" "$TARGET" "test -d '$REMOTE'" \
  || { echo "!! Remote app dir not found: $REMOTE  (is this the server Pi?)"; exit 1; }

EXISTING=(); for p in "${PATHS[@]}"; do [ -e "$LOCAL_DIR/$p" ] && EXISTING+=("$p"); done
say "Uploading: ${EXISTING[*]}"
# Stream a tarball over the one SSH connection and extract on the Pi — a single
# transfer that preserves the directory tree (more robust than per-file scp).
tar czf - -C "$LOCAL_DIR" "${EXISTING[@]}" \
  | ssh "${SSHOPTS[@]}" "$TARGET" "tar xzf - -C '$REMOTE' && echo '   ✓ files extracted'"

say "Syntax-checking + restarting the app (enter the sudo password if asked)…"
ssh -t "${SSHOPTS[@]}" "$TARGET" \
  "node --check '$REMOTE/server.js' && echo '   server.js OK' && sudo systemctl restart synthony-cue && sleep 2 && printf '   service: ' && systemctl is-active synthony-cue"

say "Reloading displays…"
ssh "${SSHOPTS[@]}" "$TARGET" "bash -s" <<REMOTE_EOF || true
J=\$(mktemp)
curl -s -c "\$J" -o /dev/null --max-time 5 -X POST http://127.0.0.1:3001/login --data-urlencode 'password=${ADMIN_PW}'
for h in \$(curl -s -b "\$J" --max-time 5 http://127.0.0.1:3001/api/system 2>/dev/null | python3 -c 'import sys,json;[print(x["host"]) for x in json.load(sys.stdin).get("remotes",[])]' 2>/dev/null); do
  curl -s -b "\$J" -X POST http://127.0.0.1:3001/api/system/restart -H 'Content-Type: application/json' -d "{\"action\":\"reload\",\"host\":\"\$h\"}" >/dev/null && echo "   ↻ \$h"
done
rm -f "\$J"
REMOTE_EOF

# Close the shared connection.
ssh "${SSHOPTS[@]}" -O exit "$TARGET" 2>/dev/null || true
printf '\033[1;32m✓ Done — displays will refresh with the new views.\033[0m\n'
