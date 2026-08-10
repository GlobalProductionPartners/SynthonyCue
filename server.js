'use strict';

const express = require('express');
const http    = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const fs   = require('fs');
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');
const os = require('os');
const XLSX = require('xlsx');

// ── Config ────────────────────────────────────────────────────────────────────
const DATA_DIR    = process.env.SYNTHONY_DATA_DIR || __dirname;
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const SONGS_PATH  = path.join(DATA_DIR, 'data', 'songs.json');

let config = loadJSON(CONFIG_PATH, {
  port: 3001,
  editPassword: 'synthony',
  oscDestinations: {},
  artnetDestinations: {},
  tcSource: 'internal',
  artnetInterface: 'all',
  cueHoldMode: 'timed',
  // Video source — anything ffmpeg can open. The Zowietek encoder's
  // secondary (720p) stream is the intended input; the 4K main stream costs
  // far more to decode for no gain on a cue display.
  //   rtsp://<encoder-ip>/stream1
  //   lavfi:testsrc2=size=1280x720:rate=25   (built-in test pattern)
  videoSource: '',
  videoWidth: 1280,
  videoFps: 15,
  videoQuality: 6
});

let songs = loadJSON(SONGS_PATH, []);

function loadJSON(filePath, defaults) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return defaults; }
}
function saveJSON(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Atomic: write to a temp file and rename over the target. A power cut
  // mid-write (a real event on show Pis) must never corrupt the live file —
  // rename on the same filesystem is all-or-nothing.
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  // Keep the last few generations so a bad save can be walked back.
  try {
    if (fs.existsSync(filePath)) {
      for (let i = 4; i >= 1; i--) {
        const from = `${filePath}.${i}`, to = `${filePath}.${i + 1}`;
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      fs.copyFileSync(filePath, `${filePath}.1`);
    }
  } catch (e) { console.warn('[Save] backup rotation failed:', e.message); }
  fs.renameSync(tmp, filePath);
}

// ── Video source relay ────────────────────────────────────────────────────────
// Optional in the same way the TC modules are: if it cannot load, everything
// else still runs and the video view simply reports no source.
let Video;
try {
  Video = require('./video/stream');
} catch (e) {
  console.log(`[Video] module not available: ${e.message}`);
  Video = {
    configure() {}, stop() {}, restart() {},
    state: () => ({ url: null, running: false, viewers: 0, hasFrame: false, unavailable: true }),
    handleStream:   (_q, r) => r.status(503).json({ error: 'Video module not available' }),
    handleSnapshot: (_q, r) => r.status(503).json({ error: 'Video module not available' })
  };
}

// ── System resources ──────────────────────────────────────────────────────────
// The server reports its own machine; display-only Pis run a small agent
// (deploy/synthony-stats.sh) that POSTs the same shape here every 10s.
let _cpuPrev = null;
function cpuPercent() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const c of cpus) { for (const k in c.times) total += c.times[k]; idle += c.times.idle; }
  const prev = _cpuPrev; _cpuPrev = { idle, total };
  if (!prev || total <= prev.total) return null;
  return Math.round((1 - (idle - prev.idle) / (total - prev.total)) * 100);
}
function memInfo() {
  const totalMB = Math.round(os.totalmem() / 1048576);
  // Linux: MemAvailable is the honest number — MemFree counts cache as used.
  try {
    const mi = fs.readFileSync('/proc/meminfo', 'utf8');
    const g = (k) => parseInt((mi.match(new RegExp(k + ':\\s+(\\d+)')) || [])[1]) || 0;
    const totalKB = g('MemTotal'), availKB = g('MemAvailable');
    if (totalKB) return { usedMB: Math.round((totalKB - availKB) / 1024), totalMB: Math.round(totalKB / 1024) };
  } catch {}
  // macOS: freemem() is ~0 by design (cache fills RAM), which reads as 100%
  // used. Count what Activity Monitor counts: active + wired + compressed.
  if (process.platform === 'darwin') {
    try {
      const out = require('child_process').execSync('vm_stat', { timeout: 3000 }).toString();
      const page = parseInt((out.match(/page size of (\d+)/) || [])[1]) || 16384;
      const g = (k) => parseInt((out.match(new RegExp(k + ':\\s+(\\d+)')) || [])[1]) || 0;
      const usedPages = g('Pages active') + g('Pages wired down') + g('Pages occupied by compressor');
      if (usedPages) return { usedMB: Math.round(usedPages * page / 1048576), totalMB };
    } catch {}
  }
  return { usedMB: Math.round((os.totalmem() - os.freemem()) / 1048576), totalMB };
}
function localStats() {
  let temp = null;
  try { temp = Math.round(parseInt(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8')) / 1000); } catch {}
  let disk = null;
  try { const st = fs.statfsSync(DATA_DIR); disk = { freeMB: Math.round(st.bavail * st.bsize / 1048576), totalMB: Math.round(st.blocks * st.bsize / 1048576) }; } catch {}
  const mem = memInfo();
  return {
    host: os.hostname().replace(/\.local$/i, ''),
    role: 'server',
    cpu: cpuPercent(),
    load: Math.round(os.loadavg()[0] * 100) / 100,
    memUsedMB: mem.usedMB, memTotalMB: mem.totalMB,
    temp, disk,
    uptimeSec: Math.round(os.uptime()),
    at: Date.now()
  };
}
const remoteStats = new Map();   // host → last report

// ── Flight recorder ───────────────────────────────────────────────────────────
// Append-only show-day log: every fired output, TC event, save, and screen
// drop, stamped with wall clock and show TC. When "did that cue fire?" comes
// up at 23:00, this file answers it.
const LOG_DIR = path.join(DATA_DIR, 'logs');
function flightLog(event, detail = '') {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const now = new Date();
    const day  = now.toISOString().slice(0, 10);
    const wall = now.toTimeString().slice(0, 8);
    const tc   = (typeof TC !== 'undefined' && TC.state) ? TC.state().tc : '--:--:--:--';
    fs.appendFile(path.join(LOG_DIR, `show-${day}.log`),
      `${wall} [TC ${tc}] ${event}${detail ? ' ' + detail : ''}\n`, () => {});
  } catch {}
}

// ── Express + HTTP ────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const upload = multer({
  storage: multer.memoryStorage(),
  // Buffered in memory on a 4GB Pi — a cue sheet is tens of KB, so 10MB is
  // generous while still bounding what an unauthenticated POST can allocate.
  limits: { fileSize: 10 * 1024 * 1024, files: 1 }
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Session auth helpers ──────────────────────────────────────────────────────
// The cookie carries a token derived from the password, never the password
// itself: this runs over plain HTTP on a venue network, so the admin password
// must not be sitting in every request, in browser cookie jars, or in any
// proxy log. Deriving it (rather than keeping a session table) means sessions
// survive a server restart, and changing the password invalidates them all.
function sessionSecret() {
  if (!config.sessionSecret) {
    config.sessionSecret = crypto.randomBytes(32).toString('hex');
    saveJSON(CONFIG_PATH, config);
  }
  return config.sessionSecret;
}
function expectedToken() {
  return crypto.createHmac('sha256', sessionSecret())
               .update(String(config.editPassword))
               .digest('hex');
}
function safeEqual(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
function getSessionToken(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/\bsyn_sess=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
function isAuthedReq(req) {
  const tok = getSessionToken(req);
  return !!tok && safeEqual(tok, expectedToken());
}
function sessionCookie(_password, expire = true) {
  const exp = expire ? `; Expires=${new Date(Date.now() + 86400000 * 30).toUTCString()}` : '';
  return `syn_sess=${expectedToken()}; Path=/; HttpOnly; SameSite=Strict${exp}`;
}

// ── Login / logout ────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (isAuthedReq(req)) { res.redirect('/admin'); return; }
  const err = req.query.error ? '<p class="err">Incorrect password — try again.</p>' : '';
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Synthony Cue — Login</title>
<link rel="stylesheet" href="/theme.css">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:var(--font-ui);display:flex;align-items:center;justify-content:center;min-height:100vh;padding:var(--s-5)}
/* Hairline panel rather than a floating rounded card — same elevation
   language as the rest of the app. */
.card{background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--r-2);padding:var(--s-7) var(--s-6);width:340px;display:flex;flex-direction:column;gap:var(--s-5)}
h1{font-size:12px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:var(--text-3)}
label{display:block;font-size:11px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:var(--text-3);margin-bottom:var(--s-2)}
input{width:100%;padding:10px 12px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-2);color:var(--text);font-size:15px;font-family:var(--font-ui);transition:border-color 150ms ease}
input:hover{border-color:var(--border-str)}
button{width:100%;margin-top:var(--s-4);padding:11px;background:var(--accent);color:#0B0B0C;border:none;border-radius:var(--r-2);font-size:14px;font-weight:700;font-family:var(--font-ui);cursor:pointer;transition:background-color 150ms ease}
button:hover{background:#4DEEFF}
.err{font-size:12px;color:var(--urgent);border-left:2px solid var(--urgent);padding-left:var(--s-2)}
</style>
</head>
<body>
<div class="card">
  <h1>Synthony Cue</h1>
  ${err}
  <form method="POST" action="/login">
    <label for="password">Admin password</label>
    <input id="password" type="password" name="password" autocomplete="current-password" autofocus>
    <button type="submit">Enter</button>
  </form>
</div>
</body>
</html>`);
});

app.post('/login', (req, res) => {
  if (req.body.password === config.editPassword) {
    res.setHeader('Set-Cookie', sessionCookie(config.editPassword));
    res.redirect('/admin');
  } else {
    res.redirect('/login?error=1');
  }
});

app.get('/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'syn_sess=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  res.redirect('/login');
});

// ── Admin (requires session) ──────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  if (!isAuthedReq(req)) { res.redirect('/login'); return; }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'kiosk.html')));
app.use(express.static(path.join(__dirname, 'public')));

// ── WebSocket ─────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });
const clients = new Set();
const screens = new Map(); // screenId → { ws, name, view, slots, cameraType }

function screensList() {
  return Array.from(screens.values()).map(s => ({
    id: s.id, name: s.name, view: s.view, slots: s.slots, cameraType: s.cameraType,
    lastSeen: s.lastSeen || null
  }));
}
function broadcastScreensList() {
  broadcast({ type: 'screens_list', screens: screensList() });
}

wss.on('connection', (ws, req) => {
  clients.add(ws);
  // Auto-auth WebSocket connections that carry a valid session cookie
  if (isAuthedReq(req)) authedClients.set(ws, true);
  safeSend(ws, { type: 'init', songs, config: sanitiseConfig(config), tc: TC.state(), blackout });
  // Screens only announced themselves on connect, so an admin opened after
  // the displays were already running saw an empty list until one of them
  // joined or dropped. Send the current list to every new client.
  safeSend(ws, { type: 'screens_list', screens: screensList() });

  ws.on('message', (raw) => {
    try { handleClientMessage(ws, JSON.parse(raw)); } catch {}
  });
  ws.on('close', () => {
    clients.delete(ws);
    for (const [id, s] of screens) {
      if (s.ws === ws) { screens.delete(id); flightLog('SCREEN-LOST', `${s.name} (${id})`); break; }
    }
    broadcastScreensList();
  });
  ws.on('error', () => clients.delete(ws));
});

function broadcast(msg) {
  const str = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(str);
  }
}
function safeSend(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function broadcastVideoStatus(st) {
  broadcast({ type: 'video_status', ...st });
}

function sanitiseConfig(cfg) {
  const { editPassword, sessionSecret, ...safe } = cfg;
  return safe;
}

// ── Timecode Engine ───────────────────────────────────────────────────────────
const TC = (() => {
  const FRAME_RATE = 25;
  let running = false, startWall = 0, offsetFrames = 0;
  let lastTC = '00:00:00:00', interval = null, source = 'internal';
  let externalTC = null, externalWall = 0, signalLost = true;

  function parse(tc) {
    if (!tc) return 0;
    const [h, m, s, f] = tc.split(':').map(Number);
    return ((h * 3600 + m * 60 + s) * FRAME_RATE) + (f || 0);
  }
  function format(frames) {
    const f = ((frames % FRAME_RATE) + FRAME_RATE) % FRAME_RATE;
    const totalSec = Math.floor(Math.abs(frames) / FRAME_RATE);
    const s = totalSec % 60, m = Math.floor(totalSec / 60) % 60, h = Math.floor(totalSec / 3600);
    return [h, m, s, f].map(n => String(n).padStart(2, '0')).join(':');
  }
  function currentFrames() {
    if (!running) return offsetFrames;
    return offsetFrames + Math.floor((Date.now() - startWall) / 1000 * FRAME_RATE);
  }
  function externalFrames() {
    return externalTC + Math.floor((Date.now() - externalWall) / 1000 * FRAME_RATE);
  }
  const SIGNAL_TIMEOUT_MS = 2000; // 2s without a packet = signal lost
  function tick() {
    if (source !== 'internal') {
      if (externalTC === null) return; // no packet received yet for this source
      const staleness = Date.now() - externalWall;
      if (staleness > SIGNAL_TIMEOUT_MS) {
        if (!signalLost) {
          signalLost = true;
          broadcast({ type: 'tc_transport', running: false, tc: format(externalTC + Math.floor(SIGNAL_TIMEOUT_MS / 1000 * FRAME_RATE)) });
          console.log('[TC] External signal lost');
          flightLog('SIGNAL-LOST');
        }
        return;
      }
      if (signalLost) {
        signalLost = false;
        broadcast({ type: 'tc_transport', running: true, tc: format(externalFrames()) });
        console.log('[TC] External signal resumed');
        flightLog('SIGNAL-RESUMED');
      }
      const frames = externalFrames();
      const tc = format(frames);
      if (tc !== lastTC) {
        lastTC = tc;
        broadcast({ type: 'tc', tc, frames });
        checkCueFires(frames);
      }
      return;
    }
    // Internal clock
    const frames = currentFrames();
    const tc = format(frames);
    if (tc !== lastTC) {
      lastTC = tc;
      broadcast({ type: 'tc', tc, frames });
      checkCueFires(frames);
    }
  }
  function start(tc) {
    offsetFrames = tc !== undefined ? parse(tc) : offsetFrames;
    startWall = Date.now(); running = true;
    if (!interval) interval = setInterval(tick, 1000 / FRAME_RATE);
    broadcast({ type: 'tc_transport', running: true, tc: format(offsetFrames) });
    console.log(`[TC] Started at ${format(offsetFrames)}`);
  }
  function stop() {
    offsetFrames = currentFrames(); running = false;
    if (interval) { clearInterval(interval); interval = null; }
    broadcast({ type: 'tc_transport', running: false, tc: format(offsetFrames) });
    console.log(`[TC] Stopped at ${format(offsetFrames)}`);
  }
  function jam(tc) {
    const wasRunning = running;
    if (running) stop();
    offsetFrames = parse(tc);
    if (wasRunning) start();
    broadcast({ type: 'tc_jam', tc });
    console.log(`[TC] Jammed to ${tc}`);
    flightLog('JAM', tc);
  }
  function receiveExternal(tc, src) {
    // Validate TC format and range
    const parts = (tc || '').split(':').map(Number);
    if (parts.length !== 4 || parts.some(isNaN)) return;
    const [h, m, s, f] = parts;
    if (h > 23 || m > 59 || s > 59 || f >= FRAME_RATE) return;
    const frames = parse(tc);
    if (externalTC !== null) {
      const delta = frames - externalTC;
      // Ignore small backward jumps (< 2s) — chunk timing noise
      if (delta < 0 && delta > -(2 * FRAME_RATE)) return;
    }
    externalTC   = frames;
    externalWall = Date.now();
    if (!interval) interval = setInterval(tick, 1000 / FRAME_RATE);
    if (source !== src) { source = src; console.log(`[TC] Source switched to ${src}`); }
  }
  function setSource(src) {
    if (src !== source && src !== 'internal') {
      // Switching to an external source — clear stale signal state immediately
      externalTC = null;
      externalWall = 0;
      signalLost = true;
      broadcast({ type: 'tc_transport', running: false, tc: format(offsetFrames) });
    }
    source = src;
    console.log(`[TC] Source set to ${src}`);
  }

  return { start, stop, jam, receiveExternal, setSource, parse, format,
    state: () => ({ running, tc: format(currentFrames()), source }),
    currentFrames };
})();

// ── Cue fire engine ───────────────────────────────────────────────────────────
// Blackout: one flag, every screen honours it. Included in init so screens
// that reconnect mid-blackout come back dark, not lit.
let blackout = false;

const firedOutputs = new Set();
let lastBroadcastFrames = 0;
const FRAME_RATE_FIRE_WINDOW = 250; // 10s at 25fps — late allowance, not a drop window

function checkCueFires(nowFrames) {
  // Reset on TC jump backwards
  if (nowFrames < lastBroadcastFrames - 50) {
    firedOutputs.clear();
    console.log('[TC] Jump detected — cleared fired outputs');
  }
  lastBroadcastFrames = nowFrames;

  for (const song of songs) {
    const songFrames = TC.parse(song.timecode || '00:00:00:00');
    for (const cue of (song.cues || [])) {
      const cueFrames = songFrames + TC.parse(cue.offset || '00:00:00:00');

      if (cue.osc?.enabled) {
        const key    = `osc-${cue.id}`;
        const fireAt = cueFrames - (cue.osc.preRollFrames || 0);
        // Fire on threshold-crossing with a 10s late allowance: a GC pause or
        // busy Pi must delay a cue, never silently drop it. The ceiling stops
        // a large TC seek from replaying ancient cues.
        if (nowFrames >= fireAt && nowFrames < fireAt + FRAME_RATE_FIRE_WINDOW && !firedOutputs.has(key)) {
          firedOutputs.add(key);
          if (nowFrames > fireAt + 5) flightLog('LATE-FIRE', `osc cue ${cue.id} ${(nowFrames - fireAt)} frames late`);
          fireOSC(cue);
        }
      }
      if (cue.artnet?.enabled) {
        const key    = `artnet-${cue.id}`;
        const fireAt = cueFrames - (cue.artnet.preRollFrames || 0);
        if (nowFrames >= fireAt && nowFrames < fireAt + FRAME_RATE_FIRE_WINDOW && !firedOutputs.has(key)) {
          firedOutputs.add(key);
          if (nowFrames > fireAt + 5) flightLog('LATE-FIRE', `artnet cue ${cue.id} ${(nowFrames - fireAt)} frames late`);
          fireArtNet(cue);
        }
      }
    }
  }
}

// ── OSC output ────────────────────────────────────────────────────────────────
let oscModule = null;
try { oscModule = require('./output/osc'); } catch {}

function fireOSC(cue) {
  const dest = config.oscDestinations?.[cue.osc.destination];
  if (!dest) { logOutput('osc', cue.id, false, `Unknown destination: ${cue.osc.destination}`); return; }
  if (oscModule) {
    oscModule.send(dest.host, dest.port, cue.osc.address, cue.osc.args,
      (err) => logOutput('osc', cue.id, !err, err?.message));
  } else {
    logOutput('osc', cue.id, false, 'OSC module not available');
  }
}

// ── ArtNet output ─────────────────────────────────────────────────────────────
let artnetModule = null;
try { artnetModule = require('./output/artnet-out'); } catch {}

function fireArtNet(cue) {
  const dest = config.artnetDestinations?.[cue.artnet.destination];
  if (!dest) { logOutput('artnet', cue.id, false, `Unknown destination: ${cue.artnet.destination}`); return; }
  if (artnetModule) {
    artnetModule.send(dest.host, cue.artnet.universe, cue.artnet.channel, cue.artnet.value,
      (err) => logOutput('artnet', cue.id, !err, err?.message));
  } else {
    logOutput('artnet', cue.id, false, 'ArtNet module not available');
  }
}

function logOutput(type, cueId, success, message) {
  flightLog(arguments[2] ? 'FIRE' : 'FIRE-FAILED', `${arguments[0]} cue=${arguments[1]}${arguments[3] ? ' ' + arguments[3] : ''}`);
  const entry = { type, cueId, success, message, time: new Date().toISOString() };
  broadcast({ type: 'output_log', entry });
  console.log(`[${type.toUpperCase()}] cue=${cueId} ok=${success} ${message || ''}`);
}

// ── Client message handler ────────────────────────────────────────────────────
const authedClients = new WeakMap();

function verifyEdit(ws, msg) {
  if (authedClients.get(ws)) return true;
  if (msg.password === config.editPassword) { authedClients.set(ws, true); return true; }
  safeSend(ws, { type: 'error', message: 'Unauthorized' });
  return false;
}

function handleClientMessage(ws, msg) {
  switch (msg.type) {
    case 'tc_start':  if (!verifyEdit(ws, msg)) return; if (TC.state().source === 'internal') TC.start(msg.tc); break;
    case 'tc_stop':   if (!verifyEdit(ws, msg)) return; if (TC.state().source === 'internal') TC.stop();  break;
    case 'tc_jam':    if (!verifyEdit(ws, msg)) return; if (TC.state().source === 'internal') TC.jam(msg.tc); break;
    case 'tc_source': {
      if (!verifyEdit(ws, msg)) return;
      const prev = TC.state().source;
      TC.setSource(msg.source);
      config.tcSource = msg.source;
      // LTC's ffmpeg capture only runs while it is the selected source
      if (msg.source !== prev) {
        const ltc = require('./tc/ltc');
        if (msg.source === 'ltc') {
          ltc.start((tc) => TC.receiveExternal(tc, 'ltc'), config.ltcDevice, config.ltcChannel);
          ltc.startMonitor(config.ltcDevice, config.ltcChannel, (db) => broadcast({ type: 'ltc_level', db }));
          console.log('[LTC] Started (source selected)');
        } else if (prev === 'ltc') {
          ltc.stop();
          ltc.stopMonitor();
          console.log('[LTC] Stopped (source changed)');
        }
      }
      break;
    }

    case 'apply_artnet': {
      if (!verifyEdit(ws, msg)) return;
      const artnet = require('./tc/artnet');
      config.artnetInterface = msg.interface || 'all';
      config.tcSource = 'artnet';
      saveJSON(CONFIG_PATH, config);
      broadcast({ type: 'config_updated', config: sanitiseConfig(config) });
      artnet.start((tc) => TC.receiveExternal(tc, 'artnet'), config.artnetInterface);
      TC.setSource('artnet');
      console.log(`[ArtNet TC] Restarted on interface: ${config.artnetInterface}`);
      break;
    }

    case 'apply_video': {
      // Gated: this persists config and starts a process against a
      // caller-supplied URL. (spawn uses an argv array, so there is no shell
      // to inject into, but it should still not be open to any client.)
      if (!verifyEdit(ws, msg)) return;
      config.videoSource  = (msg.source || '').trim();
      if (msg.width   != null) config.videoWidth   = parseInt(msg.width)   || 1280;
      if (msg.fps     != null) config.videoFps     = parseInt(msg.fps)     || 15;
      if (msg.quality != null) config.videoQuality = parseInt(msg.quality) || 6;
      saveJSON(CONFIG_PATH, config);
      Video.configure(config, broadcastVideoStatus);
      Video.restart();
      broadcast({ type: 'config_updated', config: sanitiseConfig(config) });
      console.log(`[Video] source set → ${config.videoSource || '(none)'}`);
      break;
    }

    case 'apply_ltc': {
      if (!verifyEdit(ws, msg)) return;
      const ltc = require('./tc/ltc');
      config.ltcDevice  = msg.device;
      config.ltcChannel = parseInt(msg.channel) || 1;
      config.tcSource   = 'ltc';
      TC.setSource('ltc');
      saveJSON(CONFIG_PATH, config);
      broadcast({ type: 'config_updated', config: sanitiseConfig(config) });
      ltc.start((tc) => TC.receiveExternal(tc, 'ltc'), config.ltcDevice, config.ltcChannel);
      ltc.startMonitor(config.ltcDevice, config.ltcChannel, (db) => broadcast({ type: 'ltc_level', db }));
      console.log(`[LTC] Applied → device:${config.ltcDevice} channel:${config.ltcChannel}`);
      break;
    }

    case 'auth': {
      const ok = msg.password === config.editPassword;
      if (ok) authedClients.set(ws, true);
      safeSend(ws, { type: 'auth_result', ok });
      break;
    }

    case 'save_show': {
      if (!verifyEdit(ws, msg)) return;
      const slug = showSlug(msg.name);
      if (!slug) { safeSend(ws, { type: 'error', message: 'Show name required' }); return; }
      saveJSON(path.join(SHOWS_DIR, slug + '.json'), songs);
      flightLog('SHOW-SAVED', slug);
      safeSend(ws, { type: 'show_saved', name: slug });
      break;
    }

    case 'load_show': {
      if (!verifyEdit(ws, msg)) return;
      const slug = showSlug(msg.name);
      const file = path.join(SHOWS_DIR, slug + '.json');
      if (!slug || !fs.existsSync(file)) { safeSend(ws, { type: 'error', message: 'Show not found' }); return; }
      try {
        songs = JSON.parse(fs.readFileSync(file, 'utf8'));
        saveJSON(SONGS_PATH, songs);      // loading a show IS the new live state
        firedOutputs.clear();
        flightLog('SHOW-LOADED', slug);
        broadcast({ type: 'songs_updated', songs });
      } catch (e) { safeSend(ws, { type: 'error', message: 'Show file unreadable: ' + e.message }); }
      break;
    }

    case 'delete_show': {
      if (!verifyEdit(ws, msg)) return;
      const slug = showSlug(msg.name);
      const file = path.join(SHOWS_DIR, slug + '.json');
      if (slug && fs.existsSync(file)) { fs.unlinkSync(file); flightLog('SHOW-DELETED', slug); }
      safeSend(ws, { type: 'show_deleted', name: slug });
      break;
    }

    case 'blackout': {
      if (!verifyEdit(ws, msg)) return;
      blackout = !!msg.on;
      flightLog(blackout ? 'BLACKOUT-ON' : 'BLACKOUT-OFF');
      broadcast({ type: 'blackout', on: blackout });
      break;
    }

    case 'manual_fire': {
      // Fire a cue's outputs immediately and tell operator views to show it
      // as NOW for its duration. Display override is deliberately scoped to
      // the stage/console views — TC-derived views stay TC-derived.
      if (!verifyEdit(ws, msg)) return;
      let fired = null;
      for (const song of songs) {
        for (const cue of (song.cues || [])) {
          if (cue.id === msg.cueId) { fired = { song, cue }; break; }
        }
        if (fired) break;
      }
      if (!fired) { safeSend(ws, { type: 'error', message: 'Cue not found' }); return; }
      if (fired.cue.osc?.enabled)    { firedOutputs.add(`osc-${fired.cue.id}`);    fireOSC(fired.cue); }
      if (fired.cue.artnet?.enabled) { firedOutputs.add(`artnet-${fired.cue.id}`); fireArtNet(fired.cue); }
      flightLog('MANUAL-FIRE', `cue ${fired.cue.id} (${fired.cue.stageCue || fired.cue.hostCue || fired.cue.description || ''})`);
      broadcast({ type: 'manual_cue', cue: fired.cue, songId: fired.song.id, atFrames: TC.currentFrames() });
      break;
    }

    case 'save_songs': {
      if (!verifyEdit(ws, msg)) return;
      songs = msg.songs;
      // Normalise cue order within each song regardless of which client saved:
      // cue playback walks the array and stops at the first future offset, so
      // an out-of-order list silently skips cues mid-show.
      for (const song of songs || []) {
        (song.cues || []).sort((a, b) => TC.parse(a.offset) - TC.parse(b.offset));
      }
      saveJSON(SONGS_PATH, songs);
      firedOutputs.clear();
      flightLog('SONGS-SAVED', `${songs.length} songs`);
      broadcast({ type: 'songs_updated', songs });
      break;
    }

    case 'save_config': {
      if (!verifyEdit(ws, msg)) return;
      const prevLtcDevice = String(config.ltcDevice ?? '');
      const prevLtcChannel = String(config.ltcChannel ?? '');
      config = { ...config, ...msg.config };
      saveJSON(CONFIG_PATH, config);
      broadcast({ type: 'config_updated', config: sanitiseConfig(config) });
      // Restart LTC listener if device or channel changed
      if (String(config.ltcDevice ?? '') !== prevLtcDevice || String(config.ltcChannel ?? '') !== prevLtcChannel) {
        try {
          const ltc = require('./tc/ltc');
          ltc.start((tc) => TC.receiveExternal(tc, 'ltc'), config.ltcDevice, config.ltcChannel);
          ltc.startMonitor(config.ltcDevice, config.ltcChannel, (db) => {
            broadcast({ type: 'ltc_level', db });
          });
          console.log(`[LTC] Restarted → device:${config.ltcDevice} channel:${config.ltcChannel}`);
        } catch (e) { console.log(`[LTC] Restart failed: ${e.message}`); }
      }
      break;
    }

    case 'screen_hello': {
      screens.set(msg.id, { ws, id: msg.id, name: msg.name, view: msg.view, slots: msg.slots, cameraType: msg.cameraType, lastSeen: Date.now() });
      flightLog('SCREEN-CONNECTED', `${msg.name} (${msg.id})`);
      broadcastScreensList();
      break;
    }

    case 'screen_update': {
      const s = screens.get(msg.id);
      if (s) { Object.assign(s, { name: msg.name, view: msg.view, slots: msg.slots, cameraType: msg.cameraType, lastSeen: Date.now() }); broadcastScreensList(); }
      break;
    }

    case 'screen_command': {
      if (!verifyEdit(ws, msg)) return;
      const target = screens.get(msg.targetId);
      console.log(`[Screen] Command → ${msg.targetId} (${target ? 'found, state=' + target.ws.readyState : 'NOT FOUND'}) view=${msg.view}`);
      console.log(`[Screen] Known screens: ${[...screens.keys()].join(', ') || 'none'}`);
      if (target?.ws?.readyState === 1) safeSend(target.ws, { type: 'screen_command', view: msg.view, slots: msg.slots, cameraType: msg.cameraType });
      break;
    }

    case 'ping': safeSend(ws, { type: 'pong' }); break;
  }
}

// ── REST API ──────────────────────────────────────────────────────────────────
app.get('/api/songs', (_req, res) => res.json(songs));

// Named shows — data/shows/<slug>.json snapshots of the whole song list.
const SHOWS_DIR = path.join(DATA_DIR, 'shows');
function showSlug(name) {
  return String(name || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
app.get('/api/shows', (_req, res) => {
  try {
    fs.mkdirSync(SHOWS_DIR, { recursive: true });
    const list = fs.readdirSync(SHOWS_DIR).filter(f => f.endsWith('.json')).map(f => {
      const st = fs.statSync(path.join(SHOWS_DIR, f));
      let meta = { songs: 0 };
      try { meta.songs = JSON.parse(fs.readFileSync(path.join(SHOWS_DIR, f), 'utf8')).length; } catch {}
      return { name: f.slice(0, -5), savedAt: st.mtime.toISOString(), songs: meta.songs };
    }).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    res.json({ shows: list });
  } catch (e) { res.json({ shows: [], error: e.message }); }
});

app.get('/api/network/interfaces', (_req, res) => {
  const os = require('os');
  const ifaces = os.networkInterfaces();
  const result = [{ label: 'All Adapters', ip: 'all' }];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of (addrs || [])) {
      if (addr.family === 'IPv4' && !addr.internal) {
        result.push({ label: `${name}  —  ${addr.address}`, ip: addr.address });
      }
    }
  }
  result.push({ label: 'Loopback (127.0.0.1)', ip: '127.0.0.1' });
  res.json({ interfaces: result, current: config.artnetInterface || 'all' });
});

// ── Video source ──────────────────────────────────────────────────────────────
// MJPEG is the only live video a browser plays with no extra library, which
// matters because a show Pi has no internet to fetch one. See video/stream.js.
// System resources: local machine + every reporting Pi. Admin-only read.
app.get('/api/system', (req, res) => {
  if (!isAuthedReq(req)) { res.status(401).json({ error: 'Unauthorized' }); return; }
  // Drop reporters not heard from in 2 minutes
  const cutoff = Date.now() - 120000;
  for (const [h, r] of remoteStats) if (r.at < cutoff) remoteStats.delete(h);
  res.json({ local: localStats(), remotes: Array.from(remoteStats.values()).sort((a, b) => a.host.localeCompare(b.host)) });
});
// Telemetry in from display Pis — LAN-benign data, but bound and sanitise it.
app.post('/api/system/report', (req, res) => {
  const b = req.body || {};
  const host = String(b.host || '').slice(0, 60);
  if (!host) { res.status(400).json({ error: 'host required' }); return; }
  if (!remoteStats.has(host) && remoteStats.size >= 50) { res.status(429).json({ error: 'too many reporters' }); return; }
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  remoteStats.set(host, {
    host, role: 'display',
    cpu: num(b.cpu), load: num(b.load),
    memUsedMB: num(b.memUsedMB), memTotalMB: num(b.memTotalMB),
    temp: num(b.temp),
    disk: b.disk && num(b.disk.freeMB) != null ? { freeMB: num(b.disk.freeMB), totalMB: num(b.disk.totalMB) } : null,
    uptimeSec: num(b.uptimeSec),
    at: Date.now()
  });
  res.json({ ok: true });
});

app.get('/api/video/stream',   (req, res) => Video.handleStream(req, res));
app.get('/api/video/snapshot', (req, res) => Video.handleSnapshot(req, res));
app.get('/api/video/state',    (_req, res) => res.json(Video.state()));

// Admin-only: spawns ffprobe against a caller-supplied URL.
app.get('/api/video/probe', (req, res) => {
  if (!isAuthedReq(req)) { res.status(401).json({ ok: false, error: 'Unauthorized' }); return; }
  if (!Video.probe) { res.json({ ok: false, error: 'Probe not available' }); return; }
  Video.probe(String(req.query.url || '').trim(), (result) => res.json(result));
});


app.get('/api/audio/devices', async (_req, res) => {
  try {
    const ltc = require('./tc/ltc');
    const devices = await ltc.getDevices();
    res.json({ devices });
  } catch (e) {
    res.json({ devices: [], error: e.message });
  }
});

app.get('/api/audio/probe/:index', async (req, res) => {
  try {
    const ltc = require('./tc/ltc');
    const info = await ltc.probeDevice(req.params.index);
    res.json(info);
  } catch (e) {
    res.json({ channels: 2, error: e.message });
  }
});

// Export: flatten songs→cues with absolute TC
app.get('/api/export/xlsx', (_req, res) => {
  const rows = [];
  for (const song of songs) {
    rows.push({ Type: 'SONG', TC: song.timecode, 'Track Name': song.trackName,
      Duration: song.duration, BPM: song.bpm, Description: song.description });
    for (const cue of (song.cues || [])) {
      rows.push({ Type: 'CUE', Offset: cue.offset, 'Stage Cue': cue.stageCue,
        'Host Cue': cue.hostCue, 'Conductor Cue': cue.conductorCue,
        'Camera Cue': cue.cameraCue, Description: cue.description, 'Cue Duration': cue.duration || '',
        'OSC En': cue.osc?.enabled, 'OSC Addr': cue.osc?.address,
        'OSC Args': cue.osc?.args, 'OSC Dest': cue.osc?.destination,
        'AN En': cue.artnet?.enabled, 'AN Uni': cue.artnet?.universe,
        'AN Ch': cue.artnet?.channel, 'AN Val': cue.artnet?.value });
    }
  }
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Songs');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="songs.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

app.get('/api/export/json', (_req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="songs.json"');
  res.json(songs);
});

// Import Synthony XLSX → songs
app.post('/api/import/xlsx', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows  = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    const { songs, warnings } = parseSynthonySheet(rows);
    const resp = { songs, count: songs.length, warnings };
    if (songs.length === 0) {
      resp.diagnostics = {
        sheetName: wb.SheetNames[0],
        rowCount: rows.length,
        headers: rows[0] ? rows[0].slice(0, 11).map(String) : [],
        firstDataRow: rows[1] ? rows[1].slice(0, 11).map(String) : []
      };
    }
    res.json(resp);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── XLSX import parser ────────────────────────────────────────────────────────
const FR = 25;
let _idCounter = Date.now();
function uid() { return (++_idCounter).toString(36); }

function toTC(totalSec) {
  if (totalSec < 0) totalSec = 0;
  const frames = Math.round(totalSec * FR);
  const f = frames % FR, s = Math.floor(frames/FR)%60, m = Math.floor(frames/(FR*60))%60, h = Math.floor(frames/(FR*3600));
  return [h,m,s,f].map(n=>String(n).padStart(2,'0')).join(':');
}
function tcToSec(tc) {
  if (!tc) return 0;
  const [h,m,s,f] = tc.split(':').map(Number);
  return h*3600 + m*60 + s + (f||0)/FR;
}
function durToStr(frac) {
  if (!frac || typeof frac !== 'number') return '';
  const t = Math.round(frac * 86400);
  return Math.floor(t/60)+':'+String(t%60).padStart(2,'0');
}

function parseSynthonySheet(rows) {
  // Column layout (0-indexed):
  // 0:TIMECODE  1:TRACK DURATION  2:TRACK/EVENT  3:BPM  4:DESCRIPTION
  // 5:STAGE CUE  6:HOST CUE  7:CONDUCTOR CUE  8:GIVE CAMERA CUE AT
  // 9:CAMERA CUES/KEY MOMENTS  10:LASERS,FIRE,PYRO

  function parseTCStr(s) {
    const str = String(s || '').trim();
    if (!str) return null;
    const parts = str.split(':').map(Number);
    if (parts.length !== 4 || parts.some(isNaN)) return null;
    const [h, m, sec, f] = parts;
    if (h > 23) return null;
    return h * 3600 + m * 60 + sec + f / FR;
  }

  function parseDurStr(s) {
    // "HH:MM:SS:FF" → "mm:ss" for storage; returns '' if zero/empty
    const str = String(s || '').trim();
    if (!str) return '';
    const parts = str.split(':').map(Number);
    if (parts.length < 3 || parts.some(isNaN)) return '';
    const totalSec = parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (totalSec === 0) return '';
    return Math.floor(totalSec / 60) + ':' + String(totalSec % 60).padStart(2, '0');
  }

  function blankCue(fields) {
    return { id: uid(), offset: '00:00:00:00', stageCue: '', hostCue: '', conductorCue: '',
      cameraCue: '', duration: '', description: '', ...fields,
      osc: { enabled: false, address: '', args: '', destination: '', preRollFrames: 0 },
      artnet: { enabled: false, universe: 0, channel: 1, value: 0, destination: '', preRollFrames: 0 } };
  }

  const result = [];
  let currentSong = null;
  const preShow = { id: uid(), timecode: '00:00:00:00', trackName: 'Pre-Show',
    duration: '', bpm: null, description: '', cues: [] };
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (i === 0) continue; // header row

    const tc       = parseTCStr(r[0]);
    const trackName = String(r[2] || '').trim();
    const duration  = parseDurStr(r[1]);
    const bpm       = parseInt(String(r[3] || '')) || null;
    const desc      = String(r[4] || '').trim();
    const stageCue  = String(r[5] || '').trim();
    const hostCue   = String(r[6] || '').trim();
    const conductorCue = String(r[7] || '').trim();
    const cameraNotes  = String(r[8] || '').trim(); // "give camera cue at" — informational
    const cameraCue    = String(r[9] || '').trim(); // camera cues / key moments
    const pyro         = String(r[10] || '').trim();

    const isTransition = trackName.toLowerCase().startsWith('next track');
    const isTrack = trackName && !isTransition;

    if (isTrack) {
      if (tc === null) { errors.push(`Row ${i+1}: track "${trackName}" has no valid TC, skipped`); continue; }
      const trackDesc = [desc, cameraCue, pyro].filter(Boolean).join(' | ');
      currentSong = { id: uid(), timecode: toTC(tc), trackName, duration, bpm,
        description: trackDesc, cues: [] };
      result.push(currentSong);
      // Capture cue content on the track row itself (conductor, stage, host, or description at track start)
      if (stageCue || hostCue || conductorCue || desc) {
        currentSong.cues.push(blankCue({ stageCue, hostCue, conductorCue,
          cameraCue: cameraNotes || '', description: desc,
          duration: desc ? (duration || '') : '' }));
      }
      continue;
    }

    if (isTransition) {
      if (tc === null) { errors.push(`Row ${i+1}: transition "${trackName}" has no TC, skipped`); continue; }
      currentSong = { id: uid(), timecode: toTC(tc), trackName, duration, bpm: null,
        description: desc, cues: [], isTransition: true };
      result.push(currentSong);
      if (stageCue || hostCue || conductorCue) {
        currentSong.cues.push(blankCue({ stageCue, hostCue, conductorCue, cameraCue, description: desc }));
      }
      continue;
    }

    // Cue row (empty track name)
    const hasCue = stageCue || hostCue || conductorCue || cameraCue;
    if (!hasCue) continue;
    if (tc === null) { errors.push(`Row ${i+1}: cue row has no TC, skipped`); continue; }
    const target = currentSong || preShow;
    const offset = Math.max(0, tc - tcToSec(target.timecode));
    const cueDesc = [desc, pyro].filter(Boolean).join(' | ');
    target.cues.push(blankCue({ offset: toTC(offset), stageCue, hostCue, conductorCue,
      cameraCue: cameraCue || cameraNotes, description: cueDesc }));
  }

  if (errors.length) console.warn('[Import] Warnings:\n' + errors.join('\n'));
  if (preShow.cues.length > 0) result.unshift(preShow);
  return { songs: result, warnings: errors };
}

// ── External TC module loader ─────────────────────────────────────────────────
function loadTCModules() {
  const modules = [
    { key: 'artnet', path: './tc/artnet', priority: 4 },
    { key: 'ltc', path: './tc/ltc', priority: 5 }
  ];
  for (const mod of modules) {
    try {
      // LTC spawns ffmpeg continuously, so only run it when it's the chosen
      // source. The others are passive listeners and can stay loaded.
      if (mod.key === 'ltc' && config.tcSource !== 'ltc') {
        console.log('[TC] ltc module idle (source is ' + config.tcSource + ')');
        continue;
      }
      const m = require(mod.path);
      if (mod.key === 'ltc') {
        m.start((tc) => TC.receiveExternal(tc, 'ltc'), config.ltcDevice, config.ltcChannel);
        m.startMonitor(config.ltcDevice, config.ltcChannel, (db) => broadcast({ type: 'ltc_level', db }));
      } else if (mod.key === 'artnet') {
        m.start((tc) => TC.receiveExternal(tc, 'artnet'), config.artnetInterface || 'all');
      } else {
        m.start((tc) => TC.receiveExternal(tc, mod.key));
      }
      console.log(`[TC] Loaded ${mod.key} module`);
    } catch (e) {
      console.log(`[TC] ${mod.key} not available: ${e.message}`);
    }
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
Video.configure(config, broadcastVideoStatus);
if (config.videoSource) console.log(`[Video] source configured → ${config.videoSource}`);

const PORT = process.env.PORT || config.port || 3001;

// ── mDNS advertising ──────────────────────────────────────────────────────────
// Client Pis find the cue server by browsing _synthony._tcp instead of being
// configured with an IP — venue DHCP can hand out whatever it likes. Published
// from Node (not a static avahi file) so the advert exists only while the
// server is actually running. Best-effort: discovery failing must never stop
// the show server.
let _bonjour = null;
try {
  const { Bonjour } = require('bonjour-service');
  _bonjour = new Bonjour();
  const svcName = `Synthony Cue (${require('os').hostname().replace(/\.local$/i, '')})`;
  _bonjour.publish({ name: svcName, type: 'synthony', port: Number(PORT) });
  console.log(`[mDNS] advertising "${svcName}" as _synthony._tcp on :${PORT}`);
  const stopAds = () => { try { _bonjour.unpublishAll(() => process.exit(0)); } catch { process.exit(0); } };
  process.on('SIGTERM', stopAds);
  process.on('SIGINT', stopAds);
} catch (e) {
  console.log(`[mDNS] advertising unavailable: ${e.message}`);
}

// Port-80 convenience listener: browsers assume :80 when no port is typed, so
// operators can reach the app as plain http://<host>/ . Same express app, and
// WebSocket upgrades are forwarded to the same wss. If the OS refuses the
// privileged port (Linux non-root without CAP_NET_BIND_SERVICE) or something
// else owns :80, log one line and carry on — :PORT keeps working regardless.
if (Number(PORT) !== 80) {
  const front = http.createServer(app);
  front.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws2) => wss.emit('connection', ws2, req));
  });
  front.on('error', (e) => {
    console.log(`[HTTP] port 80 unavailable (${e.code}) — reach the app on :${PORT}`);
  });
  front.listen(80, () => console.log('[HTTP] also listening on :80 — no port needed in the URL'));
}

server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║   Synthony Cue System                ║`);
  console.log(`║   http://localhost:${PORT}               ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
  loadTCModules();
  TC.start('00:00:00:00');
});
