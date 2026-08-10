'use strict';
// SMPTE LTC decoder: ffmpeg captures 1s WAV chunks → ltcdump decodes each chunk → callback
// Requires ffmpeg and ltcdump:
//   macOS  — brew install ffmpeg ltc-tools   (captures via avfoundation)
//   Linux  — apt install ffmpeg ltc-tools alsa-utils  (captures via ALSA)

const { spawn, execSync, spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const CHUNK_WAV = path.join(os.tmpdir(), 'synthony_ltc_chunk.wav');

// macOS addresses inputs as numeric avfoundation indices (":0"); Linux uses
// ALSA device strings ("hw:1,0"). Everything downstream goes through inputArg.
const IS_MAC         = process.platform === 'darwin';
const AUDIO_FMT      = IS_MAC ? 'avfoundation' : 'alsa';
const DEFAULT_DEVICE = IS_MAC ? '0' : 'default';

function inputArg(device) {
  const d = (device != null && device !== '') ? String(device) : DEFAULT_DEVICE;
  return IS_MAC ? `:${d}` : d;
}

let monitorProc = null;
let running     = false;
let loopTimer   = null;
let captureProc = null;

// Returns array of { index, name } for available audio input devices.
// `index` is an avfoundation ordinal on macOS and an ALSA device string on Linux;
// either way it round-trips through the UI straight back into inputArg().
exports.getDevices = function() {
  return IS_MAC ? listAvfoundationDevices() : listAlsaDevices();
};

function listAvfoundationDevices() {
  return new Promise((resolve) => {
    const ff = spawn('ffmpeg', ['-f', 'avfoundation', '-list_devices', 'true', '-i', '""'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let out = '';
    ff.stderr.on('data', d => out += d.toString());
    ff.on('close', () => {
      const devices = [];
      let inAudio = false;
      for (const line of out.split('\n')) {
        if (line.includes('AVFoundation audio devices')) { inAudio = true; continue; }
        if (inAudio && line.includes('AVFoundation video')) { inAudio = false; }
        if (inAudio) {
          const m = line.match(/\]\s+\[(\d+)\]\s+(.+)/);
          if (m) devices.push({ index: parseInt(m[1]), name: m[2].trim() });
        }
      }
      resolve(devices);
    });
    ff.on('error', () => resolve([]));
  });
}

// ALSA has no ffmpeg -list_devices equivalent, so read `arecord -l`.
function listAlsaDevices() {
  return new Promise((resolve) => {
    const devices = [{ index: 'default', name: 'System default input' }];
    let ar;
    try {
      ar = spawn('arecord', ['-l'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve(devices);
    }
    let out = '';
    ar.stdout.on('data', d => out += d.toString());
    ar.on('close', () => {
      for (const line of out.split('\n')) {
        // card 1: Device [USB Audio Device], device 0: USB Audio [USB Audio]
        const m = line.match(/^card (\d+):[^[]*\[([^\]]+)\], device (\d+):/);
        if (m) devices.push({ index: `hw:${m[1]},${m[3]}`, name: m[2].trim() });
      }
      resolve(devices);
    });
    ar.on('error', () => resolve(devices)); // alsa-utils not installed
  });
}

// Probe a device to get its channel count
exports.probeDevice = function(deviceIndex) {
  return new Promise((resolve) => {
    const ff = spawn('ffmpeg', ['-f', AUDIO_FMT, '-i', inputArg(deviceIndex), '-t', '0.5', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let out = '';
    ff.stderr.on('data', d => out += d.toString());
    const done = () => {
      let channels = 2;
      const mCount  = out.match(/(\d+) channels/i);
      const mLayout = out.match(/Audio:.*?,\s*[\d.]+ Hz,\s*(\d+)\.\d+/);
      if (mCount)       channels = parseInt(mCount[1]);
      else if (mLayout) channels = parseInt(mLayout[1]);
      else if (out.includes('stereo')) channels = 2;
      else if (out.includes('mono'))   channels = 1;
      resolve({ channels });
    };
    ff.on('close', done);
    ff.on('error', () => resolve({ channels: 2 }));
    setTimeout(() => { try { ff.kill('SIGKILL'); done(); } catch {} }, 4000);
  });
};

// Start LTC decoding — capture 1s chunks to file, decode each with ltcdump
exports.start = function start(cb, deviceIndex, channel) {
  running = false;
  if (captureProc) { try { captureProc.kill('SIGKILL'); } catch {} captureProc = null; }
  if (loopTimer)   { clearTimeout(loopTimer); loopTimer = null; }

  const input   = inputArg(deviceIndex);
  const chanIdx = Math.max(0, (parseInt(channel) || 1) - 1);

  running = true;
  console.log(`[LTC] Decoding ${AUDIO_FMT} ${input} channel ${chanIdx + 1}`);

  // Consecutive capture failures, so a missing ffmpeg backs off instead of
  // respawning in a tight loop and starving the event loop.
  let failures = 0;

  function captureChunk() {
    if (!running) return;

    let scheduled = false;
    const next = (delay) => {
      if (scheduled || !running) return;
      scheduled = true;
      loopTimer = setTimeout(captureChunk, delay);
    };
    const fail = (msg) => {
      if (scheduled || !running) return;
      failures++;
      // Only log the first few — a missing binary would otherwise flood the log.
      if (failures <= 3) console.warn('[LTC] capture error:', msg);
      else if (failures === 4) console.warn('[LTC] capture still failing — suppressing further errors until it recovers');
      next(Math.min(30000, 1000 * Math.pow(2, failures - 1)));
    };

    try {
      captureProc = spawn('ffmpeg', [
        '-y', '-f', AUDIO_FMT, '-i', input,
        '-af', `pan=mono|c0=c${chanIdx}`,
        '-ac', '1', '-ar', '48000',
        '-t', '1',
        CHUNK_WAV
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      fail(`spawn failed: ${e.message}`);
      return;
    }
    captureProc.stderr.on('data', () => {});
    captureProc.on('close', (code) => {
      if (!running) return;
      if (code === 0 || fs.existsSync(CHUNK_WAV)) {
        if (failures) { console.log('[LTC] capture recovered'); failures = 0; }
        // Decode the chunk synchronously
        try {
          const result = spawnSync('ltcdump', ['-F', CHUNK_WAV], { timeout: 2000 });
          const out = (result.stdout || '').toString();
          let lastTC = null;
          for (const line of out.split('\n')) {
            const m = line.match(/(\d{2}:\d{2}:\d{2}:\d{2})/);
            if (m) lastTC = m[1];
          }
          if (lastTC && cb) cb(lastTC);
        } catch {}
        next(0);
        return;
      }
      fail(`ffmpeg exited ${code}`);
    });
    captureProc.on('error', (e) => fail(e.message));
  }

  captureChunk();
};

exports.stop = function() {
  running = false;
  if (captureProc) { try { captureProc.kill('SIGKILL'); } catch {} captureProc = null; }
  if (loopTimer)   { clearTimeout(loopTimer); loopTimer = null; }
};

// Start a level monitor on the same device/channel — calls onLevel(db) ~10x/sec
exports.startMonitor = function(deviceIndex, channel, onLevel) {
  if (monitorProc) { try { monitorProc.kill('SIGKILL'); } catch {} monitorProc = null; }

  const input   = inputArg(deviceIndex);
  const chanIdx = Math.max(0, (parseInt(channel) || 1) - 1);

  try {
    monitorProc = spawn('ffmpeg', [
      '-f', AUDIO_FMT, '-i', input,
      '-af', `pan=mono|c0=c${chanIdx},ebur128`,
      '-f', 'null', '-'
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    console.warn('[LTC] monitor spawn failed:', e.message);
    return;
  }

  monitorProc.stderr.on('data', (data) => {
    const str = data.toString();
    for (const m of str.matchAll(/M:\s*([-\d.]+)/g)) {
      const db = parseFloat(m[1]);
      if (!isNaN(db) && onLevel) onLevel(db);
    }
  });
  monitorProc.on('error', () => {});
  console.log(`[LTC] Monitor on ${AUDIO_FMT} ${input} channel ${chanIdx + 1}`);
};

exports.stopMonitor = function() {
  if (monitorProc) { try { monitorProc.kill('SIGKILL'); } catch {} monitorProc = null; }
};
