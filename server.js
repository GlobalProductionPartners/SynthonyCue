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

// Full config schema with defaults. Merged over the saved file so EVERY setting
// key always exists on `config` — a show save/export then carries all of them
// (incl. the logo) even for values the operator never touched.
const CONFIG_DEFAULTS = {
  port: 3001,
  editPassword: 'synthony',
  oscDestinations: {},
  artnetDestinations: {},
  tcSource: 'internal',
  artnetInterface: 'all',
  // Subtle logo shown (dimmed) on blacked-out displays; a data: URL or ''.
  logo: '',
  // Cue hold: how long a fired cue stays on screen. cueHoldMode/cueHoldSeconds
  // are the default; cueHold overrides it per cue-type — { type: {mode,seconds} }.
  cueHoldMode: 'timed',
  cueHoldSeconds: 5,
  cueHold: {},
  // Time-of-day clock on the displays: an IANA timezone name, e.g.
  // "Pacific/Auckland" or "Europe/London". '' = each display uses its own
  // local clock.
  todTimezone: '',
  // Video source — anything ffmpeg can open. The Zowietek encoder's
  // secondary (720p) stream is the intended input; the 4K main stream costs
  // far more to decode for no gain on a cue display.
  //   rtsp://<encoder-ip>/stream1
  //   lavfi:testsrc2=size=1280x720:rate=25   (built-in test pattern)
  videoSource: '',
  videoWidth: 1280,
  videoFps: 15,
  videoQuality: 6,
  // Server-side spoken cue calling (this Pi's own audio out → comms). Off by
  // default; departments are keyed by cue-type column name. Style per dept:
  // 'sg' standby→go, 'sr' standby→read cue, 'go' go-only, 'ro' read-cue-only.
  readout: { enabled: false, lead: 10, voice: 'en', rate: 175, depts: {} }
};
let config = { ...CONFIG_DEFAULTS, ...loadJSON(CONFIG_PATH, {}) };

// Normalised just below, once LEGACY_FIELD_NAMES and normalizeSongs exist
// (const declarations aren't hoisted, so the call can't precede them).
let songs = loadJSON(SONGS_PATH, []);

// Cue content is spreadsheet-driven and lives in cue.extra keyed by column
// name; outputs live in cue.triggers (an array). Older show files used fixed
// fields (stageCue/hostCue/…) and single cue.osc / cue.artnet objects — fold
// those into the new shape on the way in. Idempotent: safe to run repeatedly.
const LEGACY_FIELD_NAMES = {
  stageCue: 'Stage Cue', hostCue: 'Host Cue', conductorCue: 'Conductor Cue',
  cameraCue: 'Camera Cue', description: 'Description',
};
function normalizeCue(cue) {
  if (!cue || typeof cue !== 'object') return cue;
  // Fixed fields → extra columns (preserving a sensible left-to-right order).
  const hasLegacyField = Object.keys(LEGACY_FIELD_NAMES).some(k => k in cue);
  if (hasLegacyField || typeof cue.extra !== 'object' || cue.extra === null) {
    const merged = {};
    for (const [key, name] of Object.entries(LEGACY_FIELD_NAMES)) {
      const v = typeof cue[key] === 'string' ? cue[key].trim() : '';
      if (v && !(name in merged)) merged[name] = v;
      delete cue[key];
    }
    for (const k in (cue.extra || {})) if (!(k in merged)) merged[k] = cue.extra[k];
    cue.extra = merged;
  }
  // Single osc/artnet objects → triggers array.
  if (!Array.isArray(cue.triggers)) {
    const trigs = [];
    if (cue.osc && (cue.osc.enabled || cue.osc.destination || cue.osc.address))
      trigs.push({ kind: 'osc', ...cue.osc });
    if (cue.artnet && (cue.artnet.enabled || cue.artnet.destination))
      trigs.push({ kind: 'artnet', ...cue.artnet });
    cue.triggers = trigs;
  }
  delete cue.osc; delete cue.artnet;
  cue.triggers = cue.triggers.map(t => ({ enabled: !!t.enabled, preRollFrames: 0, ...t, kind: t.kind || 'osc' }));
  return cue;
}
function normalizeSongs(list) {
  for (const song of (Array.isArray(list) ? list : []))
    for (const cue of (song.cues || [])) normalizeCue(cue);
  return Array.isArray(list) ? list : [];
}
// First non-empty cue field — a human label for logs.
function cueLabel(cue) {
  for (const k in (cue.extra || {})) if (cue.extra[k]) return cue.extra[k];
  return '';
}

// Mirror of public/cue-utils.js speakable(): ALL-CAPS words are spelled out by
// most TTS voices, so title-case them and drop punctuation that reads badly.
function speakableText(s) {
  return String(s == null ? '' : s)
    .replace(/[{}\[\]|<>]/g, ' ')
    .replace(/\b[A-Z][A-Z0-9]+\b/g, w => w.charAt(0) + w.slice(1).toLowerCase())
    .replace(/\s+/g, ' ')
    .trim();
}
normalizeSongs(songs);   // migrate legacy show files loaded above, in place

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

// ── OTA updates ───────────────────────────────────────────────────────────────
// The admin uploads a bundle; the server verifies it, extracts it over its
// own install directory, refreshes deps, and exits — systemd's
// Restart=always brings it back on the new code, so no sudo is ever needed.
// Clients pull the same stored bundle on a timer (deploy/synthony-update.sh).
const UPDATES_DIR = path.join(DATA_DIR, 'updates');
const RUNNING_VERSION = (() => {
  try { return fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim(); }
  catch { return 'dev'; }
})();
// Validate a bundle buffer and store it as the fleet's latest. The VERSION
// inside the tarball is authoritative no matter where the bytes came from.
function storeBundle(buffer) {
  const { execFileSync } = require('child_process');
  fs.mkdirSync(UPDATES_DIR, { recursive: true });
  const tmp = path.join(UPDATES_DIR, 'incoming.tar.gz');
  fs.writeFileSync(tmp, buffer);
  try {
    const list = execFileSync('tar', ['tzf', tmp], { timeout: 30000 }).toString();
    if (!/\/server\.js$/m.test(list) || !/\/VERSION$/m.test(list)) {
      throw new Error('Not a Synthony bundle (missing server.js/VERSION)');
    }
    const vline = execFileSync('bash', ['-c', `tar xzOf ${JSON.stringify(tmp)} --wildcards '*/VERSION' | head -1`], { timeout: 30000 }).toString().trim();
    fs.renameSync(tmp, path.join(UPDATES_DIR, 'latest.tar.gz'));
    fs.writeFileSync(path.join(UPDATES_DIR, 'latest.version'), vline);
    return vline;
  } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}

