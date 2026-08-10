#!/bin/bash
# Synthony Cue — fullscreen kiosk browser.
# Launched by the desktop session via ~/.config/autostart/synthony-kiosk.desktop.
# Waits for the server to answer, then opens the display page in Chromium kiosk mode.

set -uo pipefail

URL="${SYNTHONY_URL:-http://localhost:3001/}"
LOG="${HOME}/.synthony-kiosk.log"

exec >>"$LOG" 2>&1
echo "--- kiosk start $(date) ---"

# Chromium is 'chromium-browser' on older Pi OS and 'chromium' on Bookworm+
BROWSER=""
for c in chromium-browser chromium; do
  if command -v "$c" >/dev/null 2>&1; then BROWSER="$c"; break; fi
done
if [ -z "$BROWSER" ]; then
  echo "No chromium found. Install with: sudo apt install -y chromium-browser"
  exit 1
fi
echo "browser: $BROWSER"

# Stop the screen blanking mid-show. xset only exists under X11; under Wayland
# this is a no-op and the setting comes from raspi-config instead.
if command -v xset >/dev/null 2>&1 && [ -n "${DISPLAY:-}" ]; then
  xset s off || true
  xset -dpms || true
  xset s noblank || true
fi

# Wait for the server. Restart=always means it may still be coming up.
for i in $(seq 1 60); do
  if curl -sf -o /dev/null --max-time 2 "$URL"; then
    echo "server up after ${i} attempt(s)"
    break
  fi
  sleep 2
done

# Chromium shows a "restore pages?" bar if the Pi was powered off uncleanly,
# which would sit on top of the show. Clear the crash flag before launching.
for prefs in "$HOME/.config/chromium/Default/Preferences" \
             "$HOME/snap/chromium/current/.config/chromium/Default/Preferences"; do
  if [ -f "$prefs" ]; then
    sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/g' "$prefs" || true
  fi
done

exec "$BROWSER" \
  --kiosk \
  --start-fullscreen \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-features=TranslateUI,Translate \
  --disable-translate \
  --disable-pinch \
  --overscroll-history-navigation=0 \
  --autoplay-policy=no-user-gesture-required \
  --check-for-update-interval=31536000 \
  --password-store=basic \
  "$URL"
