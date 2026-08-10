# Synthony Cue — Pi Hardware Test Checklist

Everything below is built and verified on macOS but **needs a pass on real
hardware**. Work top to bottom — later sections assume earlier ones passed.
Where a step can fail, the place to look is given.

Kit for a full pass: 1× Pi 5 (server), 1× Pi 4 (display client), a second
monitor, the Zowietek encoder, and a console sending Art-Net timecode.

---

## 1. Install (server Pi)

- [ ] `tar xzf synthony-cue-pi-*.tar.gz && cd synthony-cue-pi-* && ./deploy/install-pi.sh`
- [ ] Finishes with green `✓ Synthony Cue is running`
- [ ] `sudo systemctl status synthony-cue` → active (running)
- [ ] `sudo systemctl status synthony-stats` → active (running)
- [ ] Re-run the installer → completes, show data untouched
- [ ] `node -v` ≥ 18; **no compiler needed** — install must not build anything

## 2. Reachability

- [ ] `http://<pi-ip>:3001/` loads the display
- [ ] `http://<pi-ip>/` (no port) loads — needs `CAP_NET_BIND_SERVICE` from the unit
- [ ] Set hostname (`raspi-config` → Hostname, e.g. `synthony`), reboot
- [ ] `http://synthony.local/admin` works from a Mac/phone on the same network
- [ ] Login works; wrong password rejected

## 3. mDNS advertising

- [ ] From a Mac: `dns-sd -B _synthony._tcp local.` shows `Synthony Cue (<hostname>)`
- [ ] Stop the service → advert disappears within ~30s; start → returns

## 4. Kiosk — single display

- [ ] Reboot → Chromium opens fullscreen automatically, no tabs/bars
- [ ] Admin → Settings → Connected Screens shows **`<hostname>-1`**
- [ ] `~/.synthony-kiosk.log` shows `server: http://localhost:3001/`
- [ ] Mouse still → cursor hides (fullscreen video view); Escape opens the menu
- [ ] Screen blanking off survives reboot (`raspi-config` → Display → Screen Blanking → No)

## 5. Kiosk — dual display

- [ ] Switch to X11 first: `raspi-config` → Advanced → Wayland → X11, reboot
- [ ] Two fullscreen windows, one per monitor, correct positions
- [ ] Admin shows **`<hostname>-1` and `<hostname>-2`** as separate screens
- [ ] Each can be pushed a different view from Connected Screens → Send
- [ ] Under Wayland (if tried): only display 1 opens + NOTE line in kiosk log

## 6. Display-only client Pi

- [ ] Install the same bundle, then: `sudo systemctl disable --now synthony-cue`
      (a client must not find itself on localhost)
- [ ] Reboot → kiosk log shows discovery: `server: http://<server-ip>:3001/`
- [ ] Unplug/replug ethernet → reconnects by itself
- [ ] Reboot the **server** while client is up → client recovers without touch
- [ ] Change the server Pi's IP (different DHCP lease) → client still finds it
- [ ] `avahi-browse -rt _synthony._tcp` on the client lists the server
      (if empty: check `avahi-daemon` is running on both)

## 7. System resources panel

- [ ] Admin → Settings → `// SYSTEM / RESOURCES` shows the server row with
      CPU, RAM, **temperature** and disk (temp is null on Mac, must be real on Pi)
- [ ] Display-only Pi appears as a `DISPLAY` row within ~15s of boot
- [ ] On the server Pi `synthony-stats` goes dormant (no duplicate server row)
- [ ] Age column stays green (<25s); pull the client's network → row goes
      amber/red then disappears after ~2 min

## 8. Art-Net timecode

- [ ] Console → network → `[ArtNet TC]` ticking in `journalctl -u synthony-cue -f`
- [ ] Timecode runs on all displays, source badge shows ARTNET
- [ ] Interface picker: select the show NIC specifically → **still receives**
      (the old wildcard-bind bug — this is the regression test)
- [ ] Kill TC at the console → `SIGNAL-LOST` in flight log, displays show stopped
- [ ] Resume → `SIGNAL-RESUMED`, displays recover

## 9. Show control

- [ ] Push each view type to each screen from Connected Screens
- [ ] **Blackout** → every display black < 1s; reconnecting screen stays black;
      blackout off restores all
- [ ] **FIRE ▸** on a stage slot → cue appears as NOW on operator views,
      `MANUAL-FIRE` in flight log
- [ ] Unplug a display Pi → `SCREEN LOST` chip appears in admin topbar;
      replug → chip clears

## 10. Named shows + editor

- [ ] Save Show As… → appears in dropdown with song count
- [ ] Edit something, don't save → close tab → browser warns
- [ ] Load a show → every screen updates
- [ ] `data/songs.json.1`…`.5` rotate on saves (in `/var/lib/synthony-cue`)
- [ ] Pull power mid-save session, reboot → `songs.json` intact (atomic write)

## 11. Video (Zowietek)

- [ ] Settings → Video → **Test Pattern** → Video view shows moving pattern
- [ ] Enter the Zowietek's **substream** RTSP URL → **Test Source** reports
      codec/resolution (this validates the URL before committing a screen)
- [ ] Apply → Video view shows live picture; note latency (expect ~1s)
- [ ] `videofull` view: edge-to-edge, no chrome
- [ ] **Benchmark on the Pi**: with one viewer, watch CPU in the resources
      panel. Tune Width/FPS until comfortable (<60% CPU). Record the numbers.
- [ ] Stop watching (switch view) → transcode stops (`[Video] no viewers`)

## 12. Flight recorder

- [ ] `logs/show-<date>.log` in the data dir; events carry wall clock + show TC
- [ ] Contains: SCREEN-CONNECTED/LOST, FIRE entries, BLACKOUT, JAM, SHOW-SAVED

## 13. LTC (only if an audio interface is on the Pi)

- [ ] Settings → LTC → device list populates from `arecord -l` (`hw:1,0` style)
- [ ] Feed LTC → timecode locks; level meter moves

## 14. Update cycle

- [ ] Extract a new bundle over the old folder, re-run installer
- [ ] Show data, config, saved shows and logs all survive
- [ ] Services restart on the new code

---

## Known constraints (not bugs)

- Dual-display window placement requires **X11**, not Wayland
- `.local` names need mDNS on the *client* device; plain IP always works
- Blackout covers kiosk pages, not the admin (deliberate)
- The video transcode runs per-server, on demand, only while watched
