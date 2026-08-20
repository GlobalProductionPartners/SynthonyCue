#!/usr/bin/env python3
"""Synthony Cue — front-panel OLED status display (0.91" 128x32 SSD1306, I2C).

One script, two roles. It auto-detects whether the Pi it runs on is the cue
SERVER (runs the Node app) or a display CLIENT (kiosk only) and shows the right
thing:

  SERVER   identity → boot → ONLINE · SERVER name · IP · SCREENS+CUE · CPU/RAM/TEMP
  CLIENT   identity → search → ONLINE/SEARCHING · SCREEN name · IP · CPU/RAM/TEMP

System info (CPU/RAM/temp/IP) is read locally, so the panel is useful before the
cue link is up. The screen count, cue state and a client's own screen name come
from the Synthony Cue server over the same WebSocket the browsers use — a client
learns its name by matching its own IP against the server's connected-screens
list. A change in the screen count interrupts the rotation immediately.

Graceful by design: no OLED wired → clean exit (nothing to drive); no
websocket-client installed or no server found → still shows local system info.

Test without hardware:
    synthony_oled.py --dump OUT_DIR --role server   # renders panels to PNGs
"""

import argparse
import json
import os
import signal
import socket
import subprocess
import threading
import time
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

try:
    import websocket  # websocket-client
except ImportError:
    # The panel is more useful showing an IP with no cue data than not starting
    # at all, so a missing websocket-client is not fatal.
    websocket = None

# --- hardware / layout ------------------------------------------------------

I2C_ADDRESS = int(os.environ.get("SYNTHONY_OLED_ADDR", "0x3C"), 16)
I2C_PORT = int(os.environ.get("SYNTHONY_OLED_PORT", "1"))
WIDTH = 128
HEIGHT = 32

# Units that must be active before the SERVER boot screen clears. A CLIENT waits
# for the cue link instead (it has no local server unit to watch).
READY_UNITS = ("synthony-cue.service",)
READY_POLL_SECONDS = 1.0
BOOT_TIMEOUT = 120.0  # show the rotation anyway rather than hang on booting

IDENTITY_SECONDS = 2.5
BANNER_SECONDS = 2.5
FLASH_SECONDS = 1.8
FLASH_GAP = 0.15  # brief blank between panels, which is what makes it flash

ALERT_SECONDS = 2.5
ALERT_BLINKS = 3
ALERT_ON = 0.35
ALERT_OFF = 0.2

SCROLL_STEP = 1     # pixels per frame; 1 is the smoothest the panel can do
SCROLL_GAP = 32
# A steady per-frame pace, not "as fast as possible". At 0 the scroll speed rode
# on however fast the I2C bus and a busy CPU happened to be that instant, which
# reads as jitter; a fixed ~50 px/s cadence keeps the motion even.
FRAME_DELAY = 0.02

FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
BANNER_SIZE = 24
BOOT_SIZE = 20
LABEL_SIZE = 11
# Tried largest first; the widest that fits the panel wins.
VALUE_SIZES = (18, 16, 14, 12, 10)

LABEL_BAND = 13     # rows reserved for the label, the value gets the rest
COLUMN_PADDING = 4  # breathing room either side of a value in a split panel

IDENTITY_SIZES = (16, 14, 12, 10)
IDENTITY_LEADING = 2  # blank rows between the two words

DUMP_SCALE = 6  # upscale factor for --dump PNGs (128x32 is tiny to eyeball)

# --- fonts ------------------------------------------------------------------


@lru_cache(maxsize=None)
def load_font(size):
    try:
        return ImageFont.truetype(FONT_PATH, size)
    except OSError:
        return ImageFont.load_default()


def measure(font, text):
    """Return (width, height, x_offset, y_offset) for accurate placement."""
    left, top, right, bottom = font.getbbox(text)
    return right - left, bottom - top, left, top


def fit_font(text, sizes, max_width):
    """Largest font from sizes whose rendering of text fits max_width."""
    for size in sizes:
        font = load_font(size)
        if measure(font, text)[0] <= max_width:
            return font
    return load_font(sizes[-1])


# --- Synthony Cue link ------------------------------------------------------

