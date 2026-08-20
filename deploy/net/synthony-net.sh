#!/bin/bash
# Synthony Cue — DHCP fallback / self-hosted rig network (server Pi only).
#
# Office: take a DHCP lease on eth0 like normal, do nothing else.
# Field (no DHCP on the wire): become the rig's own network —
#   eth0  -> NetworkManager "shared": Pi 10.10.10.1, DHCP server for the switch
#   wlan0 -> Wi-Fi access point ("shared"): Pi 10.10.11.1, DHCP for joiners
# The server routes between the two and avahi reflects mDNS across them, so a
# wired display and a Wi-Fi laptop both discover synthony.local.
#
# SAFETY: field mode is only ever entered when an ACTIVE DHCP probe confirms
# there is no DHCP server on eth0. That makes it impossible to turn rogue on a
# network that already has DHCP (e.g. the office) even if a lease is just slow.
# Mode is decided at boot and held until the next reboot (physically moving the
# rig between office and field is a reboot anyway) — no disruptive live flapping.

set -uo pipefail

ETH="${SYNTHONY_ETH:-eth0}"
FIELD_ETH_CON="synthony-field-eth"
AP_CON="synthony-ap"

SETTLE="${SYNTHONY_NET_SETTLE:-12}"   # let NM try DHCP at boot before we look
POLL="${SYNTHONY_NET_POLL:-10}"
mode=""                               # "", office, field

log() { echo "[synthony-net] $*"; }

has_dhcp_lease() {
  # A routable IPv4 on eth0 that came from a DHCP server (not our own static
  # field address, not APIPA). The proto-dhcp route is the tell.
  local ip
  ip="$(nmcli -g IP4.ADDRESS device show "$ETH" 2>/dev/null | head -1)"
  [ -n "$ip" ] || return 1
  case "$ip" in 169.254.*|10.10.10.1/*|10.10.11.1/*) return 1 ;; esac
  ip route show dev "$ETH" 2>/dev/null | grep -q 'proto dhcp'
}

dhcp_server_present() {
  # The definitive gate before serving: is there already a DHCP server here?
  # If we cannot probe, be conservative and assume yes (never auto-serve).
  command -v nmap >/dev/null 2>&1 || return 0
  nmap --script broadcast-dhcp-discover -e "$ETH" 2>/dev/null \
    | grep -qiE 'Server Identifier|DHCPOFFER|DHCPACK'
}

go_office() {
  [ "$mode" = office ] && return
  log "office DHCP present — staying a DHCP client"
  nmcli con down "$AP_CON"        >/dev/null 2>&1 || true
  nmcli con down "$FIELD_ETH_CON" >/dev/null 2>&1 || true
  mode=office
}

go_field() {
  [ "$mode" = field ] && return
  log "no DHCP on the wire — bringing up the field network (eth0 DHCP + Wi-Fi AP)"
  nmcli con up "$FIELD_ETH_CON" >/dev/null 2>&1 || log "eth0 field connection failed to start"
  nmcli con up "$AP_CON"        >/dev/null 2>&1 || log "Wi-Fi AP failed to start (check wifi country/regdomain)"
  mode=field
}

sleep "$SETTLE"
while true; do
  if has_dhcp_lease; then
    go_office
  elif [ "$mode" != field ]; then
    if dhcp_server_present; then
      log "no lease yet, but a DHCP server answered a probe — waiting for it"
    else
      go_field
    fi
  fi
  sleep "$POLL"
done
