#!/bin/bash
# Synthony Cue — resource reporter for display-only Pis.
# Finds the cue server the same way the kiosk does (no configured IPs) and
# POSTs CPU / RAM / temperature / disk every 10 seconds so the admin's
# SYSTEM / RESOURCES panel shows every machine in the rig.
#
# On the server Pi this discovers localhost and goes dormant — the server
# reports its own machine natively.

set -uo pipefail

HOST="$(hostname -s 2>/dev/null || hostname)"
PREV_TOTAL=0; PREV_IDLE=0

find_server() {
  if [ -n "${SYNTHONY_URL:-}" ]; then echo "$SYNTHONY_URL"; return 0; fi
  if curl -sf -o /dev/null --max-time 2 "http://localhost:3001/"; then echo "LOCAL"; return 0; fi
  if command -v avahi-browse >/dev/null 2>&1; then
    local hit
    hit=$(avahi-browse -rtp _synthony._tcp 2>/dev/null | awk -F';' '$1=="=" && $3=="IPv4" {print $8":"$9; exit}')
    [ -n "$hit" ] && { echo "http://$hit/"; return 0; }
  fi
  return 1
}

cpu_pct() {
  # Delta over /proc/stat between calls — first call returns empty.
  read -r _ user nice system idle iowait irq softirq steal _ < /proc/stat
  local total=$((user + nice + system + idle + iowait + irq + softirq + steal))
  local didle=$((idle + iowait - PREV_IDLE)) dtotal=$((total - PREV_TOTAL))
  if [ "$PREV_TOTAL" -gt 0 ] && [ "$dtotal" -gt 0 ]; then
    echo $(( (100 * (dtotal - didle)) / dtotal ))
  fi
  PREV_IDLE=$((idle + iowait)); PREV_TOTAL=$total
}

while true; do
  URL=$(find_server) || { sleep 15; continue; }
  if [ "$URL" = "LOCAL" ]; then sleep 300; continue; fi   # server reports itself

  CPU=$(cpu_pct)
  LOAD=$(awk '{print $1}' /proc/loadavg 2>/dev/null)
  MEM_TOTAL=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo 2>/dev/null)
  MEM_AVAIL=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo 2>/dev/null)
  MEM_USED=$(( ${MEM_TOTAL:-0} - ${MEM_AVAIL:-0} ))
  TEMP=$(awk '{print int($1/1000)}' /sys/class/thermal/thermal_zone0/temp 2>/dev/null)
  read -r DISK_TOTAL DISK_FREE < <(df -Pk / 2>/dev/null | awk 'NR==2 {print int($2/1024), int($4/1024)}')
  UPTIME=$(awk '{print int($1)}' /proc/uptime 2>/dev/null)

  curl -sf -o /dev/null --max-time 4 -X POST -H 'Content-Type: application/json' \
    -d "{\"host\":\"$HOST\",\"cpu\":${CPU:-null},\"load\":${LOAD:-null},\"memUsedMB\":${MEM_USED:-null},\"memTotalMB\":${MEM_TOTAL:-null},\"temp\":${TEMP:-null},\"disk\":{\"freeMB\":${DISK_FREE:-null},\"totalMB\":${DISK_TOTAL:-null}},\"uptimeSec\":${UPTIME:-null}}" \
    "${URL}api/system/report" || true

  sleep 10
done