_alert = threading.Event()
_cue_lock = threading.Lock()
_cue = {
    "screens": None,     # browser/screen entries, or None when the link is down
    "clients": None,     # display Pis actually up + reporting (server-computed)
    "running": False,
    "tc": "--:--:--:--",
    "alert": None,
    "link": False,       # is the websocket currently connected?
    "screen_name": None,  # this Pi's own screen name (client role), by IP match
}


def _raise_alert(label):
    _cue["alert"] = label  # caller holds the lock
    _alert.set()


def _local_ips():
    """Every non-loopback IPv4 this Pi holds — used to match our screen entry."""
    ips = set()
    try:
        out = subprocess.run(
            ["hostname", "-I"], capture_output=True, text=True, timeout=2
        ).stdout.split()
        ips.update(a for a in out if ":" not in a and not a.startswith("127."))
    except (OSError, subprocess.SubprocessError):
        pass
    ip = local_ip()
    if ip:
        ips.add(ip)
    return ips


def _cue_on_message(ws, raw):
    """Fold a cue message into shared state. Never draws.

    tc messages arrive 25-30 times a second and the panel redraws on its own
    schedule, so this only ever updates state.
    """
    try:
        message = json.loads(raw)
    except (TypeError, ValueError):
        return

    kind = message.get("type")
    with _cue_lock:
        if kind == "screens_list":
            screens = message.get("screens", [])
            # Entries, not machines: a dual-head Pi reports two, and so does a
            # second browser tab. That is what the server calls a screen.
            count = len(screens)
            previous = _cue["screens"]
            _cue["screens"] = count
            if previous is not None and count != previous:
                _raise_alert(
                    "SCREEN LOST" if count < previous else "SCREEN JOINED"
                )
            # A client learns its own name by matching its IP to a screen entry.
            mine = _local_ips()
            for entry in screens:
                if entry.get("ip") in mine and entry.get("name"):
                    _cue["screen_name"] = entry["name"]
                    break
        elif kind == "tc_transport":
            _cue["running"] = message.get("running", False)
            _cue["tc"] = message.get("tc", _cue["tc"])
        elif kind == "tc":
            _cue["tc"] = message.get("tc", _cue["tc"])
        elif kind == "clients":
            _cue["clients"] = message.get("count")


def _cue_on_open(ws):
    with _cue_lock:
        _cue["link"] = True


def _cue_disconnected(*args):
    with _cue_lock:
        if _cue["screens"] is not None:
            _raise_alert("CUE LINK DOWN")
        _cue["screens"] = None
        _cue["clients"] = None
        _cue["running"] = False
        _cue["link"] = False


def _cue_worker(url):
    while True:
        try:
            websocket.WebSocketApp(
                url,
                on_open=_cue_on_open,
                on_message=_cue_on_message,
                on_close=_cue_disconnected,
                on_error=_cue_disconnected,
            ).run_forever()
        except Exception:
            _cue_disconnected()
        time.sleep(3)


def start_cue_client(url):
    if websocket is None or not url:
        return
    threading.Thread(target=_cue_worker, args=(url,), daemon=True).start()


def cue_state():
    with _cue_lock:
        return dict(_cue)


def take_alert():
    """Consume the pending alert label, if any."""
    _alert.clear()
    with _cue_lock:
        label, _cue["alert"] = _cue["alert"], None
    return label


def dwell(seconds):
    """Hold a panel, cutting it short if an alert needs the screen."""
    return _alert.wait(seconds)


# --- server discovery -------------------------------------------------------


def _http_ok(url):
    try:
        return subprocess.run(
            ["curl", "-sf", "-o", "/dev/null", "--max-time", "2", url],
            timeout=4,
        ).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def detect_role():
    env = os.environ.get("SYNTHONY_OLED_ROLE", "").strip().lower()
    if env in ("server", "client"):
        return env
    # The server Pi runs the Node app; a client only has the kiosk.
    if unit_active("synthony-cue.service") or _http_ok("http://127.0.0.1:3001/"):
        return "server"
    return "client"


