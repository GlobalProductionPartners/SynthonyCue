'use strict';
// Video source relay: ffmpeg pulls the encoder's stream and re-emits it as
// MJPEG, which is the only live format a browser will play with no plugin,
// no CDN library and no media-source plumbing.
//
// Why MJPEG rather than HLS:
//   - HLS adds 6-30s of latency. On a show that is unusable.
//   - hls.js would have to be bundled and served; a venue Pi has no internet.
//   - MJPEG is just <img src="...">, and decodes on any Chromium.
// The cost is bandwidth, which is fine on a LAN and is why the default pulls
// the encoder's 720p secondary stream rather than the 4K main one.
//
// Requires ffmpeg (already a dependency of the LTC decoder).

const { spawn } = require('child_process');

const SOI = Buffer.from([0xFF, 0xD8]); // JPEG start of image
const EOI = Buffer.from([0xFF, 0xD9]); // JPEG end of image

let proc       = null;
let restartT   = null;
let failures   = 0;
let running    = false;
let opts       = {};
let lastFrame  = null;
let lastFrameAt = 0;
const clients  = new Set();   // MJPEG responses — these receive multipart frames
const holders  = new Set();   // things keeping the pipeline warm but not consuming it
let onStatus   = null;

function status(state, detail) {
  if (onStatus) onStatus({ state, detail, clients: clients.size, hasFrame: !!lastFrame });
}

// ffmpeg args. `url` is anything ffmpeg can open, which includes rtsp://,
// srt://, udp://, http:// and the lavfi test patterns used for commissioning.
function buildArgs(url, o) {
  const args = [];
  const isNetwork = /^(rtsp|rtmp|rtmps|srt|udp|rtp|http|https):/i.test(url);

  if (/^rtsp:/i.test(url)) {
    // TCP is safer on congested show networks; UDP shaves latency but drops.
    args.push('-rtsp_transport', o.transport === 'udp' ? 'udp' : 'tcp');
    // Kill the RTSP jitter/reorder buffer — the single biggest latency source
    // on a LAN where packets don't actually reorder.
    args.push('-reorder_queue_size', '0', '-max_delay', '0');
  }
  if (isNetwork) {
    // Don't sit analysing the stream, and don't pre-buffer: show frames as
    // they arrive. probesize/analyzeduration low = fast first frame + no lead
    // buffer; nobuffer/low_delay = no decode-side queue.
    args.push('-fflags', 'nobuffer', '-flags', 'low_delay',
              '-avioflags', 'direct',
              '-probesize', '32', '-analyzeduration', '0');
  }
  // A live network source paces itself. Generators and files do not — without
  // -re ffmpeg races ahead and emits frames as fast as the CPU allows, which
  // saturates the link (measured: 116 Mbps from a 10fps test pattern).
  else args.push('-re');

  if (/^lavfi:/i.test(url)) args.push('-f', 'lavfi', '-i', url.replace(/^lavfi:/i, ''));
  else args.push('-i', url);

  args.push(
    '-an',                                   // cue displays never want audio
    '-vf', `scale=${o.width}:-2,fps=${o.fps}`,
    '-fps_mode', 'drop',                     // drop late frames, never queue them
    '-f', 'mjpeg',
    '-q:v', String(o.quality),               // 2 best … 31 worst
    '-'
  );
  return args;
}

function killProc() {
  if (proc) { try { proc.kill('SIGKILL'); } catch {} proc = null; }
  if (restartT) { clearTimeout(restartT); restartT = null; }
}

function scheduleRestart() {
  if (!running || restartT) return;
  failures++;
  const delay = Math.min(30000, 1000 * Math.pow(2, failures - 1));
  if (failures <= 3) console.warn(`[Video] source error — retrying in ${delay}ms`);
  else if (failures === 4) console.warn('[Video] source still failing — suppressing further errors until it recovers');
  status('error');
  restartT = setTimeout(() => { restartT = null; spawnFFmpeg(); }, delay);
}

