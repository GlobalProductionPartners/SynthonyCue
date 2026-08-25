#!/bin/bash
# Synthony Cue — one-shot installer for Raspberry Pi OS (64-bit).
#
# ONE bundle, TWO roles — exactly ONE Pi in the rig runs the server:
#
#   ./deploy/install-pi.sh server    the one cue server (+ can drive displays)
#   ./deploy/install-pi.sh client    display-only: kiosk + stats, NO server,
#                                    no Node — finds the server over mDNS
#
# Run with no argument and it asks. Safe to re-run; converting a Pi from
# server to client disables its server service.

set -euo pipefail

MODE="${1:-}"
if [ "$MODE" != "server" ] && [ "$MODE" != "client" ]; then
  echo "Install role:"
  echo "  1) server — THE cue server for the rig (only one of these)"
  echo "  2) client — display only (kiosk + stats agent, no server)"
  read -rp "Choose [1/2]: " pick
  case "$pick" in
    1) MODE=server ;;
    2) MODE=client ;;
    *) echo "Pick 1 or 2."; exit 1 ;;
  esac
fi

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

say "Installing role: $MODE — for user '$RUN_USER' from $DIR"
echo "architecture: $(uname -m)"
if [ "$(uname -m)" != "aarch64" ]; then
  warn "Expected aarch64 (64-bit Pi OS). Continuing, but Node/native builds may differ."
fi

# ── System packages ───────────────────────────────────────────────────────────
say "Installing system packages"
sudo apt-get update
# apt transactions are all-or-nothing, so chromium (whose package name
# varies by distro) is installed separately — it must never take the core
# packages down with it.
if [ "$MODE" = "server" ]; then
  # Core server needs: discovery + video relay. Hard requirement.
  sudo apt-get install -y curl ca-certificates avahi-utils ffmpeg
  # LTC decode is a fallback TC source — best-effort only. Debian trixie has
  # dropped ltc-tools from the archive; Art-Net timecode is unaffected.
  sudo apt-get install -y ltc-tools alsa-utils \
    || warn "ltc-tools/alsa-utils unavailable on this OS — LTC timecode disabled (Art-Net unaffected)"
  # Cue Readout: server speaks cues out this Pi's audio via espeak-ng. Optional —
  # if it's missing the server readout just stays silent (browser readout still works).
  sudo apt-get install -y espeak-ng \
    || warn "espeak-ng unavailable — server-side Cue Readout disabled (browser readout unaffected)"
else
  # A client is just a browser + discovery + the bash stats agent.
  sudo apt-get install -y curl ca-certificates avahi-utils
  # Cue Readout in the browser needs voices; Chromium on Pi OS has none until
  # speech-dispatcher + espeak are present. Best-effort — a non-caller display
  # doesn't need it.
  sudo apt-get install -y speech-dispatcher espeak-ng \
    || warn "speech-dispatcher/espeak-ng unavailable — browser Cue Readout on this Pi will have no voice"
fi
sudo apt-get install -y chromium-browser 2>/dev/null || sudo apt-get install -y chromium

# Front-panel OLED status display (both roles). Harmless on a Pi with no panel —
# the agent exits cleanly when it can't open the I2C device. Needs luma.oled +
# Pillow to draw and websocket-client for the live cue link.
say "Installing OLED status-panel dependencies"
sudo apt-get install -y i2c-tools python3-luma.oled python3-pil python3-websocket \
  || warn "OLED deps unavailable — front-panel status display will be limited/disabled"
# Enable the I2C bus the panel hangs off. No-op if it's already on.
sudo raspi-config nonint do_i2c 0 2>/dev/null || true

# ── Server-only: Node.js, app deps, data dir, server service ─────────────────
if [ "$MODE" = "server" ]; then

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

# ── Field network: automatic DHCP fallback, decided once at boot (server) ────
# In the field (no DHCP) this Pi serves DHCP itself on eth0 (NetworkManager
# "shared", 10.10.10.1/24) for the whole switch — a bridged Wi-Fi AP's clients
# land here too. The decision is made ONCE at boot: if an office DHCP lease
# arrives it stays a client; if not (and a probe confirms no DHCP server), it
# serves the field network. It never re-checks while running, so it can't flip
# a live connection mid-session. `sudo synthony-field on|off` overrides by hand.
say "Setting up field network (automatic DHCP fallback at boot)"
# NM "shared" needs its dnsmasq backend; nmap gives the pre-serve DHCP probe.
sudo apt-get install -y dnsmasq-base nmap \
  || warn "dnsmasq-base/nmap unavailable — field fallback may not work"

# Define the field connection, autoconnect OFF so NM never activates it on its
# own — only the boot decision or the manual toggle bring it up. Idempotent.
sudo nmcli con delete synthony-field-eth >/dev/null 2>&1 || true
sudo nmcli con add type ethernet ifname eth0 con-name synthony-field-eth \
  ipv4.method shared ipv4.addresses 10.10.10.1/24 \
  connection.autoconnect no >/dev/null 2>&1 || warn "could not create eth0 field connection"

# Manual override command on PATH.
chmod +x "$DIR/deploy/net/synthony-field"
sudo ln -sf "$DIR/deploy/net/synthony-field" /usr/local/bin/synthony-field

# Boot-time decision (oneshot — never re-evaluates while running).
chmod +x "$DIR/deploy/net/synthony-net-boot.sh"
sed -e "s|__DIR__|$DIR|g" \
    "$DIR/deploy/net/synthony-net-boot.service" | sudo tee /etc/systemd/system/synthony-net-boot.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable synthony-net-boot

