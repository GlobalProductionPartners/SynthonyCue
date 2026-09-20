#!/bin/bash
# Synthony Cue — OFFLINE field fix-up, run from the repo on a Mac that is ON the
# field network (10.10.10.x). In one pass it:
#   1. pushes the latest app code to the server,
#   2. sets EVERY Pi's clock + timezone from this Mac (the field net has no
#      internet/NTP and the Pis have no battery clock, so their time is wrong),
#   3. restarts the server app, and
#   4. reboots every display/remote so they come back with the new views AND the
#      correct time.
#
# You enter the Pi password ONCE, at the prompt. Needs `expect` (built in on macOS).
#
#   ./deploy/field-setup.sh
#
# Override the server if needed:  SERVER_IP=10.10.10.1 SERVER_USER=gpp-beaconserver-01 ./deploy/field-setup.sh
set -uo pipefail

SERVER_USER="${SERVER_USER:-gpp-beaconserver-01}"
SERVER_IP="${SERVER_IP:-10.10.10.1}"
LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="/home/${SERVER_USER}/synthony-cue-pi-1.0.6"

# The files that actually changed (served to the displays + the server itself).
FILES=(server.js public/cue-utils.js public/stage-cue.js public/kiosk.html public/index.html)

# This Mac is the time source (it has a battery RTC, so it stays right offline).
TZ_NAME="$(readlink /etc/localtime 2>/dev/null | sed 's|.*/zoneinfo/||')"; TZ_NAME="${TZ_NAME:-UTC}"

command -v expect >/dev/null 2>&1 || { echo "!! needs 'expect' (built in on macOS)"; exit 1; }
read -rs -p "Pi password: " PIPW; echo; export PIPW

# ── SSH helper: answers the login AND any sudo password prompt with PIPW ───────
EXP="$(mktemp)"; trap 'rm -f "$EXP"' EXIT
cat > "$EXP" <<'EXPEOF'
set timeout 200
set pw $env(PIPW)
spawn ssh -tt -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
          -o ConnectTimeout=10 -o PreferredAuthentications=password -o PubkeyAuthentication=no \
          [lindex $argv 0] [lindex $argv 1]
expect { -re {[Pp]assword:} { send -- "$pw\r"; exp_continue } timeout { exit 6 } eof }
EXPEOF
rr() { expect "$EXP" "$1" "$2"; }   # rr user@host "remote command"

# Fresh clock command (recomputed per Pi so each is accurate to the second).
clock_cmd() {
  echo "sudo timedatectl set-ntp false 2>/dev/null; sudo timedatectl set-timezone '$TZ_NAME' 2>/dev/null; sudo date -u -s '$(date -u '+%Y-%m-%d %H:%M:%S')' >/dev/null && echo '   clock set'"
}

echo "Time source: this Mac  ($(date '+%Y-%m-%d %H:%M:%S %Z'),  tz=$TZ_NAME)"
echo

echo "════ 1/4  Upload latest code → $SERVER_USER@$SERVER_IP ════"
for f in "${FILES[@]}"; do
  [ -f "$LOCAL_DIR/$f" ] || { echo "   (missing locally, skip: $f)"; continue; }
  b64="$(base64 < "$LOCAL_DIR/$f" | tr -d '\n')"
  rr "$SERVER_USER@$SERVER_IP" "echo $b64 | base64 -d > '$SERVER_DIR/$f'" >/dev/null 2>&1
  echo "   → pushed $f"
done

echo "════ 2/4  Server: set clock + restart app ════"
rr "$SERVER_USER@$SERVER_IP" "$(clock_cmd); node --check '$SERVER_DIR/server.js' && sudo systemctl restart synthony-cue && echo '   app restarted'" \
  | grep -E "clock set|app restarted|Error" || true
sleep 2
if curl -s --max-time 6 "http://$SERVER_IP:3001/cue-utils.js" 2>/dev/null | grep -q "function getHeldCue"; then
  echo "   ✓ new code is LIVE on the server"
else
  echo "   !! server not serving new code yet — its app dir may not be $SERVER_DIR"
fi

echo "════ 3/4  Find the beacons (from the server's DHCP leases) ════"
LEASES="$(rr "$SERVER_USER@$SERVER_IP" "sudo cat /var/lib/NetworkManager/dnsmasq-eth0.leases 2>/dev/null" 2>/dev/null | tr -d '\r')"
BEACONS=()
while read -r _ts _mac ip host _rest; do
  case "$host" in
    GPP-BEACON*)
      [ "$ip" = "$SERVER_IP" ] && continue
      user="$(printf '%s' "$host" | tr 'A-Z' 'a-z')"
      BEACONS+=("$user $ip")
      ;;
  esac
done <<< "$LEASES"
if [ "${#BEACONS[@]}" -eq 0 ]; then
  echo "   (no beacons found in leases — are they powered on and on the field net?)"
else
  echo "   found ${#BEACONS[@]}:"; for e in "${BEACONS[@]}"; do echo "      $e"; done
fi

echo "════ 4/4  Each beacon: set clock + reboot (picks up new views + time) ════"
for entry in "${BEACONS[@]}"; do
  set -- $entry; buser="$1"; bip="$2"
  printf '   → %-24s ' "$buser"
  rr "$buser@$bip" "$(clock_cmd); sudo -n reboot; echo '   rebooting'" >/dev/null 2>&1 \
    && echo "clock set + rebooting" || echo "unreachable (skipped)"
done

echo
echo "✓ Done. Beacons reboot (~40s) and return with the new views + correct time."
echo "  If a display still looks stale, power-cycle it once."
