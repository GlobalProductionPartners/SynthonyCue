'use strict';

const express = require('express');
const http    = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const fs   = require('fs');
const path = require('path');
const multer = require('multer');
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
  cueHoldMode: 'timed'
});

let songs = loadJSON(SONGS_PATH, []);

function loadJSON(filePath, defaults) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return defaults; }
}
function saveJSON(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ── Express + HTTP ────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Session auth helpers ──────────────────────────────────────────────────────
function getSessionToken(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/\bsyn_sess=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
function isAuthedReq(req) {
  return getSessionToken(req) === config.editPassword;
}
function sessionCookie(password, expire = true) {
  const exp = expire ? `; Expires=${new Date(Date.now() + 86400000 * 30).toUTCString()}` : '';
  return `syn_sess=${encodeURIComponent(password)}; Path=/; HttpOnly; SameSite=Strict${exp}`;
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
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:#000;color:#c9d1d9;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#0a0a0a;border:1px solid #222;border-radius:12px;padding:40px 36px;width:320px;display:flex;flex-direction:column;gap:20px}
h1{font-size:15px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#6e7681}
input{width:100%;padding:10px 12px;background:#111;border:1px solid #333;border-radius:6px;color:#c9d1d9;font-size:15px;outline:none}
input:focus{border-color:#30d158}
button{padding:10px;background:#30d158;color:#000;border:none;border-radius:6px;font-size:14px;font-weight:700;cursor:pointer}
button:hover{background:#3de66a}
.err{font-size:12px;color:#ff453a}
</style>
</head>
<body>
<div class="card">
  <h1>Synthony Cue</h1>
  ${err}
  <form method="POST" action="/login">
    <input type="password" name="password" placeholder="Admin password" autofocus>
    <br><br>
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

function broadcastScreensList() {
  const list = Array.from(screens.values()).map(s => ({
    id: s.id, name: s.name, view: s.view, slots: s.slots, cameraType: s.cameraType
  }));
  broadcast({ type: 'screens_list', screens: list });
}

wss.on('connection', (ws, req) => {
  clients.add(ws);
  // Auto-auth WebSocket connections that carry a valid session cookie
  if (isAuthedReq(req)) authedClients.set(ws, true);
  safeSend(ws, { type: 'init', songs, config: sanitiseConfig(config), tc: TC.state() });

  ws.on('message', (raw) => {
    try { handleClientMessage(ws, JSON.parse(raw)); } catch {}
  });
  ws.on('close', () => {
    clients.delete(ws);
    for (const [id, s] of screens) { if (s.ws === ws) { screens.delete(id); break; } }
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
function sanitiseConfig(cfg) {
  const { editPassword, ...safe } = cfg;
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
        }
        return;
      }
      if (signalLost) {
        signalLost = false;
        broadcast({ type: 'tc_transport', running: true, tc: format(externalFrames()) });
        console.log('[TC] External signal resumed');
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
const firedOutputs = new Set();
let lastBroadcastFrames = 0;

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
        if (nowFrames >= fireAt && nowFrames < fireAt + 5 && !firedOutputs.has(key)) {
          firedOutputs.add(key);
          fireOSC(cue);
        }
      }
      if (cue.artnet?.enabled) {
        const key    = `artnet-${cue.id}`;
        const fireAt = cueFrames - (cue.artnet.preRollFrames || 0);
        if (nowFrames >= fireAt && nowFrames < fireAt + 5 && !firedOutputs.has(key)) {
          firedOutputs.add(key);
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
    case 'tc_start':  if (TC.state().source === 'internal') TC.start(msg.tc); break;
    case 'tc_stop':   if (TC.state().source === 'internal') TC.stop();  break;
    case 'tc_jam':    if (TC.state().source === 'internal') TC.jam(msg.tc); break;
    case 'tc_source': TC.setSource(msg.source); break;

    case 'apply_artnet': {
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

    case 'apply_ltc': {
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

    case 'save_songs': {
      if (!verifyEdit(ws, msg)) return;
      songs = msg.songs;
      saveJSON(SONGS_PATH, songs);
      firedOutputs.clear();
      broadcast({ type: 'songs_updated', songs });
      break;
    }

    case 'save_config': {
      if (!verifyEdit(ws, msg)) return;
      const prevMtcPort   = config.mtcPort;
      const prevLtcDevice = String(config.ltcDevice ?? '');
      const prevLtcChannel = String(config.ltcChannel ?? '');
      config = { ...config, ...msg.config };
      saveJSON(CONFIG_PATH, config);
      broadcast({ type: 'config_updated', config: sanitiseConfig(config) });
      // Restart MTC listener if port changed
      if (config.mtcPort !== prevMtcPort) {
        try {
          const mtc = require('./tc/mtc');
          mtc.start((tc) => TC.receiveExternal(tc, 'mtc'), config.mtcPort);
          console.log(`[MTC] Switched to port: ${config.mtcPort}`);
        } catch (e) { console.log(`[MTC] Port switch failed: ${e.message}`); }
      }
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
      screens.set(msg.id, { ws, id: msg.id, name: msg.name, view: msg.view, slots: msg.slots, cameraType: msg.cameraType });
      broadcastScreensList();
      break;
    }

    case 'screen_update': {
      const s = screens.get(msg.id);
      if (s) { Object.assign(s, { name: msg.name, view: msg.view, slots: msg.slots, cameraType: msg.cameraType }); broadcastScreensList(); }
      break;
    }

    case 'screen_command': {
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

app.get('/api/midi/ports', (_req, res) => {
  try {
    const mtc = require('./tc/mtc');
    res.json({ ports: mtc.getPorts() });
  } catch (e) {
    res.json({ ports: [], error: e.message });
  }
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
    { key: 'mtc', path: './tc/mtc', priority: 2 },
    { key: 'rtpmidi', path: './tc/rtp-midi', priority: 3 },
    { key: 'artnet', path: './tc/artnet', priority: 4 },
    { key: 'ltc', path: './tc/ltc', priority: 5 }
  ];
  for (const mod of modules) {
    try {
      const m = require(mod.path);
      if (mod.key === 'mtc') {
        m.start((tc) => TC.receiveExternal(tc, 'mtc'), config.mtcPort);
      } else if (mod.key === 'ltc') {
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
const PORT = process.env.PORT || config.port || 3001;
server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║   Synthony Cue System                ║`);
  console.log(`║   http://localhost:${PORT}               ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
  loadTCModules();
  TC.start('00:00:00:00');
});