function spawnFFmpeg() {
  if (!running) return;
  killProc();

  const args = buildArgs(opts.url, opts);
  try {
    proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    console.warn('[Video] spawn failed:', e.message);
    return scheduleRestart();
  }

  let buf = Buffer.alloc(0);
  proc.stdout.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    // Carve complete JPEGs out of the stream and fan them out.
    for (;;) {
      const start = buf.indexOf(SOI);
      if (start < 0) { if (buf.length > 2_000_000) buf = Buffer.alloc(0); break; }
      const end = buf.indexOf(EOI, start + 2);
      if (end < 0) {
        if (start > 0) buf = buf.subarray(start);
        // A single frame should never reach 8MB; if it does the stream is
        // desynced and holding the buffer would leak.
        if (buf.length > 8_000_000) buf = Buffer.alloc(0);
        break;
      }
      const frame = buf.subarray(start, end + 2);
      buf = buf.subarray(end + 2);
      if (failures) { failures = 0; console.log('[Video] source recovered'); status('live'); }
      lastFrame = frame;
      lastFrameAt = Date.now();
      for (const res of clients) writeFrame(res, frame);
    }
  });

  // ffmpeg is chatty on stderr; only surface it while diagnosing.
  proc.stderr.on('data', (d) => {
    if (opts.verbose) process.stderr.write('[Video/ffmpeg] ' + d.toString());
  });

  proc.on('error', () => scheduleRestart());
  proc.on('close', (code) => {
    if (!running) return;
    if (code !== 0) return scheduleRestart();
    scheduleRestart(); // a clean exit still means the source ended
  });

  console.log(`[Video] pulling ${opts.url} → MJPEG ${opts.width}px @ ${opts.fps}fps`);
  status('starting');
}

function writeFrame(res, frame) {
  // Latency control: if this client already has more than ~1.5 frames waiting
  // in its socket buffer, it is falling behind — drop this frame rather than
  // pile on. MJPEG has no inter-frame dependency, so a dropped frame costs
  // nothing and the viewer always sees the freshest available image. Without
  // this, a slightly-slow consumer accumulates seconds of lag (bufferbloat).
  if (res.writableLength > frame.length * 1.5) return;
  try {
    res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
    res.write(frame);
    res.write('\r\n');
  } catch { clients.delete(res); }
}

// ── Public API ───────────────────────────────────────────────────────────────

exports.configure = function configure(config, statusCb) {
  onStatus = statusCb || onStatus;
  opts = {
    url:     config.videoSource || '',
    width:   Math.min(1920, Math.max(160, parseInt(config.videoWidth) || 1280)),
    fps:     Math.min(60, Math.max(1, parseInt(config.videoFps) || 15)),
    quality: Math.min(31, Math.max(2, parseInt(config.videoQuality) || 6)),
    transport: config.videoTransport === 'udp' ? 'udp' : 'tcp',
    verbose: !!config.videoVerbose
  };
  return opts;
};

// The transcode only runs while something is watching — a cue display that is
// not on the video view should not cost a core.
function watchers() { return clients.size + holders.size; }

function ensureRunning() {
  if (running || !opts.url || !watchers()) return;
  running = true; failures = 0;
  spawnFFmpeg();
}
function stopIfIdle() {
  if (!watchers() && running) {
    running = false;
    killProc();
    lastFrame = null;
    console.log('[Video] no viewers — transcode stopped');
    status('idle');
  }
}

exports.stop = function stop() {
  running = false;
  killProc();
  lastFrame = null;
  for (const res of clients) { try { res.end(); } catch {} }
  clients.clear();
  status('idle');
};

exports.restart = function restart() {
  if (!running) return;
  failures = 0;
  spawnFFmpeg();
};

exports.state = function state() {
  return {
    url: opts.url || null,
    width: opts.width, fps: opts.fps, quality: opts.quality,
    running,
    viewers: clients.size,
    hasFrame: !!lastFrame,
    ageMs: lastFrame ? Date.now() - lastFrameAt : null
  };
};

