'use strict';
// MIDI Timecode (MTC) receiver via node-midi
// Fires callback(tc) with HH:MM:SS:FF when a full frame is assembled

let callback = null;
let currentInput = null;

const qf = new Array(8).fill(0);
let qfCount = 0;

function assembleTC() {
  const frames = qf[0] | (qf[1] << 4);
  const secs   = qf[2] | (qf[3] << 4);
  const mins   = qf[4] | (qf[5] << 4);
  const hours  = qf[6] | ((qf[7] & 0x01) << 4);
  return [hours, mins, secs, frames].map(n => String(n).padStart(2, '0')).join(':');
}

// Returns array of available MIDI input port names
exports.getPorts = function() {
  try {
    const midi = require('midi');
    const tmp = new midi.Input();
    const ports = [];
    for (let i = 0; i < tmp.getPortCount(); i++) ports.push(tmp.getPortName(i));
    return ports;
  } catch { return []; }
};

// Open a specific port by name (or fall back to auto-detect)
exports.start = function start(cb, portName) {
  callback = cb;

  // Close previous port if open
  if (currentInput) {
    try { currentInput.closePort(); } catch {}
    currentInput = null;
  }

  const midi = require('midi');
  const input = new midi.Input();
  const count = input.getPortCount();

  let port = -1;

  // Match by exact name first
  if (portName) {
    for (let i = 0; i < count; i++) {
      if (input.getPortName(i) === portName) { port = i; break; }
    }
  }

  // Auto-detect: prefer ports with midi/timecode/tc in the name
  if (port === -1) {
    for (let i = 0; i < count; i++) {
      const name = input.getPortName(i).toLowerCase();
      if (name.includes('midi') || name.includes('timecode') || name.includes('tc')) {
        port = i; break;
      }
    }
  }

  if (port === -1 && count > 0) port = 0;
  if (port === -1) throw new Error('No MIDI ports found');

  input.on('message', (_delta, msg) => {
    const [status, data1] = msg;

    // Full frame MTC (SysEx F0 7F 7F 01 01 hh mm ss ff F7)
    if (status === 0xF0 && msg[3] === 0x01 && msg[4] === 0x01) {
      const tc = [msg[5] & 0x1F, msg[6], msg[7], msg[8]]
        .map(n => String(n).padStart(2, '0')).join(':');
      if (callback) callback(tc);
      return;
    }

    // Quarter-frame
    if (status === 0xF1) {
      const piece = (data1 >> 4) & 0x07;
      qf[piece] = data1 & 0x0F;
      qfCount++;
      if (qfCount % 8 === 0 && piece === 7) {
        if (callback) callback(assembleTC());
      }
    }
  });

  input.openPort(port);
  currentInput = input;
  console.log(`[MTC] Listening on: ${input.getPortName(port)}`);
};
