# Synthony Cue — Raspberry Pi Setup

Live show cue system. The Pi runs the cue server and displays the show screen
fullscreen on a monitor, driven by **Art-Net timecode** from the lighting network.

Everything is in this folder. One script installs it.

---

## 1. What you need

| | |
|---|---|
| **Hardware** | Raspberry Pi 5 (4GB+), microSD card, monitor |
| **OS** | Raspberry Pi OS **64-bit** (Bookworm), Desktop version — not Lite, the display needs a desktop |
| **Network** | Pi on the **same network as the Art-Net timecode source** (see §5) |
| **Internet** | Needed during install only, to fetch packages |

Nothing else — no dongles, no audio interface. Art-Net timecode arrives over the network.

---

## 2. Install

**One tarball, two roles.** Exactly **one** Pi in the rig is the server;
every other Pi is a display-only client (no server, no Node — just the
kiosk browser and a stats reporter that find the server over the network).

Copy the same tarball to every Pi, then:

```bash
tar xzf synthony-cue-pi-*.tar.gz
cd synthony-cue-pi-*

./deploy/install-pi.sh server   # on THE one server Pi
./deploy/install-pi.sh client   # on every display Pi
```

Run with no argument and it asks. Re-running with `client` on a Pi that
used to be a server disables its server service.

Takes about 5–10 minutes, mostly package downloads. It will ask for your `sudo`
password. **Safe to run again** at any time — it never overwrites show data.

The installer:
- installs `ffmpeg`, `ltc-tools`, `alsa-utils`, Chromium
- installs Node.js 22 (only if yours is older than 18)
- installs the app's dependencies
- creates `/var/lib/synthony-cue` for show data
- registers the server as a service that starts on boot
- sets the show display to open fullscreen on login

When it finishes it prints a green `✓ Synthony Cue is running`.

---

## 3. First run

**Reboot.** The display should come up fullscreen by itself.

```bash
sudo reboot
```

To start the display without rebooting:

```bash
./deploy/synthony-kiosk.sh &
```

**Turn off screen blanking** or the monitor will sleep mid-show:

```
sudo raspi-config  →  Display Options  →  Screen Blanking  →  No
```

---

## 4. Everyday use

| What | Where |
|---|---|
| Show display | `http://localhost:3001/` — opens fullscreen automatically |
| Admin / editing | `http://<pi-ip>/admin` — from any machine on the network |
| Find the Pi's IP | `hostname -I` |

**Client Pis find the server by themselves.** The server advertises itself on
the network (mDNS), and the kiosk launcher browses for it — so display-only
Pis need **no IP configured anywhere** and survive DHCP handing out new
addresses. Priority: `SYNTHONY_URL` override → local server → discovery,
retrying every 5s until found.

**Screens name themselves.** Each display registers as `<hostname>-1`,
`<hostname>-2`, … so the admin's Connected Screens list reads as real
hardware ("stage-left-1"). Name the Pi accordingly (`raspi-config` →
Hostname).

**Dual displays:** one fullscreen kiosk opens per connected monitor. Window
placement needs X11 — on Pi OS Bookworm switch via `raspi-config` →
Advanced → Wayland → X11. Under Wayland only the first display gets a window
(logged in `~/.synthony-kiosk.log`).

**No port needed.** The server also listens on port 80, so `http://<pi-ip>/`
and `http://<hostname>.local/` work as-is. Give the server Pi a memorable
hostname (`sudo raspi-config` → System → Hostname, e.g. `GPP-Beaconserver-01`;
remotes `GPP-Beaconremote-01`, `-02`, …) and the admin is at
`http://<that-hostname>.local/admin`. The hostname is cosmetic — displays find
the server by mDNS service (`_synthony._tcp`), never by name, so you can rename
Pis freely.

Exit the fullscreen display with **Alt+F4**. It returns on next login.

```bash
sudo systemctl status synthony-cue     # is it running?
sudo systemctl restart synthony-cue    # restart it
journalctl -u synthony-cue -f          # live logs
```

The server runs as a service, so it starts on boot and restarts automatically
if it ever stops. You do not need to launch anything by hand.

---

## 5. Art-Net timecode — read this one

Timecode arrives as UDP **broadcast on port 6454**. Two things decide whether it works:

**Leave the interface set to "All Adapters."** In the admin page's timecode
settings, "All Adapters" accepts timecode from anywhere. Picking a specific
adapter turns on a source filter — if the timecode source is on a different
subnet, you will receive **nothing**, and the screen gives no clue why. Only
narrow this if you have a specific reason.

**The Pi must be on the same broadcast domain as the source.** Broadcast traffic
does not cross subnets or routers. Art-Net gear often lives on a `2.x.x.x` or
`10.x.x.x` network — check the Pi's address (`hostname -I`) is on that same
network, not on house wifi.

Confirm timecode is arriving:

```bash
journalctl -u synthony-cue -f | grep ArtNet
```

You should see a line ticking once per second:

```
[ArtNet TC] 15:24:36:00
[ArtNet TC] 15:24:37:00
```

If you see `Listening on 0.0.0.0:6454` but no ticking clock, timecode is not
reaching the Pi — that is a network problem, not an app problem. Check the two
points above first.

---

## 6. Video source (HDMI via encoder)

The Pi can show a live video source on a display, alongside the cue strip.