// Probe a URL with ffprobe and report what is actually there. A cue display
// showing nothing is ambiguous — this turns "no picture" into a real answer
// before anyone switches a screen mid-show.
exports.probe = function probe(url, cb) {
  if (!url) return cb({ ok: false, error: 'No URL given' });
  const args = [];
  if (/^rtsp:/i.test(url)) args.push('-rtsp_transport', 'tcp');
  if (/^lavfi:/i.test(url)) args.push('-f', 'lavfi', '-i', url.replace(/^lavfi:/i, ''));
  else args.push('-i', url);
  args.push('-v', 'error', '-show_entries',
            'stream=codec_name,codec_type,width,height,avg_frame_rate',
            '-of', 'json');

  let proc;
  try { proc = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { return cb({ ok: false, error: 'ffprobe not available: ' + e.message }); }

  let out = '', err = '', done = false;
  const finish = (r) => { if (done) return; done = true; try { proc.kill('SIGKILL'); } catch {} cb(r); };
  // ffprobe can sit on a dead host far longer than an operator will wait.
  const timer = setTimeout(() => finish({ ok: false, error: 'Timed out after 12s — host unreachable or not a stream' }), 12000);

  proc.stdout.on('data', d => out += d);
  proc.stderr.on('data', d => err += d);
  proc.on('error', e => { clearTimeout(timer); finish({ ok: false, error: e.message }); });
  proc.on('close', () => {
    clearTimeout(timer);
    let info = null;
    try { info = JSON.parse(out); } catch {}
    const v = info && (info.streams || []).find(st => st.codec_type === 'video');
    if (!v) return finish({ ok: false, error: (err.trim().split('\n').pop() || 'No video stream found') });
    let fps = null;
    if (v.avg_frame_rate && v.avg_frame_rate !== '0/0') {
      const [n, d2] = v.avg_frame_rate.split('/').map(Number);
      if (d2) fps = Math.round((n / d2) * 100) / 100;
    }
    finish({ ok: true, codec: v.codec_name, width: v.width, height: v.height, fps });
  });
};

// GET /api/video/stream — multipart MJPEG
exports.handleStream = function handleStream(req, res) {
  if (!opts.url) { res.status(503).json({ error: 'No video source configured' }); return; }

  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'Pragma': 'no-cache',
    'Connection': 'close'
  });

  clients.add(res);
  ensureRunning();
  status('live');
  if (lastFrame) writeFrame(res, lastFrame); // paint immediately, don't wait a frame

  const drop = () => { clients.delete(res); stopIfIdle(); };
  req.on('close', drop);
  req.on('aborted', drop);
  res.on('error', drop);
};

// GET /api/video/snapshot — single JPEG, for the admin preview thumbnail
exports.handleSnapshot = function handleSnapshot(req, res) {
  if (!opts.url) { res.status(503).json({ error: 'No video source configured' }); return; }
  if (lastFrame) {
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
    return res.end(lastFrame);
  }
  // Nothing cached — hold the pipeline open just long enough for one frame.
  // The token is a holder, not a client: it must not receive multipart writes.
  const token = Symbol('snapshot');
  holders.add(token);
  ensureRunning();

  // Grab the frame *before* releasing the holder: stopIfIdle() clears
  // lastFrame, so reading it afterwards would send an empty body.
  const done = (fn) => {
    clearInterval(iv); clearTimeout(timer);
    const frame = lastFrame;
    holders.delete(token); stopIfIdle();
    fn(frame);
  };
  const timer = setTimeout(() => done(() => {
    if (!res.headersSent) res.status(504).json({ error: 'No frame from source' });
  }), 8000);
  const iv = setInterval(() => {
    if (!lastFrame) return;
    done((frame) => {
      if (res.headersSent || !frame) return;
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': frame.length, 'Cache-Control': 'no-store' });
      res.end(frame);
    });
  }, 100);
};
