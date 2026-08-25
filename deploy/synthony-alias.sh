#!/bin/bash
# Publish a legacy "synthony.local" mDNS alias pointing at this server's current
# IP, so old bookmarks / muscle memory keep working after the Beacon hostname
# rename. avahi-publish holds the record while it runs; Restart=always + a fresh
# run on every boot means it follows the IP across office<->field.
set -uo pipefail

# Wait for an address (at boot the network may not be up yet).
for _ in $(seq 1 30); do
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [ -n "$ip" ] && break
  sleep 2
done
[ -n "${ip:-}" ] || { echo "no IP available"; exit 1; }

echo "publishing synthony.local -> $ip"
exec avahi-publish -a -R synthony.local "$ip"