HDMI ingest is done by the **Zowietek 4K encoder**, not the Pi. The Pi pulls the
encoder's network stream. Point it at the encoder's **secondary 720p stream** —
the 4K main stream costs far more CPU to decode for no benefit on a cue display.

In the admin, under `// VIDEO / SOURCE`, set the stream URL:

```
rtsp://<encoder-ip>/stream1
```

Then switch a screen to the **Video** view (menu, or `?view=video` in the URL).

**Why the Pi re-encodes:** browsers cannot play RTSP, SRT or RTMP. The server
uses ffmpeg to convert the stream to MJPEG, which any Chromium plays with no
extra library — important because a show Pi has no internet to fetch one. HLS
was rejected: it adds 6-30 seconds of latency, which is useless live.

**Check the URL before a show.** Press **Test Source** in that panel. It probes
the stream and reports the actual codec and resolution, or the real error
(`No route to host`, `Timed out`). A blank display tells you nothing; this
tells you whether the encoder is reachable.

The transcode **only runs while a screen is actually showing the video view**,
so idle displays cost nothing.

Tune for your hardware in the same panel:

| Setting | Effect |
|---|---|
| Width | Output width. Lower = less CPU and bandwidth. 1280 default. |
| FPS | Frame rate. 15 is plenty for a monitor; 25 costs ~70% more. |
| Quality | ffmpeg `-q:v`, 2 (best) to 31 (worst). 6 is a good balance. |

**Test Pattern** in that panel points the pipeline at ffmpeg's built-in
generator, so you can commission a Pi before the encoder is on site.

Measured on a Mac at 960px / 12fps: **2.7 Mbps**. Expect the Pi to be the limit,
not the network — benchmark before committing to a frame rate.

## 7. Show data

Config and songs live in `/var/lib/synthony-cue`, deliberately **outside** this
folder, so reinstalling or updating can never overwrite a show.

```
/var/lib/synthony-cue/config.json        settings
/var/lib/synthony-cue/data/songs.json    songs and cues
```

Back up before a show: `cp -r /var/lib/synthony-cue ~/synthony-backup`

To update: replace this folder with the new version and re-run
`./deploy/install-pi.sh`. Your show data is untouched.

---

## 8. Troubleshooting

**Display doesn't open fullscreen**
Check `~/.synthony-kiosk.log` — it records which browser it found and how long
it waited for the server. Confirm `~/.config/autostart/synthony-kiosk.desktop`
exists. Make sure you are on Pi OS **Desktop**, not Lite.

**"Restore pages?" bar covering the screen**
Should not happen — the launcher clears Chromium's crash flag on every start.
If it does, the Pi is likely losing power uncleanly; shut down with
`sudo shutdown -h now` rather than pulling the plug.

**Server won't start**

```bash
journalctl -u synthony-cue -n 50
```

Check `node -v` is 18 or higher, and that `/var/lib/synthony-cue` is owned by
your user.

**No timecode** — see §5. Almost always the network, not the app.

**Video shows "Source unavailable"**
Press **Test Source** in the admin first — it names the actual fault. Failing
that, check the URL plays elsewhere: `ffplay rtsp://<encoder-ip>/stream1`.
Then `journalctl -u synthony-cue -f | grep Video`. The relay backs off
exponentially (1s to 30s) rather than hammering a dead encoder.

**Port 6454 already in use**
Another Art-Net app on the Pi may hold it. Broadcast reaches every listener so
sharing is usually fine, but unicast timecode goes to only one of them.

**OLED front panel blank**
The optional 0.91" 128x32 SSD1306 panel (I2C, address `0x3C`) is driven by
`synthony-oled.service`. It auto-detects role — the server shows its name +
connected screens, a client shows its screen name + online/searching — and
exits cleanly if no panel is wired. Check it:

```bash
systemctl status synthony-oled
journalctl -u synthony-oled -n 30
python3 deploy/oled/synthony_oled.py --dump /tmp/oled --role server   # render to PNGs
```

Confirm I2C is on (`sudo raspi-config nonint do_i2c 0`) and the panel shows on
`i2cdetect -y 1` at `3c`. The service is installed by `install-pi.sh`, so
**re-run the installer** after updating to pick it up (OTA delivers the script
but not new system services).

---

## 9. Timecode sources

| Source | Status on the Pi |
|---|---|
| **Art-Net** | **Supported.** This is what the Pi uses. |
| **LTC** (audio) | Code is in place and uses ALSA, but is untested on Pi and needs an audio input. Not needed for this setup. |

MTC and RTP-MIDI have been removed — the system is Art-Net only, with LTC
retained as a fallback. That also drops the `midi` native module, so the Pi
install no longer needs `build-essential` or `libasound2-dev`.

---

## 10. Reference

```
server.js                    the cue server
public/                      display and admin pages
tc/                          timecode receivers (artnet, ltc)
video/stream.js              encoder stream -> MJPEG relay
deploy/install-pi.sh         installer
deploy/synthony-kiosk.sh     fullscreen browser launcher
deploy/synthony-cue.service  systemd unit
deploy/oled/synthony_oled.py front-panel OLED status agent (both roles)
```

Server port `3001` (web) and `6454/udp` (Art-Net). Video is pulled outbound
from the encoder, so no extra inbound port is needed.
