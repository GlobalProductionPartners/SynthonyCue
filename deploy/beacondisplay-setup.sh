#!/bin/bash
# Synthony Cue — BEACONDISPLAY setup: force BOTH HDMI outputs and run under X11.
#
# A BEACONDISPLAY Pi drives two HDMI screens, each showing the kiosk fullscreen.
# Two things make that reliable on Pi OS:
#   1. Force both HDMI connectors on at 1080p even if a screen isn't asserting
#      hotplug/EDID (long cables, switchers, powered-on-later) — done in the KMS
#      kernel cmdline so it's independent of the desktop.
#   2. Run the desktop under X11, not Wayland: the kiosk places one fullscreen
#      window per output via xrandr, which Wayland doesn't allow.
# A reboot is required for both to take effect.
#
# Idempotent — safe to re-run.
set -uo pipefail

MODE="${SYNTHONY_HDMI_MODE:-1920x1080@60D}"   # override via env if a screen needs another mode

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }

CMDLINE=/boot/firmware/cmdline.txt
[ -f "$CMDLINE" ] || CMDLINE=/boot/cmdline.txt

say "Forcing both HDMI outputs ($MODE) via $CMDLINE"
if [ -f "$CMDLINE" ]; then
  line="$(tr -d '\n' < "$CMDLINE")"
  # Drop any previous forced HDMI video= we added, then append fresh ones.
  line="$(printf '%s' "$line" | sed -E 's/ *video=HDMI-A-[12]:[^ ]*//g')"
  line="$line video=HDMI-A-1:${MODE} video=HDMI-A-2:${MODE}"
  # collapse accidental double spaces
  line="$(printf '%s' "$line" | tr -s ' ')"
  printf '%s\n' "$line" | sudo tee "$CMDLINE" >/dev/null
  echo "cmdline: $line"
else
  warn "no cmdline.txt found — cannot force HDMI"
fi

say "Switching desktop session to X11 (needed for per-display kiosk windows)"
if command -v raspi-config >/dev/null 2>&1; then
  # W1 = X11/openbox backend on current Pi OS. Verify after reboot with:
  #   loginctl show-session ... -p Type   (want: x11)
  sudo raspi-config nonint do_wayland W1 2>/dev/null \
    && echo "session set to X11 (W1)" \
    || warn "could not set X11 via raspi-config — set it by hand (raspi-config → Advanced → Wayland → X11)"
else
  warn "raspi-config not found — switch to X11 by hand"
fi

echo
echo "BEACONDISPLAY configured. REBOOT to apply (forces 2x HDMI + X11 session)."
