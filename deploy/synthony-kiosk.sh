#!/bin/bash
# Synthony Cue — fullscreen kiosk launcher.
# Launched by the desktop session via ~/.config/autostart/synthony-kiosk.desktop.
#
# What it does, in order:
#   1. Finds the cue server: SYNTHONY_URL override → local server → mDNS
#      browse for _synthony._tcp, retrying forever. No IPs to configure.
#   2. Detects how many displays are connected.
#   3. Opens one fullscreen Chromium per display, each identifying itself to
#      the admin as "<hostname>-1", "<hostname>-2", …
#
# The same script therefore works on the server Pi (finds itself on
# localhost) and on client Pis (finds the server wherever DHCP put it).

set -uo pipefail

LOG="${HOME}/.synthony-kiosk.log"
exec >>"$LOG" 2>&1
echo "--- kiosk start $(date) ---"

HOSTNAME_SHORT="$(hostname -s 2>/dev/null || hostname)"

# ── Browser ───────────────────────────────────────────────────────────────────
BROWSER=""
for c in chromium-browser chromium; do
  command -v "$c" >/dev/null 2>&1 && { BROWSER="$c"; break; }
done
[ -z "$BROWSER" ] && { echo "No chromium found. sudo apt install -y chromium-browser"; exit 1; }
echo "browser: $BROWSER"

# ── Screen blanking off (X11 only; Wayland is configured via raspi-config) ───
if command -v xset >/dev/null 2>&1 && [ -n "${DISPLAY:-}" ]; then
  xset s off || true; xset -dpms || true; xset s noblank || true
fi

# ── 1. Find the server ───────────────────────────────────────────────────────
# Priority: explicit override → local server → mDNS discovery (retry forever).
find_server() {
  if [ -n "${SYNTHONY_URL:-}" ]; then
    echo "$SYNTHONY_URL"; return 0
  fi
  if curl -sf -o /dev/null --max-time 2 "http://localhost:3001/"; then
    echo "http://localhost:3001/"; return 0
  fi
  if command -v avahi-browse >/dev/null 2>&1; then
    # =;eth0;IPv4;Synthony Cue (pi5);_synthony._tcp;local;pi5.local;192.168.5.10;3001;
    local hit
    hit=$(avahi-browse -rtp _synthony._tcp 2>/dev/null | awk -F';' '$1=="=" && $3=="IPv4" {print $8":"$9; exit}')
    if [ -n "$hit" ]; then echo "http://$hit/"; return 0; fi
  fi
  return 1
}

URL=""
until URL=$(find_server); do
  echo "$(date +%T) no cue server yet — retrying in 5s (override with SYNTHONY_URL)"
  sleep 5
done
echo "server: $URL"

# Wait until it actually answers (mDNS can lead the HTTP listener slightly)
for i in $(seq 1 60); do
  curl -sf -o /dev/null --max-time 2 "$URL" && break
  sleep 2
done

# ── 1b. BEACONDISPLAY: force both HDMI outputs on, extended side-by-side ──────
# A BEACONDISPLAY Pi drives two HDMI screens; enable every HDMI output and lay
# them left-to-right so each gets its own fullscreen kiosk below. (X11 only —
# beacondisplay-setup.sh puts these Pis on X11 + forces the outputs in cmdline.)
case "$HOSTNAME_SHORT" in
  *[Bb]eacon[Dd]isplay*)
    if command -v xrandr >/dev/null 2>&1 && [ -n "${DISPLAY:-}" ]; then
      prev=""
      for out in $(xrandr 2>/dev/null | awk '/^HDMI/{print $1}'); do
        if [ -z "$prev" ]; then
          xrandr --output "$out" --auto --primary 2>/dev/null || true
        else
          xrandr --output "$out" --auto --right-of "$prev" 2>/dev/null || true
        fi
        prev="$out"
      done
      [ -n "$prev" ] && echo "BEACONDISPLAY: extended HDMI outputs" && sleep 1
    fi
    ;;
esac

# ── 2. Detect displays ───────────────────────────────────────────────────────
# X11: xrandr gives per-monitor geometry, so each window can be placed.
# Wayland (Pi OS default): windows can't be positioned by the app, so only
# display 1 gets a window — for dual-display kiosks switch the Pi to X11
# (raspi-config → Advanced → Wayland → X11). Logged loudly below.
MONITORS=()   # entries: "X,Y" window position per display
if command -v xrandr >/dev/null 2>&1 && [ -n "${DISPLAY:-}" ]; then
  while IFS= read -r geo; do
    MONITORS+=("$geo")
  done < <(xrandr --listmonitors 2>/dev/null | awk '/^ /{ if (match($0, /[0-9]+\/[0-9]+x[0-9]+\/[0-9]+\+[0-9]+\+[0-9]+/)) { g=substr($0, RSTART, RLENGTH); split(g, p, "+"); print p[2] "," p[3] } }')
fi
[ ${#MONITORS[@]} -eq 0 ] && MONITORS=("0,0")
echo "displays: ${#MONITORS[@]}"
if [ ${#MONITORS[@]} -eq 1 ] && command -v wlr-randr >/dev/null 2>&1; then
  N_OUT=$(wlr-randr 2>/dev/null | grep -c '^[A-Za-z]') || true
  [ "${N_OUT:-1}" -gt 1 ] && echo "NOTE: multiple outputs under Wayland — only one kiosk window can be placed. Switch to X11 (raspi-config → Advanced → Wayland) for per-display kiosks."
fi

# ── 3. Launch one kiosk per display ──────────────────────────────────────────
sep='?'; case "$URL" in *\?*) sep='&';; esac
PIDS=()
n=0
for pos in "${MONITORS[@]}"; do
  n=$((n+1))
  name="${HOSTNAME_SHORT}-${n}"
  # Separate profile per display: Chromium needs it to run two instances, and
  # it gives each screen its own saved view/localStorage as a bonus.
  profile="${HOME}/.config/synthony-kiosk-${n}"
  prefs="$profile/Default/Preferences"
  [ -f "$prefs" ] && sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/g' "$prefs" 2>/dev/null || true
  # Drop stale singleton locks: Chromium refuses to start if the lock encodes a
  # different hostname (e.g. after a rename) or a dead PID. Nothing else holds
  # this profile — each display gets its own — so clearing it is safe.
  rm -f "$profile"/Singleton* 2>/dev/null || true

  echo "display $n at $pos → $name"
  "$BROWSER" \
    --kiosk --start-fullscreen \
    --user-data-dir="$profile" \
    --window-position="${pos/,/,}" \
    --noerrdialogs --disable-infobars --disable-session-crashed-bubble \
    --disable-features=TranslateUI,Translate --disable-translate \
    --disable-pinch --overscroll-history-navigation=0 \
    --autoplay-policy=no-user-gesture-required \
    --check-for-update-interval=31536000 --password-store=basic \
    "${URL}${sep}name=${name}" &
  PIDS+=($!)
  sleep 1
done

wait "${PIDS[@]}"
