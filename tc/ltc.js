'use strict';
// SMPTE LTC decoder: ffmpeg captures 1s WAV chunks → ltcdump decodes each chunk → callback
// Requires: ffmpeg and ltcdump installed (brew install ffmpeg ltc-tools)

const { spawn, execSync, spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const CHUNK_WAV = path.join(os.tmpdir(), 'synthony_ltc_chunk.wav');

let monitorProc = null;
let running     = false;
let loopTimer   = null;
let captureProc = null;

// Returns array of { index, name } for available audio input devices
exports.getDevices = function() {
  return new Promise((resolve) => {
    const ff = spawn('ffmpeg', ['-f', 'avfoundation', '-list_devices', 'true', '-i', '""']);
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
};

// Probe a device to get its channel count
exports.probeDevice = function(deviceIndex) {
  return new Promise((resolve) => {
    const ff = spawn('ffmpeg', ['-f', 'avfoundation', '-i', `:${deviceIndex}`, '-t', '0.5', '-f', 'null', '-']);
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

  const idx     = (deviceIndex != null && deviceIndex !== '') ? String(deviceIndex) : '1';
  const chanIdx = Math.max(0, (parseInt(channel) || 1) - 1);

  running = true;
  console.log(`[LTC] Decoding device :${idx} channel ${chanIdx + 1}`);

  function captureChunk() {
    if (!running) return;
    captureProc = spawn('ffmpeg', [
      '-y', '-f', 'avfoundation', '-i', `:${idx}`,
      '-af', `pan=mono|c0=c${chanIdx}`,
      '-ac', '1', '-ar', '48000',
      '-t', '1',
      CHUNK_WAV
    ]);
    captureProc.stderr.on('data', () => {});
    captureProc.on('close', (code) => {
      if (!running) return;
      if (code === 0 || fs.existsSync(CHUNK_WAV)) {
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
      }
      loopTimer = setTimeout(captureChunk, 0);
    });
    captureProc.on('error', () => {
      if (running) loopTimer = setTimeout(captureChunk, 500);
    });
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

  const idx     = (deviceIndex != null && deviceIndex !== '') ? String(deviceIndex) : '1';
  const chanIdx = Math.max(0, (parseInt(channel) || 1) - 1);

  monitorProc = spawn('ffmpeg', [
    '-f', 'avfoundation', '-i', `:${idx}`,
    '-af', `pan=mono|c0=c${chanIdx},ebur128`,
    '-f', 'null', '-'
  ]);

  monitorProc.stderr.on('data', (data) => {
    const str = data.toString();
    for (const m of str.matchAll(/M:\s*([-\d.]+)/g)) {
      const db = parseFloat(m[1]);
      if (!isNaN(db) && onLevel) onLevel(db);
    }
  });
  monitorProc.on('error', () => {});
  console.log(`[LTC] Monitor on device :${idx} channel ${chanIdx + 1}`);
};

exports.stopMonitor = function() {
  if (monitorProc) { try { monitorProc.kill('SIGKILL'); } catch {} monitorProc = null; }
};