def discover_server_ws():
    """Browse mDNS for the cue server the same way the kiosk does."""
    try:
        out = subprocess.run(
            ["avahi-browse", "-rtp", "_synthony._tcp"],
            capture_output=True, text=True, timeout=6,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    for line in out.splitlines():
        parts = line.split(";")
        # =;iface;IPv4;name;_synthony._tcp;local;host;ip;port;txt
        if len(parts) >= 9 and parts[0] == "=" and parts[2] == "IPv4":
            return f"ws://{parts[7]}:{parts[8]}/"
    return None


def cue_urls(role):
    """Ordered websocket URLs to try; the first that connects wins and sticks."""
    if role == "server":
        return ["ws://127.0.0.1:3001/", "ws://127.0.0.1/"]
    found = discover_server_ws()
    urls = [found] if found else []
    urls += ["ws://synthony.local:3001/", "ws://synthony.local/"]
    # de-dupe, keep order
    seen, out = set(), []
    for u in urls:
        if u and u not in seen:
            seen.add(u)
            out.append(u)
    return out


# --- system readings --------------------------------------------------------


def local_ip():
    """Best-effort local IP address, or None.

    The UDP trick asks the kernel which interface would reach the outside world;
    no packets are sent. It fails on isolated show LANs with no default route, so
    fall back to asking the system for every non-loopback address it holds.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("192.0.2.1", 1))  # TEST-NET-1, never actually routed
        return sock.getsockname()[0]
    except OSError:
        pass
    finally:
        sock.close()

    try:
        out = subprocess.run(
            ["hostname", "-I"], capture_output=True, text=True, timeout=2
        ).stdout.split()
    except (OSError, subprocess.SubprocessError):
        return None
    for addr in out:
        if ":" not in addr and not addr.startswith("127."):
            return addr
    return None


def host_name():
    try:
        return socket.gethostname().replace(".local", "")
    except OSError:
        return "pi"


def _cpu_times():
    with open("/proc/stat") as fh:
        values = [int(v) for v in fh.readline().split()[1:]]
    return sum(values), values[3] + values[4]  # total, idle + iowait


def cpu_percent(interval=0.4):
    total_before, idle_before = _cpu_times()
    time.sleep(interval)
    total_after, idle_after = _cpu_times()
    elapsed = total_after - total_before
    if elapsed <= 0:
        return 0.0
    return (1 - (idle_after - idle_before) / elapsed) * 100


def ram_percent():
    info = {}
    with open("/proc/meminfo") as fh:
        for line in fh:
            key, _, rest = line.partition(":")
            info[key] = int(rest.split()[0])
    total = info.get("MemTotal", 0)
    if not total:
        return 0.0
    return (1 - info.get("MemAvailable", total) / total) * 100


def cpu_temp():
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as fh:
            return int(fh.read().strip()) / 1000.0
    except (OSError, ValueError):
        return None


def unit_active(name):
    try:
        return subprocess.run(
            ["systemctl", "is-active", "--quiet", name], timeout=5
        ).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def system_ready(role):
    if role == "server":
        return all(unit_active(name) for name in READY_UNITS)
    # A client is "ready" once it has found the server (link up) — or, failing
    # that, once it at least has a network address to show.
    return cue_state()["link"] or local_ip() is not None


# --- names ------------------------------------------------------------------


def server_name():
    return host_name()


def screen_name():
    return cue_state()["screen_name"] or host_name()


# --- drawing ----------------------------------------------------------------


def show_identity(device, lines, seconds):
    """Two words stacked and centred — the boot splash."""
    frame = Image.new("1", (WIDTH, HEIGHT))
    draw = ImageDraw.Draw(frame)

    font = fit_font(max(lines, key=len), IDENTITY_SIZES, WIDTH)
    heights = [measure(font, line)[1] for line in lines]
    block = sum(heights) + IDENTITY_LEADING * (len(lines) - 1)
    y = (HEIGHT - block) // 2

    for line, height in zip(lines, heights):
        w, _, ox, oy = measure(font, line)
        draw.text(((WIDTH - w) // 2 - ox, y - oy), line, font=font, fill=255)
        y += height + IDENTITY_LEADING

    device.display(frame)
    time.sleep(seconds)


def show_banner(device, text, seconds):
    font = load_font(BANNER_SIZE)
    w, h, ox, oy = measure(font, text)
    frame = Image.new("1", (WIDTH, HEIGHT))
    ImageDraw.Draw(frame).text(
        ((WIDTH - w) // 2 - ox, (HEIGHT - h) // 2 - oy), text, font=font, fill=255
    )
    device.display(frame)
    dwell(seconds)


def show_pair(device, label, value, seconds):
    """Label on the top row, value filling the space below it."""
    frame = Image.new("1", (WIDTH, HEIGHT))
    draw = ImageDraw.Draw(frame)

    label_font = load_font(LABEL_SIZE)
    value_font = fit_font(value, VALUE_SIZES, WIDTH)

    lw, _, lox, loy = measure(label_font, label)
    draw.text(((WIDTH - lw) // 2 - lox, -loy), label, font=label_font, fill=255)

    vw, vh, vox, voy = measure(value_font, value)
    draw.text(
        (
            (WIDTH - vw) // 2 - vox,
            LABEL_BAND + (HEIGHT - LABEL_BAND - vh) // 2 - voy,
        ),
        value, font=value_font, fill=255,
    )
    device.display(frame)
    dwell(seconds)


def show_columns(device, items, seconds):
    """Several label/value pairs side by side, divided by hairlines."""
    frame = Image.new("1", (WIDTH, HEIGHT))
    draw = ImageDraw.Draw(frame)

    label_font = load_font(LABEL_SIZE)
    column = WIDTH // len(items)

    for index, (label, value) in enumerate(items):
        x = index * column
        value_font = fit_font(value, VALUE_SIZES, column - COLUMN_PADDING)

        lw, _, lox, loy = measure(label_font, label)
        draw.text((x + (column - lw) // 2 - lox, -loy),
                  label, font=label_font, fill=255)

        vw, vh, vox, voy = measure(value_font, value)
        draw.text(
            (
                x + (column - vw) // 2 - vox,
                LABEL_BAND + (HEIGHT - LABEL_BAND - vh) // 2 - voy,
            ),
            value, font=value_font, fill=255,
        )

    for index in range(1, len(items)):
        draw.line([(index * column, 3), (index * column, HEIGHT - 4)], fill=255)

    device.display(frame)
    dwell(seconds)


def flash(device, label, value):
    show_pair(device, label, value, FLASH_SECONDS)
    device.clear()
    dwell(FLASH_GAP)


def flash_columns(device, items):
    show_columns(device, items, FLASH_SECONDS)
    device.clear()
    dwell(FLASH_GAP)


def scroll_strip(text, font):
    """Pre-render the text twice over, ready to be cropped per frame."""
    w, h, ox, oy = measure(font, text)
    span = w + SCROLL_GAP
    y = (HEIGHT - h) // 2 - oy
    strip = Image.new("1", (span + WIDTH, HEIGHT))
    draw = ImageDraw.Draw(strip)
    draw.text((-ox, y), text, font=font, fill=255)
    draw.text((span - ox, y), text, font=font, fill=255)
    return strip, span


def scroll_message(device, text, seconds, size=BOOT_SIZE):
    """Scroll a message across the panel for a fixed number of seconds."""
    strip, span = scroll_strip(text, load_font(size))
    start = time.monotonic()
    offset = 0
    while time.monotonic() - start < seconds:
        device.display(strip.crop((offset, 0, offset + WIDTH, HEIGHT)))
        offset = (offset + SCROLL_STEP) % span
        if FRAME_DELAY:
            time.sleep(FRAME_DELAY)


_TC_FONT = None


def _tc_font():
    # The timecode string is a fixed width, so fit the value font once instead
    # of re-measuring it on every tick.
    global _TC_FONT
    if _TC_FONT is None:
        _TC_FONT = fit_font("00:00:00:00", VALUE_SIZES, WIDTH)
    return _TC_FONT


def show_tc(device, seconds, fps=12):
    """Live timecode for its slot.

    Redraws on a fixed cadence (not on message arrival — those land unevenly and
    read as stutter) and only when the value actually changed, using a cached
    font. Smooth and cheap.
    """
    label_font = load_font(LABEL_SIZE)
    value_font = _tc_font()
    lw, _, lox, loy = measure(label_font, "TC")
    lx = (WIDTH - lw) // 2 - lox

    end = time.monotonic() + seconds
    period = 1.0 / fps
    nxt = time.monotonic()
    last = None
    while time.monotonic() < end:
        tc = cue_state()["tc"]
        if tc != last:
            frame = Image.new("1", (WIDTH, HEIGHT))
            draw = ImageDraw.Draw(frame)
            draw.text((lx, -loy), "TC", font=label_font, fill=255)
            vw, vh, vox, voy = measure(value_font, tc)
            draw.text(((WIDTH - vw) // 2 - vox,
                       LABEL_BAND + (HEIGHT - LABEL_BAND - vh) // 2 - voy),
                      tc, font=value_font, fill=255)
            device.display(frame)
            last = tc
        nxt += period
        delay = nxt - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        else:                       # fell behind — resync rather than sprint
            nxt = time.monotonic()


def show_booting(device, role):
    """Scroll a boot/search message until the system is ready."""
    message = "SERVER booting" if role == "server" else "searching for server"
    strip, span = scroll_strip(message, load_font(BOOT_SIZE))
    start = time.monotonic()
    next_check = 0.0
    offset = 0
    while True:
        elapsed = time.monotonic() - start
        if elapsed >= next_check:
            if system_ready(role):
                return
            next_check = elapsed + READY_POLL_SECONDS
        if elapsed > BOOT_TIMEOUT:
            return
        device.display(strip.crop((offset, 0, offset + WIDTH, HEIGHT)))
        offset = (offset + SCROLL_STEP) % span
        if FRAME_DELAY:
            time.sleep(FRAME_DELAY)


def show_alert(device):
    """Blink the change, then hold it, so a drop is hard to miss."""
    label = take_alert()
    if label is None:
        return
    screens = cue_state()["screens"]
    value = "--" if screens is None else str(screens)
    for _ in range(ALERT_BLINKS):
        show_pair(device, label, value, ALERT_ON)
        device.clear()
        time.sleep(ALERT_OFF)
    show_pair(device, label, value, ALERT_SECONDS)


# --- rotation ---------------------------------------------------------------


def screens_columns():
    cue = cue_state()
    return (
        # None means the link is down, worth telling apart from a link that is
        # up and reporting zero screens.
        ("SCREENS", "--" if cue["screens"] is None else str(cue["screens"])),
        ("CUE", "RUN" if cue["running"] else "STOP"),
    )


def temperature_text():
    temp = cpu_temp()
    return f"{temp:.0f}°" if temp else "n/a"


def sysinfo_columns(device):
    flash_columns(device, (
        ("CPU", f"{cpu_percent():.0f}%"),
        ("RAM", f"{ram_percent():.0f}%"),
        ("TEMP", temperature_text()),
    ))


def panels(device, role):
    """The full status rotation, as callables so each reads fresh values."""
    if role == "server":
        return (
            lambda: show_banner(device, "ONLINE", BANNER_SECONDS),
            lambda: flash(device, "SERVER", server_name()),
            lambda: flash(device, "SYSIP:", local_ip() or "no network"),
            lambda: flash_columns(device, screens_columns()),
            lambda: sysinfo_columns(device),
        )
    return (
        lambda: show_banner(
            device, "ONLINE" if cue_state()["link"] else "SEARCHING",
            BANNER_SECONDS,
        ),
        lambda: flash(device, "SCREEN", screen_name()),
        lambda: flash(device, "SYSIP:", local_ip() or "no network"),
        lambda: sysinfo_columns(device),
    )


# --- devices ----------------------------------------------------------------


def open_panel():
    """The real SSD1306. Raises if no panel is wired / I2C isn't ready."""
    from luma.core.interface.serial import i2c
    from luma.oled.device import ssd1306
    return ssd1306(i2c(port=I2C_PORT, address=I2C_ADDRESS),
                   width=WIDTH, height=HEIGHT)


def open_panel_retry(attempts=45, delay=2):
    """Open the panel, retrying for a while.

    At cold boot the I2C bus/kernel modules can lag the service start, and the
    first open then fails — the old code gave up and left the panel dark until a
    manual restart. Keep trying (~90s) so a wired panel always comes up.
    """
    last = None
    for _ in range(attempts):
        try:
            return open_panel()
        except Exception as exc:
            last = exc
            time.sleep(delay)
    raise last if last else RuntimeError("no panel")


class DumpDevice:
    """Stand-in for the panel that writes each frame to a PNG (for --dump)."""

    def __init__(self, out_dir):
        self.dir = Path(out_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.n = 0

    def display(self, image):
        self.n += 1
        big = image.convert("L").resize(
            (WIDTH * DUMP_SCALE, HEIGHT * DUMP_SCALE), Image.NEAREST
        )
        big.save(self.dir / f"frame-{self.n:02d}.png")

    def clear(self):
        pass


# --- entry points -----------------------------------------------------------


def _terminate(signum, frame):
    """Turn systemd's SIGTERM into the same clean exit as Ctrl-C."""
    raise KeyboardInterrupt


def run_dump(role, out_dir):
    """Render the identity splash and one of each panel to PNGs, then exit.

    Seeds cue state so the SERVER's screen count and a CLIENT's name have
    something to show without a live server.
    """
    global FLASH_SECONDS, BANNER_SECONDS, FLASH_GAP
    FLASH_SECONDS = BANNER_SECONDS = FLASH_GAP = 0  # no dwell in a dump
    with _cue_lock:
        _cue.update(screens=3, running=True, link=True,
                    screen_name="Stage Manager")
    device = DumpDevice(out_dir)
    show_identity(device, ("SYNTHONY", role.upper()), 0)
    for panel in panels(device, role):
        panel()
    print(f"wrote {device.n} frames to {out_dir}")


def run(role):
    # Deliberately minimal: show this Pi's name and hold it. The full status
    # rotation (ONLINE / IP / screens / CPU-RAM-TEMP) still lives in panels()
    # above — swap the body back to re-enable it.
    signal.signal(signal.SIGTERM, _terminate)
    try:
        device = open_panel_retry()   # tolerate a slow I2C bus at cold boot
    except Exception as exc:  # genuinely no panel wired / I2C off after retries
        print(f"synthony-oled: no OLED panel after retries ({exc}); exiting")
        raise SystemExit(1)   # non-zero so systemd (Restart=on-failure) retries
    # The connected-screens count comes from the server over the cue link.
    for url in cue_urls(role):
        start_cue_client(url)
        break
    if role == "client":
        # A display Pi shows only ONLINE / OFFLINE — up when its link to the cue
        # server is live (so it's receiving the show data), OFFLINE when it isn't.
        last = None
        try:
            while True:
                state = "ONLINE" if cue_state()["link"] else "OFFLINE"
                if state != last:
                    show_banner(device, state, 0)
                    last = state
                time.sleep(1)
        except KeyboardInterrupt:
            pass
        finally:
            device.clear()
        return

    # Server: the full status rotation.
    HOLD = 4.0   # seconds each screen is held before the next

    def hold():
        # A plain, even dwell. (show_* draw with seconds=0 so their own
        # alert-aware wait returns at once and can't race the rotation.)
        time.sleep(HOLD)

    try:
        while True:
            show_pair(device, "SERVER", server_name(), 0); hold()           # name
            show_pair(device, "IP", local_ip() or "no network", 0); hold()  # ip address
            show_columns(device, (                                          # server stats
                ("CPU", f"{cpu_percent(0.2):.0f}%"),
                ("RAM", f"{ram_percent():.0f}%"),
                ("TEMP", temperature_text()),
            ), 0); hold()
            clients = cue_state()["clients"]                                # display Pis up
            show_pair(device, "CLIENTS", "--" if clients is None else str(clients), 0); hold()
            show_tc(device, HOLD)                                            # current timecode (live)
    except KeyboardInterrupt:
        pass
    finally:
        device.clear()


def main():
    ap = argparse.ArgumentParser(description="Synthony Cue OLED status panel")
    ap.add_argument("--role", choices=("server", "client"),
                    help="override auto-detection")
    ap.add_argument("--dump", metavar="DIR",
                    help="render panels to PNGs instead of driving hardware")
    args = ap.parse_args()

    role = args.role or detect_role()
    if args.dump:
        run_dump(role, args.dump)
    else:
        run(role)


if __name__ == "__main__":
    main()
