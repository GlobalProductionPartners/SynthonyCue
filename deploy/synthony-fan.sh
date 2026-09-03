#!/bin/bash
# Synthony Cue — quieter fan curve for the Beacon Pi 4 enclosures.
#
# The enclosure fan (PoE-HAT / pwm-fan) ships with trip points 40/45/50/55°C,
# so it slams to 100% the instant the Pi passes 55°C — and a Pi driving a
# fullscreen Chromium kiosk idles right there, so it runs flat-out (and loud)
# for no reason while sitting on tons of thermal headroom.
#
# The kernel exposes the trip-point temperatures as writable sysfs files, so we
# simply shift the whole curve up: near-silent below 50°C, gentle to ~68°C, and
# full speed only when the Pi is genuinely hot (~75°C, well before the 80–85°C
# throttle point). A oneshot systemd unit re-applies this at every boot because
# the writes don't persist (config.txt fan_temp params don't reach this fan).
set -u

Z=/sys/class/thermal/thermal_zone0
# Only act on a zone that actually exposes the 4-tier fan trips we expect. This
# keeps the script a no-op on anything else (e.g. a Pi 5 server, different fan).
[ -w "$Z/trip_point_0_temp" ] && [ -w "$Z/trip_point_3_temp" ] || {
  echo "synthony-fan: no writable fan trips at $Z — nothing to do"; exit 0; }

# trip_point_0 is the hottest trip (→ max fan); _3 is the coolest (→ fan first
# spins). Write hottest-first so the descending-sorted list stays valid at every
# step regardless of the current values.
echo 75000 > "$Z/trip_point_0_temp"   # max fan
echo 68000 > "$Z/trip_point_1_temp"
echo 62000 > "$Z/trip_point_2_temp"
echo 50000 > "$Z/trip_point_3_temp"   # fan first spins (lowest, quiet tier)

echo "synthony-fan: curve set to 50/62/68/75°C (was 40/45/50/55)"
