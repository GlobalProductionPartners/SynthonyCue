#!/bin/bash
# Synthony Cue — OTA pull updater (runs on every Pi via systemd timer).
# Compares the local VERSION with the server's stored update bundle and,
# when they differ, downloads + extracts it over the install directory.
#
# Server Pi: the admin's "Apply" button updates the server directly — this
# script then no-ops because versions already match.
# Client Pi: picks up new deploy/kiosk/stats scripts; changes to systemd
# units or the kiosk take effect at next boot (kiosk pages always come
# fresh from the server anyway).

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="${HOME}/.synthony-update.log"
exec >>"$LOG" 2>&1

find_server() {
  if [ -n "${SYNTHONY_URL:-}" ]; then echo "$SYNTHONY_URL"; return 0; fi
  if curl -sf -o /dev/null --max-time 2 "http://localhost:3001/"; then echo "http://localhost:3001/"; return 0; fi
  command -v avahi-browse >/dev/null 2>&1 || return 1
  local hit
  hit=$(avahi-browse -rtp _synthony._tcp 2>/dev/null | awk -F';' '$1=="=" && $3=="IPv4" {print $8":"$9; exit}')
  [ -n "$hit" ] && { echo "http://$hit/"; return 0; }
  return 1
}

URL=$(find_server) || { echo "$(date +%T) no server — skip"; exit 0; }
LOCAL_V=$(cat "$DIR/VERSION" 2>/dev/null || echo none)
REMOTE_V=$(curl -sf --max-time 5 "${URL}api/update/status" | sed -n 's/.*"uploaded":{[^}]*"version":"\([^"]*\)".*/\1/p')
[ -z "$REMOTE_V" ] && { echo "$(date +%T) no update on server (local $LOCAL_V)"; exit 0; }
[ "$REMOTE_V" = "$LOCAL_V" ] && exit 0

echo "$(date +%T) updating: $LOCAL_V -> $REMOTE_V"
TMP=$(mktemp /tmp/synthony-update.XXXXXX.tar.gz)
curl -sf --max-time 120 -o "$TMP" "${URL}api/update/bundle" || { echo "download failed"; rm -f "$TMP"; exit 1; }
tar tzf "$TMP" | grep -q "/server.js$" || { echo "bad bundle"; rm -f "$TMP"; exit 1; }
tar xzf "$TMP" -C "$DIR" --strip-components=1 && echo "extracted $REMOTE_V into $DIR"
rm -f "$TMP"
chmod +x "$DIR"/deploy/*.sh 2>/dev/null || true
echo "$(date +%T) done — script/unit changes apply at next boot"