// Resolve an update source to a downloadable bundle URL.
//   github:owner/repo  or  https://github.com/owner/repo
//     → latest release asset matching *.tar.gz (config.updateToken for private)
//   any other https://…tar.gz → used directly
async function resolveUpdateSource(src) {
  const gh = /^(?:github:|https?:\/\/github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(src).trim());
  if (!gh) return { url: String(src).trim(), headers: {} };
  const headers = { 'User-Agent': 'synthony-cue', 'Accept': 'application/vnd.github+json' };
  if (config.updateToken) headers['Authorization'] = `Bearer ${config.updateToken}`;
  const rel = await fetch(`https://api.github.com/repos/${gh[1]}/${gh[2]}/releases/latest`, { headers });
  if (!rel.ok) throw new Error(`GitHub: ${rel.status} ${rel.statusText} for ${gh[1]}/${gh[2]}`);
  const j = await rel.json();
  const asset = (j.assets || []).find(a => /\.tar\.gz$/.test(a.name));
  if (!asset) throw new Error(`Release ${j.tag_name} has no .tar.gz asset`);
  // Private repos must download via the API asset URL with octet-stream.
  if (config.updateToken) {
    return { url: asset.url, headers: { ...headers, 'Accept': 'application/octet-stream' }, tag: j.tag_name, name: asset.name };
  }
  return { url: asset.browser_download_url, headers: {}, tag: j.tag_name, name: asset.name };
}

