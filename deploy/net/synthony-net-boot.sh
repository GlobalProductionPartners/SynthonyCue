#!/bin/bash
# Synthony Cue — automatic field-network decision, made ONCE at boot.
#
#   office (DHCP present):  eth0 gets a lease -> stay a normal DHCP client.
#   field  (no DHCP):       serve the rig's own network — eth0 = 10.10.10.1/24,
#                           NetworkManager "shared" runs a DHCP server on it.
#
# Why once-at-boot: the previous version re-checked continuously and, on a brief
# lease hiccup, flipped a WORKING office connection into serving DHCP on the
# office LAN (rogue). This decides a single time and exits, so it can never flip
# a live connection mid-session. To switch between office and field, reboot.
#
# Two independent checks must BOTH say "no DHCP here" before it ever serves:
#   1. no office DHCP lease within the wait window, and
#   2. an active probe finds no DHCP server answering on the wire.
# So it cannot turn rogue on a network that has DHCP, even a slow one.

set -uo pipefail

ETH="${SYNTHONY_ETH:-eth0}"
FIELD_CON="synthony-field-eth"
WAIT="${SYNTHONY_NET_WAIT:-50}"   # seconds to wait for an office DHCP lease

log() { echo "[synthony-net-boot] $*"; }

has_lease() {
  local ip
  ip="$(nmcli -g IP4.ADDRESS device show "$ETH" 2>/dev/null | head -1)"
  [ -n "$ip" ] || return 1
  case "$ip" in 169.254.*|10.10.10.1/*) return 1 ;; esac
  ip route show dev "$ETH" 2>/dev/null | grep -q 'proto dhcp'
}

dhcp_server_present() {
  # Active probe (eth0 is a plain/failed DHCP client here, not shared, so this
  # sees the wire fine). If we can't probe, assume a server IS present — the
  # conservative choice, since it prevents serving.
  command -v nmap >/dev/null 2>&1 || return 0
  nmap --script broadcast-dhcp-discover -e "$ETH" 2>/dev/null \
    | grep -qiE 'Server Identifier|DHCPOFFER|DHCPACK'
}

deadline=$(( $(date +%s) + WAIT ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if has_lease; then
    log "office DHCP lease present — staying a DHCP client"
    exit 0
  fi
  sleep 3
done

if dhcp_server_present; then
  log "no lease, but a DHCP server answered a probe — staying a DHCP client (not serving)"
  exit 0
fi

log "no DHCP on the wire — serving the field network on $ETH (10.10.10.1/24)"
nmcli con up "$FIELD_CON" || log "failed to bring up the field connection"
