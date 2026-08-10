#!/bin/bash
# Synthony Cue — one-shot installer for Raspberry Pi OS (64-bit, Pi 5).
#
#   cd ~/synthony-cue && ./deploy/install-pi.sh
#
# Installs system packages, node deps, a systemd unit for the server, and a
# desktop autostart entry that opens the display fullscreen. Safe to re-run.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="${SUDO_USER:-$USER}"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
DATA_DIR="/var/lib/synthony-cue"
SERVICE="/etc/systemd/system/synthony-cue.service"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || die "This installer is for Raspberry Pi OS. Use start-mac.command on macOS."
[ "$(id -u)" -ne 0 ] || die "Run as your normal user (it will call sudo where needed), not as root."

say "Installing for user '$RUN_USER' from $DIR"
echo "architecture: $(uname -m)"
if [ "$(uname -m)" != "aarch64" ]; then
  warn "Expected aarch64 (64-bit Pi OS). Continuing, but Node/native builds may differ."
fi

# ── System packages ───────────────────────────────────────────────────────────
say "Installing system packages"
sudo apt-get update
# ltc-tools provides ltcdump; alsa-utils provides arecord for LTC device listing.
# Both only matter if you use LTC — harmless to install regardless.
sudo apt-get install -y \
  curl ca-certificates \
  ffmpeg ltc-tools alsa-utils \
  chromium-browser || sudo apt-get install -y chromium

# ── Node.js ───────────────────────────────────────────────────────────────────
NEED_NODE=18
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
else
  NODE_MAJOR=0
fi
if [ "$NODE_MAJOR" -lt "$NEED_NODE" ]; then
  say "Installing Node.js 22 (found major version '$NODE_MAJOR', need >= $NEED_NODE)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  say "Node.js $(node -v) already present"
fi

# ── App dependencies ──────────────────────────────────────────────────────────
say "Installing node dependencies"
cd "$DIR"
# --omit=dev skips electron/electron-builder, which are not used on the Pi.
# Every runtime dependency is pure JavaScript, so nothing here compiles and no
# build toolchain is required.
npm install --omit=dev

# ── Data directory ────────────────────────────────────────────────────────────
say "Creating data directory $DATA_DIR"
sudo mkdir -p "$DATA_DIR/data"
sudo chown -R "$RUN_USER":"$RUN_USER" "$DATA_DIR"
# Seed config/songs from the checkout on first install only — never overwrite a
# live show's data on re-run.
[ -f "$DATA_DIR/config.json" ]      || { [ -f "$DIR/config.json" ]      && cp "$DIR/config.json"      "$DATA_DIR/config.json"; }
[ -f "$DATA_DIR/data/songs.json" ]  || { [ -f "$DIR/data/songs.json" ]  && cp "$DIR/data/songs.json"  "$DATA_DIR/data/songs.json"; }
sudo chown -R "$RUN_USER":"$RUN_USER" "$DATA_DIR"

# ── systemd service ───────────────────────────────────────────────────────────
say "Installing systemd service"
sed -e "s|__USER__|$RUN_USER|g" \
    -e "s|__DIR__|$DIR|g" \
    -e "s|__DATA_DIR__|$DATA_DIR|g" \
    "$DIR/deploy/synthony-cue.service" | sudo tee "$SERVICE" >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable synthony-cue
sudo systemctl restart synthony-cue

# ── Fullscreen kiosk autostart ────────────────────────────────────────────────
say "Installing fullscreen kiosk autostart"
chmod +x "$DIR/deploy/synthony-kiosk.sh"
install -d "$RUN_HOME/.config/autostart"
sed -e "s|__DIR__|$DIR|g" \
    "$DIR/deploy/synthony-kiosk.desktop" > "$RUN_HOME/.config/autostart/synthony-kiosk.desktop"
chown -R "$RUN_USER":"$RUN_USER" "$RUN_HOME/.config/autostart" 2>/dev/null || true

# ── Verify ────────────────────────────────────────────────────────────────────
say "Waiting for the server"
OK=0
for i in $(seq 1 30); do
  if curl -sf -o /dev/null --max-time 2 http://localhost:3001/; then OK=1; break; fi
  sleep 1
done

if [ "$OK" = "1" ]; then
  printf '\n\033[1;32m✓ Synthony Cue is running\033[0m\n'
else
  warn "Server did not answer on port 3001 yet. Check: journalctl -u synthony-cue -n 50"
fi

cat <<EOF

  Display (fullscreen)  http://localhost:3001/
  Admin                 http://$(hostname -I 2>/dev/null | awk '{print $1}'):3001/admin

  Service     sudo systemctl status synthony-cue
  Logs        journalctl -u synthony-cue -f
  Kiosk log   ~/.synthony-kiosk.log
  Data        $DATA_DIR

  The kiosk opens fullscreen at the next desktop login. To start it now:
    $DIR/deploy/synthony-kiosk.sh &

  Turn off screen blanking:  sudo raspi-config  ->  Display  ->  Screen Blanking  ->  No

EOF