function latestUploaded() {
  try {
    const f = path.join(UPDATES_DIR, 'latest.tar.gz');
    if (!fs.existsSync(f)) return null;
    const v = fs.readFileSync(path.join(UPDATES_DIR, 'latest.version'), 'utf8').trim();
    return { file: f, version: v, size: fs.statSync(f).size };
  } catch { return null; }
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
      // Activity Monitor's "Memory Used" = App Memory (anonymous − purgeable)
      // + wired + compressed. active+wired+compressed under-reports ~10%.
      const usedPages = g('Anonymous pages') - g('Pages purgeable')
                      + g('Pages wired down') + g('Pages occupied by compressor');
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
const pendingHostCommands = new Map();  // host → [ 'reboot', ... ] delivered on next report

// ── Time source ───────────────────────────────────────────────────────────────
// The field network has no internet/NTP and the Pis have no RTC, so their wall
// clocks are wrong. Instead of setting each Pi, the admin browser (which always
// has the right time) tells the server the real time; the server broadcasts it
// to every display so ALL of them — Pi kiosks and web displays (iPads etc.) —
// show one shared, correct Time of Day. clockOffsetMs is (real - this box's clock).
let clockOffsetMs = 0;
function nowMs() { return Date.now() + clockOffsetMs; }

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
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    // HTML/CSS/JS must revalidate on every load — a kiosk Pi nobody
    // hard-refreshes has to pick up changes on plain reload. ETags make the
    // revalidation a cheap 304, not a re-download.
    if (/\.(html|css|js)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    } else if (/[\\/]fonts[\\/]/.test(filePath)) {
      // Fonts change filename when they change identity — cache hard.
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

// ── WebSocket ─────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });
const clients = new Set();
const screens = new Map(); // screenId → { ws, name, view, slots, cameraType }

// Remembered per-screen selection, keyed by NAME (not the sessionStorage screen
// id, which changes on a browser restart). So the server can re-push a screen
// its last view + cue-type selection when it reconnects — even a tablet that
// lost its localStorage or a Pi that reloaded — instead of it quietly reverting
// to a default mid-show. Persisted so it also survives a server restart.
const SCREEN_PREFS_PATH = path.join(DATA_DIR, 'data', 'screen-prefs.json');
const screenPrefs = new Map(Object.entries(loadJSON(SCREEN_PREFS_PATH, {})));
let _prefsSaveTimer = null;
function saveScreenPrefsSoon() {
  if (_prefsSaveTimer) return;
  _prefsSaveTimer = setTimeout(() => { _prefsSaveTimer = null; try { saveJSON(SCREEN_PREFS_PATH, Object.fromEntries(screenPrefs)); } catch {} }, 1500);
  _prefsSaveTimer.unref?.();
}
function screenSel(m) {
  return { view: m.view, slots: m.slots, hostSlots: m.hostSlots, cameraType: m.cameraType,
           ovCueType: m.ovCueType, wfCueType: m.wfCueType, ovScope: m.ovScope };
}
function rememberScreen(name, m) {
  if (!name) return;
  const sel = screenSel(m);
  const prev = screenPrefs.get(name);
  if (prev && JSON.stringify(prev) === JSON.stringify(sel)) return;   // unchanged
  screenPrefs.set(name, sel);
  saveScreenPrefsSoon();
}

function screensList() {
  return Array.from(screens.values()).map(s => ({
    id: s.id, name: s.name, view: s.view, slots: s.slots, cameraType: s.cameraType,
    ip: s.ip || null,   // lets a display Pi's OLED match its own screen entry
    ovCueType: s.ovCueType || 'any',
    wfCueType: s.wfCueType || 'any',
    ovScope: s.ovScope || 'song',
    lastSeen: s.lastSeen || null
  }));
}
function broadcastScreensList() {
  broadcast({ type: 'screens_list', screens: screensList() });
}

// "Clients" = display Pis that are actually up and running — they POST telemetry
// via the stats agent (a browser tab or the server itself never does), so the
// fresh remoteStats entries are the real count. A Pi that misses three reports
// (~30s) is treated as gone. This is what the front-panel OLED shows.
const CLIENT_FRESH_MS = 30000;
function liveClientCount() {
  const cutoff = Date.now() - CLIENT_FRESH_MS;
  let n = 0;
  for (const r of remoteStats.values()) if (r.at >= cutoff) n++;
  return n;
}
let _lastClientCount = -1;
function broadcastClients(force = false) {
  const n = liveClientCount();
  if (force || n !== _lastClientCount) { _lastClientCount = n; broadcast({ type: 'clients', count: n }); }
}

wss.on('connection', (ws, req) => {
  clients.add(ws);
  // Remember the peer's LAN IP so a display Pi's OLED can find its own screen
  // entry (it matches this against its local addresses). Strip the IPv6-mapped
  // prefix Node hands back for IPv4 peers.
  ws._remoteIp = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  // Auto-auth WebSocket connections that carry a valid session cookie
  if (isAuthedReq(req)) authedClients.set(ws, true);
  safeSend(ws, { type: 'init', songs, config: sanitiseConfig(config), tc: TC.state(), blackout });
  // Screens only announced themselves on connect, so an admin opened after
  // the displays were already running saw an empty list until one of them
  // joined or dropped. Send the current list to every new client.
  safeSend(ws, { type: 'screens_list', screens: screensList() });
  safeSend(ws, { type: 'clients', count: liveClientCount() });
  safeSend(ws, { type: 'server_time', epoch: nowMs() });   // one shared time source for all displays

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
  const { editPassword, sessionSecret, updateToken, ...safe } = cfg;
  return safe;
}

// Restore settings carried by a loaded/imported show. The incoming object is
// already sanitised (no password/session secret), so merging it can't leak or
// clobber credentials. `port` stays machine-bound; we refresh the video pipeline
// if its source changed but leave live TC/network listeners as the box runs them
// (loading a show must never knock a running rig off its timecode source).
function applyLoadedSettings(settings) {
  const { port, ...safe } = settings || {};
  const prevVideo = config.videoSource;
  config = { ...config, ...safe };
  saveJSON(CONFIG_PATH, config);
  broadcast({ type: 'config_updated', config: sanitiseConfig(config) });
  if (config.videoSource !== prevVideo) {
    try { Video.configure(config, broadcastVideoStatus); Video.restart(); broadcast({ type: 'video_reload' }); }
    catch (e) { console.warn('[Show] video refresh:', e.message); }
  }
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
const spokenCalls = new Set();   // server readout: `${cueId}:${type}:${phase}` said once
let lastBroadcastFrames = 0;
const FRAME_RATE_FIRE_WINDOW = 250; // 10s at 25fps — late allowance, not a drop window
const READOUT_WINDOW = 50;          // 2s — speech mustn't dump a burst after a seek

function checkCueFires(nowFrames) {
  // Reset on TC jump backwards
  if (nowFrames < lastBroadcastFrames - 50) {
    firedOutputs.clear();
    spokenCalls.clear();
    try { require('./output/tts').flush(); } catch {}
    console.log('[TC] Jump detected — cleared fired outputs');
  }
  lastBroadcastFrames = nowFrames;

  const ro = config.readout;
  const roOn = ro && ro.enabled;
  const leadFrames = Math.max(0, (ro?.lead || 10)) * 25;

  for (const song of songs) {
    const songFrames = TC.parse(song.timecode || '00:00:00:00');
    for (const cue of (song.cues || [])) {
      const cueFrames = songFrames + TC.parse(cue.offset || '00:00:00:00');

      // Every cue can carry any number of triggers. Each is keyed by cue id +
      // its index so one cue's triggers fire independently.
      cueTriggers(cue).forEach((trig, ti) => {
        if (!trig || !trig.enabled) return;
        const key    = `${cue.id}-${ti}`;
        const fireAt = cueFrames - (trig.preRollFrames || 0);
        // Fire on threshold-crossing with a 10s late allowance: a GC pause or
        // busy Pi must delay a trigger, never silently drop it. The ceiling
        // stops a large TC seek from replaying ancient cues.
        if (nowFrames >= fireAt && nowFrames < fireAt + FRAME_RATE_FIRE_WINDOW && !firedOutputs.has(key)) {
          firedOutputs.add(key);
          if (nowFrames > fireAt + 5) flightLog('LATE-FIRE', `${trig.kind} cue ${cue.id} ${(nowFrames - fireAt)} frames late`);
          fireTrigger(cue, trig);
        }
      });

      // Server readout: speak standby/go for each enabled department this cue
      // has text in. Same threshold-crossing model as triggers, tighter window.
      if (roOn) {
        for (const type in (cue.extra || {})) {
          const text = cue.extra[type];
          const dept = ro.depts?.[type];
          if (!text || !dept || !dept.on) continue;
          const style = dept.style || 'sg';
          const hasStandby = style === 'sg' || style === 'sr';
          const cross = (at, phase, line) => {
            const k = `${cue.id}:${type}:${phase}`;
            if (nowFrames >= at && nowFrames < at + READOUT_WINDOW && !spokenCalls.has(k)) {
              spokenCalls.add(k);
              speakReadout(line);
            }
          };
          // Spoken lines omit the department name — just "Standby, <cue>" / "Go".
          const spoken = speakableText(text);
          if (hasStandby) cross(cueFrames - leadFrames, 'sb', `Standby, ${spoken}`);
          const goLine = (style === 'sr' || style === 'ro') ? spoken : 'Go';
          cross(cueFrames, 'go', goLine);
        }
      }
    }
  }
}

// Speak a server-readout line out the Pi's audio via espeak-ng (best-effort).
function speakReadout(line) {
  try {
    require('./output/tts').speak(line, { voice: config.readout?.voice, rate: config.readout?.rate });
    flightLog('READOUT', line);
  } catch (e) { console.warn('[Readout]', e.message); }
}

// A cue's outputs. Kept tolerant of legacy shapes (cue.osc / cue.artnet) so a
// stale file that skipped normalisation still fires.
function cueTriggers(cue) {
  if (Array.isArray(cue.triggers)) return cue.triggers;
  const out = [];
  if (cue.osc)    out.push({ kind: 'osc',    ...cue.osc });
  if (cue.artnet) out.push({ kind: 'artnet', ...cue.artnet });
  return out;
}

// ── Output modules ────────────────────────────────────────────────────────────
let oscModule = null;
try { oscModule = require('./output/osc'); } catch {}
let artnetModule = null;
try { artnetModule = require('./output/artnet-out'); } catch {}

// Fire one trigger of any kind. New kinds slot in here without touching the
// engine above.
function fireTrigger(cue, trig) {
  if (trig.kind === 'osc') {
    const dest = config.oscDestinations?.[trig.destination];
    if (!dest) { logOutput('osc', cue.id, false, `Unknown destination: ${trig.destination}`); return; }
    if (!oscModule) { logOutput('osc', cue.id, false, 'OSC module not available'); return; }
    oscModule.send(dest.host, dest.port, trig.address, trig.args,
      (err) => logOutput('osc', cue.id, !err, err?.message));
  } else if (trig.kind === 'artnet') {
    const dest = config.artnetDestinations?.[trig.destination];
    if (!dest) { logOutput('artnet', cue.id, false, `Unknown destination: ${trig.destination}`); return; }
    if (!artnetModule) { logOutput('artnet', cue.id, false, 'ArtNet module not available'); return; }
    artnetModule.send(dest.host, trig.universe, trig.channel, trig.value,
      (err) => logOutput('artnet', cue.id, !err, err?.message));
  } else {
    logOutput(trig.kind || 'trigger', cue.id, false, `Unknown trigger kind: ${trig.kind}`);
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
      if (msg.transport)          config.videoTransport = msg.transport === 'udp' ? 'udp' : 'tcp';
      saveJSON(CONFIG_PATH, config);
      Video.configure(config, broadcastVideoStatus);
      Video.restart();
      broadcast({ type: 'config_updated', config: sanitiseConfig(config) });
      // The server's ffmpeg just restarted on the new params, so every
      // client's existing MJPEG connection is now stale. Force video views to
      // re-establish immediately rather than wait for the error-retry.
      broadcast({ type: 'video_reload' });
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
      // Save the WHOLE show: songs + every setting (incl. logo). Secrets
      // (password, session secret, update token) are stripped by sanitiseConfig
      // so a show file is safe to copy between machines.
      saveJSON(path.join(SHOWS_DIR, slug + '.json'), { version: 1, savedAt: new Date().toISOString(), songs, settings: sanitiseConfig(config) });
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
        const bundle = readShowBundle(file);
        songs = normalizeSongs(bundle.songs);
        saveJSON(SONGS_PATH, songs);      // loading a show IS the new live state
        firedOutputs.clear();
        // Restore the show's settings too (cue-hold, readout, logo, video, …).
        if (bundle.settings) applyLoadedSettings(bundle.settings);
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
      cueTriggers(fired.cue).forEach((trig, ti) => {
        if (!trig || !trig.enabled) return;
        firedOutputs.add(`${fired.cue.id}-${ti}`);
        fireTrigger(fired.cue, trig);
      });
      flightLog('MANUAL-FIRE', `cue ${fired.cue.id} (${cueLabel(fired.cue)})`);
      broadcast({ type: 'manual_cue', cue: fired.cue, songId: fired.song.id, atFrames: TC.currentFrames() });
      break;
    }

    case 'save_songs': {
      if (!verifyEdit(ws, msg)) return;
      songs = normalizeSongs(msg.songs);
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

    case 'set_time': {
      // The admin browser is the trusted clock source (it always has the real
      // time). Record its offset from this box's clock and push the shared time
      // to every display at once — Pi kiosks and web displays alike.
      if (!verifyEdit(ws, msg)) return;
      const e = Number(msg.epoch);
      if (Number.isFinite(e)) { clockOffsetMs = e - Date.now(); broadcast({ type: 'server_time', epoch: nowMs() }); }
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

    case 'test_readout': {
      // Speak a line immediately out the server's audio — proves the espeak-ng
      // path + audio wiring without waiting for a cue.
      if (!verifyEdit(ws, msg)) return;
      const line = String(msg.text || 'Synthony cue readout test. Stage, go.').slice(0, 200);
      try {
        require('./output/tts').speak(line, { voice: config.readout?.voice, rate: config.readout?.rate });
        safeSend(ws, { type: 'readout_test', ok: true });
      } catch (e) { safeSend(ws, { type: 'readout_test', ok: false, error: e.message }); }
      break;
    }

    case 'screen_hello': {
      screens.set(msg.id, { ws, id: msg.id, name: msg.name, view: msg.view, slots: msg.slots, hostSlots: msg.hostSlots, cameraType: msg.cameraType, ovCueType: msg.ovCueType, wfCueType: msg.wfCueType, ovScope: msg.ovScope, ip: ws._remoteIp, lastSeen: Date.now() });
      flightLog('SCREEN-CONNECTED', `${msg.name} (${msg.id})`);
      // Restore this screen's remembered selection, or (first time we see the
      // name) remember what it arrived with.
      const pref = screenPrefs.get(msg.name);
      if (pref) safeSend(ws, { type: 'screen_command', ...pref });
      else rememberScreen(msg.name, msg);
      broadcastScreensList();
      break;
    }

    case 'screen_update': {
      const s = screens.get(msg.id);
      if (s) { Object.assign(s, { name: msg.name, view: msg.view, slots: msg.slots, hostSlots: msg.hostSlots, cameraType: msg.cameraType, ovCueType: msg.ovCueType, wfCueType: msg.wfCueType, ovScope: msg.ovScope, ip: ws._remoteIp || s.ip, lastSeen: Date.now() }); broadcastScreensList(); }
      rememberScreen(msg.name, msg);   // keep the per-name pref current
      break;
    }

    case 'screen_command': {
      if (!verifyEdit(ws, msg)) return;
      const target = screens.get(msg.targetId);
      console.log(`[Screen] Command → ${msg.targetId} (${target ? 'found, state=' + target.ws.readyState : 'NOT FOUND'}) view=${msg.view}`);
      console.log(`[Screen] Known screens: ${[...screens.keys()].join(', ') || 'none'}`);
      if (target?.ws?.readyState === 1) safeSend(target.ws, { type: 'screen_command', view: msg.view, slots: msg.slots, hostSlots: msg.hostSlots, cameraType: msg.cameraType, ovCueType: msg.ovCueType, wfCueType: msg.wfCueType, ovScope: msg.ovScope });
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
// A show file is either a bare songs array (legacy) or a full bundle
// { version, songs, settings } — settings carries every non-secret config
// value (incl. the logo). Read both shapes uniformly.
function readShowBundle(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(parsed)) return { songs: parsed, settings: null };
  return { songs: parsed.songs || [], settings: parsed.settings || null };
}
app.get('/api/shows', (_req, res) => {
  try {
    fs.mkdirSync(SHOWS_DIR, { recursive: true });
    const list = fs.readdirSync(SHOWS_DIR).filter(f => f.endsWith('.json')).map(f => {
      const st = fs.statSync(path.join(SHOWS_DIR, f));
      let count = 0;
      try { count = readShowBundle(path.join(SHOWS_DIR, f)).songs.length; } catch {}
      return { name: f.slice(0, -5), savedAt: st.mtime.toISOString(), songs: count };
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
  // Number(null) === 0 — a missing metric must render as —, never as 0.
  const num = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
  remoteStats.set(host, {
    host, role: 'display',
    cpu: num(b.cpu), load: num(b.load),
    memUsedMB: num(b.memUsedMB), memTotalMB: num(b.memTotalMB),
    temp: num(b.temp),
    disk: b.disk && num(b.disk.freeMB) != null ? { freeMB: num(b.disk.freeMB), totalMB: num(b.disk.totalMB) } : null,
    uptimeSec: num(b.uptimeSec),
    at: Date.now()
  });
  broadcastClients();   // a fresh report may change the live client count
  const cmds = pendingHostCommands.get(host) || [];
  pendingHostCommands.delete(host);
  if (cmds.length) flightLog('AGENT-COMMAND', `${host} <- ${cmds.join(',')}`);
  res.json({ ok: true, commands: cmds });
});
// Re-evaluate periodically so a Pi that stops reporting drops out of the count.
setInterval(() => broadcastClients(), 10000).unref?.();
// Re-broadcast the shared time so displays stay aligned and late-joiners sync.
setInterval(() => broadcast({ type: 'server_time', epoch: nowMs() }), 15000).unref?.();

// Admin: reboot a machine (queued for its stats agent) or reload a screen's
// browser (immediate, via the screen socket). action: 'reboot' | 'reload'.
app.post('/api/system/restart', (req, res) => {
  if (!isAuthedReq(req)) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const action = req.body?.action === 'reload' ? 'reload' : 'reboot';
  const host   = String(req.body?.host || '').slice(0, 60);
  const screenId = String(req.body?.screenId || '');

  if (action === 'reload') {
    // Reload every screen registered on this host (both displays of a Pi),
    // or one specific screen if given.
    let n = 0;
    for (const sc of screens.values()) {
      const match = screenId ? sc.id === screenId : (host && (sc.name || '').replace(/-\d+$/, '') === host);
      if (match && sc.ws?.readyState === 1) { safeSend(sc.ws, { type: 'reload' }); n++; }
    }
    flightLog('SCREEN-RELOAD', host || screenId);
    res.json({ ok: true, action, reloaded: n });
    return;
  }

  // reboot: the server can reboot itself; others go via their stats agent.
  if (!host) { res.status(400).json({ error: 'host required' }); return; }
  if (host === os.hostname().replace(/\.local$/i, '')) {
    // Rebooting the server drops every display until it returns — never do it
    // on a bare host match. The admin must pass confirmSelf:true, which it only
    // sends after a dedicated "reboot the SERVER?" dialog. This makes a stray
    // or misrouted command incapable of taking the show down.
    if (req.body?.confirmSelf !== true) {
      res.status(409).json({ error: 'Server reboot needs confirmSelf:true', isServer: true }); return;
    }
    flightLog('REBOOT-SELF');
    res.json({ ok: true, action, self: true });
    const { execFile } = require('child_process');
    setTimeout(() => execFile('sudo', ['-n', 'reboot'], () => {}), 800);
    return;
  }
  pendingHostCommands.set(host, ['reboot']);
  flightLog('REBOOT-QUEUED', host);
  res.json({ ok: true, action, queued: host });
});

// ── Shutdown All ──────────────────────────────────────────────────────────────
// Power off every beacon (remotes + displays), then — ONLY once the server has
// verified they've all gone dark — power off the server itself. A beacon proves
// it's off by going silent: its stats agent runs the poweroff and never POSTs
// telemetry again, so the server watches remoteStats go stale. It reports live
// progress to the admin and holds its own shutdown while anything is still
// alive; past a timeout it stops and waits for the admin (force / cancel) rather
// than ever stranding a running beacon or killing the show without confirmation.
let shutdownAll = null;                       // null | { startedAt, commanded:Set, phase, clearCount, timer }
const SHUTDOWN_BEACON_STALE_MS = 25000;       // no telemetry this long → beacon is off
const SHUTDOWN_TIMEOUT_MS = 4 * 60 * 1000;    // past this, hold and hand it to the admin
const SHUTDOWN_SERVER_GRACE_MS = 4000;        // let the "all off" broadcast land before we go dark

function aliveBeacons() {
  const cutoff = Date.now() - SHUTDOWN_BEACON_STALE_MS;
  const live = [];
  for (const r of remoteStats.values()) if (r.at >= cutoff) live.push(r.host);
  return live.sort();
}
function broadcastShutdown(extra = {}) {
  broadcast({ type: 'shutdown_status', phase: shutdownAll ? shutdownAll.phase : 'idle',
    pending: aliveBeacons(), total: shutdownAll ? shutdownAll.commanded.size : 0,
    elapsedMs: shutdownAll ? Date.now() - shutdownAll.startedAt : 0, ...extra });
}
function serverPowerOff() {
  flightLog('SHUTDOWN-SELF', 'all beacons verified off');
  broadcast({ type: 'shutdown_status', phase: 'server_off', pending: [],
    total: shutdownAll ? shutdownAll.commanded.size : 0 });
  const { execFile } = require('child_process');
  setTimeout(() => execFile('sudo', ['-n', 'poweroff'], () => {}), SHUTDOWN_SERVER_GRACE_MS);
}
function shutdownTick() {
  if (!shutdownAll) return;
  // Also command any beacon that's alive but not yet told (e.g. one that came
  // back after we started) so nothing is left running.
  for (const host of aliveBeacons()) {
    if (!shutdownAll.commanded.has(host)) { pendingHostCommands.set(host, ['shutdown']); shutdownAll.commanded.add(host); }
  }
  const pending = aliveBeacons();
  broadcastShutdown();
  if (pending.length === 0) {
    // Require two clean ticks so a single missed report can't fake "all off".
    if (++shutdownAll.clearCount >= 2) {
      shutdownAll.phase = 'all_off';
      clearInterval(shutdownAll.timer);
      serverPowerOff();
    }
  } else {
    shutdownAll.clearCount = 0;
    if (Date.now() - shutdownAll.startedAt > SHUTDOWN_TIMEOUT_MS && shutdownAll.phase !== 'timeout') {
      shutdownAll.phase = 'timeout';   // hold — the admin decides (force / cancel)
      broadcastShutdown();
    }
  }
}
// Start: shut down every beacon, then the server once they're all confirmed off.
app.post('/api/system/shutdown-all', (req, res) => {
  if (!isAuthedReq(req)) { res.status(401).json({ error: 'Unauthorized' }); return; }
  if (shutdownAll) { res.json({ ok: true, already: true, phase: shutdownAll.phase }); return; }
  const commanded = new Set();
  for (const host of aliveBeacons()) { pendingHostCommands.set(host, ['shutdown']); commanded.add(host); }
  shutdownAll = { startedAt: Date.now(), commanded, phase: 'shutting_down', clearCount: 0, timer: null };
  flightLog('SHUTDOWN-ALL', `commanded ${commanded.size} beacon(s)`);
  shutdownAll.timer = setInterval(shutdownTick, 3000);
  broadcastShutdown();
  res.json({ ok: true, commanded: Array.from(commanded) });
});
// Stop waiting and power the server off now (explicit admin choice at the timeout).
app.post('/api/system/shutdown-all/force', (req, res) => {
  if (!isAuthedReq(req)) { res.status(401).json({ error: 'Unauthorized' }); return; }
  if (shutdownAll && shutdownAll.timer) clearInterval(shutdownAll.timer);
  shutdownAll = shutdownAll || { startedAt: Date.now(), commanded: new Set(), phase: 'forced' };
  shutdownAll.phase = 'forced';
  res.json({ ok: true, forced: true });
  serverPowerOff();
});
// Abort: keep the server up. Beacons already told to shut down can't be recalled.
app.post('/api/system/shutdown-all/cancel', (req, res) => {
  if (!isAuthedReq(req)) { res.status(401).json({ error: 'Unauthorized' }); return; }
  if (shutdownAll && shutdownAll.timer) clearInterval(shutdownAll.timer);
  const had = !!shutdownAll;
  shutdownAll = null;
  flightLog('SHUTDOWN-ALL-CANCEL');
  broadcast({ type: 'shutdown_status', phase: 'cancelled', pending: aliveBeacons(), total: 0 });
  res.json({ ok: true, cancelled: had });
});

// ── OTA endpoints ─────────────────────────────────────────────────────────────
const updateUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 1 }
});
app.get('/api/update/status', (_req, res) => {
  res.json({ running: RUNNING_VERSION, uploaded: latestUploaded() });
});
// Clients poll this: the stored bundle, if any.
app.get('/api/update/bundle', (_req, res) => {
  const up = latestUploaded();
  if (!up) { res.status(404).json({ error: 'No update uploaded' }); return; }
  res.setHeader('X-Bundle-Version', up.version);
  res.sendFile(up.file);
});
app.post('/api/update/upload', updateUpload.single('bundle'), (req, res) => {
  if (!isAuthedReq(req)) { res.status(401).json({ error: 'Unauthorized' }); return; }
  if (!req.file) { res.status(400).json({ error: 'No file' }); return; }
  try {
    const vline = storeBundle(req.file.buffer);
    flightLog('UPDATE-UPLOADED', vline);
    res.json({ ok: true, version: vline, running: RUNNING_VERSION });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Pull an update from a remote source (GitHub release or direct URL).
// Body: { url } — persisted to config so Check works with one click next time.
app.post('/api/update/check', async (req, res) => {
  if (!isAuthedReq(req)) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const src = String(req.body?.url || config.updateUrl || '').trim();
  if (!src) { res.status(400).json({ error: 'No update source configured' }); return; }
  if (req.body?.url && req.body.url !== config.updateUrl) {
    config.updateUrl = src; saveJSON(CONFIG_PATH, config);
  }
  try {
    const r = await resolveUpdateSource(src);
    const dl = await fetch(r.url, { headers: r.headers, redirect: 'follow' });
    if (!dl.ok) throw new Error(`Download: ${dl.status} ${dl.statusText}`);
    const buf = Buffer.from(await dl.arrayBuffer());
    if (buf.length > 200 * 1024 * 1024) throw new Error('Bundle too large');
    const vline = storeBundle(buf);
    flightLog('UPDATE-FETCHED', `${vline} from ${src}${r.tag ? ' (' + r.tag + ')' : ''}`);
    res.json({ ok: true, version: vline, running: RUNNING_VERSION, source: src, release: r.tag || null, sizeMB: +(buf.length / 1048576).toFixed(1) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.post('/api/update/apply', (req, res) => {
  if (!isAuthedReq(req)) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const up = latestUploaded();
  if (!up) { res.status(400).json({ error: 'No update uploaded' }); return; }
  try {
    const { execFileSync } = require('child_process');
    // Extract over the install dir. node_modules is not in bundles, and
    // extracting does not delete it — deps survive; npm fills any gaps.
    execFileSync('tar', ['xzf', up.file, '-C', __dirname, '--strip-components=1'], { timeout: 120000 });
    try { execFileSync('npm', ['install', '--omit=dev'], { cwd: __dirname, timeout: 300000 }); }
    catch (e) { console.warn('[Update] npm install:', e.message); }
    flightLog('UPDATE-APPLIED', `${RUNNING_VERSION} -> ${up.version}`);
    res.json({ ok: true, from: RUNNING_VERSION, to: up.version, restarting: true });
    // Exit AFTER the response flushes; systemd restarts us on the new code.
    setTimeout(() => { console.log('[Update] restarting on new code'); process.exit(0); }, 800);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
      rows.push({ Type: 'CUE', Offset: cue.offset, 'Cue Duration': cue.duration || '',
        // Every cue-type column round-trips under its own header, in sheet order.
        ...(cue.extra || {}),
        Triggers: (cue.triggers || []).filter(t => t.enabled).map(t => t.kind).join(', ') });
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

// Full show backup: songs + every setting (incl. the logo), safe to move
// between machines — sanitiseConfig strips the password/session secret. This is
// the same shape a saved show file uses, so it can be dropped into data/shows/
// and loaded, or re-imported via /api/import/show.
app.get('/api/export/show', (_req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="synthony-show.json"');
  res.json({ version: 1, exportedAt: new Date().toISOString(), songs, settings: sanitiseConfig(config) });
});

// Import a full show backup produced by /api/export/show (or a saved show file):
// applies songs and restores every setting (incl. logo). Auth-gated — it
// rewrites the live show and config.
app.post('/api/import/show', upload.single('file'), (req, res) => {
  if (!isAuthedReq(req)) { res.status(401).json({ error: 'Unauthorized' }); return; }
  if (!req.file) { res.status(400).json({ error: 'No file' }); return; }
  try {
    const parsed = JSON.parse(req.file.buffer.toString('utf8'));
    const bundle = Array.isArray(parsed) ? { songs: parsed, settings: null } : { songs: parsed.songs || [], settings: parsed.settings || null };
    songs = normalizeSongs(bundle.songs);
    saveJSON(SONGS_PATH, songs);
    firedOutputs.clear();
    if (bundle.settings) applyLoadedSettings(bundle.settings);
    flightLog('SHOW-IMPORTED', `${songs.length} songs${bundle.settings ? ' + settings' : ''}`);
    broadcast({ type: 'songs_updated', songs });
    res.json({ ok: true, songs: songs.length, settings: !!bundle.settings });
  } catch (e) { res.status(400).json({ error: 'Bad show file: ' + e.message }); }
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
    // Excel stores a time as a fraction of a 24h day (0.5 = 12:00:00). A sheet
    // exported "as values" hands us the text "HH:MM:SS:FF"; a live/formatted
    // sheet hands us that raw number instead (the cell only *displays* as a
    // timecode). Accept both so either kind of file imports — otherwise every
    // numeric timecode fails the split and the whole sheet is skipped.
    if (typeof s === 'number') {
      if (!isFinite(s)) return null;
      const frac = s - Math.floor(s);      // time-of-day (also tolerates date-time serials)
      return frac * 86400;                 // → seconds since 00:00:00
    }
    const str = String(s || '').trim();
    if (!str) return null;
    // Two text spellings appear in exports:
    //   HH:MM:SS:FF  — frames (0..FR-1) after a colon
    //   HH:MM:SS.ss  — sub-second after a DOT (decimal seconds, e.g. "05:41:17.97")
    // and plain HH:MM:SS. Split on ':' and read the last field accordingly.
    const parts = str.split(':');
    if (parts.length === 4) {
      const [h, m, sec, f] = parts.map(Number);
      if ([h, m, sec, f].some(Number.isNaN) || h > 23) return null;
      return h * 3600 + m * 60 + sec + f / FR;
    }
    if (parts.length === 3) {
      const h = Number(parts[0]), m = Number(parts[1]), sec = Number(parts[2]);   // "17.97" → 17.97s
      if ([h, m, sec].some(Number.isNaN) || h > 23) return null;
      return h * 3600 + m * 60 + sec;      // toTC() rounds decimal seconds to frames
    }
    return null;
  }

  function parseDurStr(s) {
    // "HH:MM:SS:FF" → "mm:ss" for storage; returns '' if zero/empty. Same dual
    // source as parseTCStr: a live sheet stores the duration as an Excel
    // day-fraction number, a values export stores the "HH:MM:SS" text.
    if (typeof s === 'number') {
      if (!isFinite(s)) return '';
      const totalSec = Math.round((s - Math.floor(s)) * 86400);
      if (totalSec === 0) return '';
      return Math.floor(totalSec / 60) + ':' + String(totalSec % 60).padStart(2, '0');
    }
    const str = String(s || '').trim();
    if (!str) return '';
    const parts = str.split(':').map(Number);
    if (parts.length < 3 || parts.some(isNaN)) return '';
    const totalSec = parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (totalSec === 0) return '';
    return Math.floor(totalSec / 60) + ':' + String(totalSec % 60).padStart(2, '0');
  }

  function blankCue(fields) {
    return { id: uid(), offset: '00:00:00:00', duration: '', extra: {}, triggers: [], ...fields };
  }

  // Cue types are entirely header-driven. Columns 0–3 are the structural
  // skeleton (TC / duration / track / BPM); every column from index 4 onward is
  // a cue type keyed by its header text ("Stage Cue", "Camera Cues / Key
  // Moments", "Lasers, Fire, Pyro", or anything the sheet adds). Order is
  // preserved so the editor shows columns in spreadsheet order.
  // First line only — sheet headers sometimes carry a multi-line legend
  // ("PLAYBACK / CONDUCTOR CUE\nBold markers are safety points…") that makes an
  // unwieldy cue-type name.
  const header = (rows[0] || []).map(x => String(x || '').split('\n')[0].trim());
  const FIRST_CUE_COL = 4;
  function extraFrom(r) {
    const ex = {};
    for (let c = FIRST_CUE_COL; c < header.length; c++) {
      const name = header[c];
      const val  = String(r[c] || '').trim();
      if (name && val) ex[name] = val;
    }
    return ex;
  }

  const result = [];
  let currentSong = null;
  const preShow = { id: uid(), timecode: '00:00:00:00', trackName: 'Pre-Show',
    duration: '', bpm: null, description: '', cues: [] };
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (i === 0) continue; // header row

    const tc        = parseTCStr(r[0]);
    const trackName = String(r[2] || '').trim();
    const duration  = parseDurStr(r[1]);
    const bpm       = parseInt(String(r[3] || '')) || null;
    const desc      = String(r[4] || '').trim();   // column 4 doubles as the track's own description
    const extra     = extraFrom(r);                // every cue-type column (index >= 4), in sheet order
    const hasContent = Object.keys(extra).length > 0;

    const isTransition = trackName.toLowerCase().startsWith('next track');
    const isTrack = trackName && !isTransition;

    if (isTrack) {
      if (tc === null) { errors.push(`Row ${i+1}: track "${trackName}" has no valid TC, skipped`); continue; }
      currentSong = { id: uid(), timecode: toTC(tc), trackName, duration, bpm,
        description: desc, cues: [] };
      result.push(currentSong);
      // Capture any cue content on the track row itself.
      if (hasContent) currentSong.cues.push(blankCue({ extra }));
      continue;
    }

    if (isTransition) {
      if (tc === null) { errors.push(`Row ${i+1}: transition "${trackName}" has no TC, skipped`); continue; }
      currentSong = { id: uid(), timecode: toTC(tc), trackName, duration, bpm: null,
        description: desc, cues: [], isTransition: true };
      result.push(currentSong);
      if (hasContent) currentSong.cues.push(blankCue({ extra }));
      continue;
    }

    // Cue row (empty track name)
    if (!hasContent) continue;
    if (tc === null) { errors.push(`Row ${i+1}: cue row has no TC, skipped`); continue; }
    const target = currentSong || preShow;
    const offset = Math.max(0, tc - tcToSec(target.timecode));
    target.cues.push(blankCue({ offset: toTC(offset), extra }));
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
// Advertise ONLY when running as the installed service (systemd sets
// SYNTHONY_DATA_DIR). A dev `npm start` must never advertise — otherwise a
// laptop on the show LAN becomes a rogue server that clients can latch onto.
try {
  if (!process.env.SYNTHONY_DATA_DIR && process.env.SYNTHONY_ADVERTISE !== '1') {
    throw new Error('not the installed service — mDNS advertising skipped (set SYNTHONY_ADVERTISE=1 to force)');
  }
  const { Bonjour } = require('bonjour-service');
  // CRITICAL: pass an error callback. bonjour-service's mDNS responder throws
  // asynchronously on multicast send failures (e.g. ENETUNREACH on 224.0.0.251
  // when the active interface has no multicast route — happens on our field
  // "shared" network before/while it settles). Its DEFAULT handler is
  // `throw err`, which is an UNCAUGHT exception that crashes the whole show
  // server — we saw it crash-loop ~200x in the field. Swallow+log instead:
  // discovery is best-effort (clients also fall back to the fixed field IP),
  // and a multicast hiccup must NEVER take the server down mid-show.
  _bonjour = new Bonjour({}, (err) => {
    console.log(`[mDNS] responder error (ignored, discovery is best-effort): ${(err && err.code) || err}`);
  });
  const svcName = `Synthony Cue (${require('os').hostname().replace(/\.local$/i, '')})`;
  _bonjour.publish({ name: svcName, type: 'synthony', port: Number(PORT) });
  console.log(`[mDNS] advertising "${svcName}" as _synthony._tcp on :${PORT}`);
  const stopAds = () => { try { _bonjour.unpublishAll(() => process.exit(0)); } catch { process.exit(0); } };
  process.on('SIGTERM', stopAds);
  process.on('SIGINT', stopAds);
} catch (e) {
  console.log(`[mDNS] advertising unavailable: ${e.message}`);
}

// Last-resort safety net for the show server: a transient network-send failure
// from a background socket (mDNS/dgram multicast on a flapping interface) must
// never crash the process. Swallow ONLY those specific socket error codes and
// re-throw anything else, so genuine bugs still surface loudly.
const BENIGN_NET_ERRNOS = new Set(['ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EADDRNOTAVAIL', 'EADDRINUSE']);
process.on('uncaughtException', (err) => {
  if (err && BENIGN_NET_ERRNOS.has(err.code)) {
    console.log(`[net] ignored transient socket error ${err.code} (${err.syscall || 'send'}) — server stays up`);
    return;
  }
  throw err;
});

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