# ── Legacy synthony.local alias (server role) ───────────────────────────────
# Keep http://synthony.local reachable after the Beacon hostname rename.
say "Publishing legacy synthony.local mDNS alias"
chmod +x "$DIR/deploy/synthony-alias.sh"
sed -e "s|__DIR__|$DIR|g" \
    "$DIR/deploy/synthony-alias.service" | sudo tee /etc/systemd/system/synthony-alias.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable synthony-alias
sudo systemctl restart synthony-alias

else
  # Client role: this Pi must NOT run a server — the kiosk checks localhost
  # first, so a stray local server would hijack the display away from the
  # real one. Disable it if a previous install left it here.
  if systemctl list-unit-files synthony-cue.service >/dev/null 2>&1 && \
     systemctl is-enabled synthony-cue >/dev/null 2>&1; then
    say "Client role: disabling local server service"
    sudo systemctl disable --now synthony-cue || true
  fi
fi

# ── Resource reporter (both roles; dormant on the server Pi) ────────────────
say "Installing resource reporter"
chmod +x "$DIR/deploy/synthony-stats.sh"
sed -e "s|__USER__|$RUN_USER|g" -e "s|__DIR__|$DIR|g" \
    "$DIR/deploy/synthony-stats.service" | sudo tee /etc/systemd/system/synthony-stats.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable synthony-stats
sudo systemctl restart synthony-stats

# ── Front-panel OLED status display (both roles) ────────────────────────────
say "Installing OLED status display"
# Retire the hand-rolled predecessor if it's still around — two processes on one
# I2C panel just fight over it.
sudo systemctl disable --now oled-status.service 2>/dev/null || true
chmod +x "$DIR/deploy/oled/synthony_oled.py"
sed -e "s|__USER__|$RUN_USER|g" -e "s|__DIR__|$DIR|g" \
    "$DIR/deploy/synthony-oled.service" | sudo tee /etc/systemd/system/synthony-oled.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable synthony-oled
sudo systemctl restart synthony-oled

# ── Allow the app to reboot this Pi (reboot only, nothing else) ──────────────
say "Granting reboot permission (reboot only)"
echo "$RUN_USER ALL=(ALL) NOPASSWD: /sbin/reboot, /usr/sbin/reboot" \
  | sudo tee /etc/sudoers.d/synthony-reboot >/dev/null
sudo chmod 440 /etc/sudoers.d/synthony-reboot

# ── OTA updater (both roles) ──────────────────────────────────────────────────
say "Installing OTA updater"
chmod +x "$DIR/deploy/synthony-update.sh"
sed -e "s|__USER__|$RUN_USER|g" -e "s|__DIR__|$DIR|g" \
    "$DIR/deploy/synthony-update.service" | sudo tee /etc/systemd/system/synthony-update.service >/dev/null
sudo cp "$DIR/deploy/synthony-update.timer" /etc/systemd/system/synthony-update.timer
sudo systemctl daemon-reload
sudo systemctl enable --now synthony-update.timer

# ── Fullscreen kiosk autostart ────────────────────────────────────────────────
say "Installing fullscreen kiosk autostart"
chmod +x "$DIR/deploy/synthony-kiosk.sh"
install -d "$RUN_HOME/.config/autostart"
sed -e "s|__DIR__|$DIR|g" \
    "$DIR/deploy/synthony-kiosk.desktop" > "$RUN_HOME/.config/autostart/synthony-kiosk.desktop"
chown -R "$RUN_USER":"$RUN_USER" "$RUN_HOME/.config/autostart" 2>/dev/null || true

# ── Verify ────────────────────────────────────────────────────────────────────
if [ "$MODE" = "server" ]; then
  say "Waiting for the server"
  OK=0
  for i in $(seq 1 30); do
    if curl -sf -o /dev/null --max-time 2 http://localhost:3001/; then OK=1; break; fi
    sleep 1
  done
  if [ "$OK" = "1" ]; then
    printf '\n\033[1;32m✓ Synthony Cue SERVER is running\033[0m\n'
  else
    warn "Server did not answer on port 3001 yet. Check: journalctl -u synthony-cue -n 50"
  fi
  cat <<EOF

  Display (fullscreen)  http://localhost:3001/
  Admin                 http://$(hostname -I 2>/dev/null | awk '{print $1}')/admin
  Data                  $DATA_DIR
  Service               sudo systemctl status synthony-cue
  Logs                  journalctl -u synthony-cue -f
  Kiosk log             ~/.synthony-kiosk.log

  Clients on this network will find this server automatically (mDNS).
  Remember: only ONE server Pi per rig.

  The kiosk opens fullscreen at next login. Start now:
    $DIR/deploy/synthony-kiosk.sh &

  Screen blanking off:  sudo raspi-config -> Display -> Screen Blanking -> No

EOF
else
  say "Checking for a cue server on the network"
  FOUND=$(avahi-browse -rtp _synthony._tcp 2>/dev/null | awk -F';' '$1=="=" && $3=="IPv4" {print $8":"$9; exit}')
  if [ -n "$FOUND" ]; then
    printf '\n\033[1;32m✓ CLIENT installed — found cue server at %s\033[0m\n' "$FOUND"
  else
    warn "No cue server visible yet — the kiosk will keep looking every 5s."
  fi
  cat <<EOF

  This Pi is DISPLAY-ONLY: no server, no Node.
  It finds the cue server by itself and registers as $(hostname -s)-1 (,-2 per display).

  Kiosk log   ~/.synthony-kiosk.log
  Stats       sudo systemctl status synthony-stats

  The kiosk opens fullscreen at next login. Start now:
    $DIR/deploy/synthony-kiosk.sh &

  Screen blanking off:  sudo raspi-config -> Display -> Screen Blanking -> No

EOF
fi
