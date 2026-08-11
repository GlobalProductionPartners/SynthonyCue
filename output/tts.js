'use strict';
// Server-side text-to-speech via espeak-ng, so the server Pi can call cues out
// its own audio output (patched into comms) with no browser involved. Speech is
// serialised through a small queue so overlapping cues don't garble each other.
//
// Best-effort, exactly like the LTC tooling: if espeak-ng isn't installed the
// module warns once and every call becomes a no-op — the rest of the show is
// unaffected.

const { spawn } = require('child_process');

const BIN = 'espeak-ng';
let available = null;   // null = unknown, true/false once probed
let warned = false;

const queue = [];
let speaking = false;
const MAX_QUEUE = 8;    // a large TC seek must not dump a minute of backlog

function warnMissing(err) {
  if (!warned) {
    warned = true;
    console.warn(`[TTS] ${BIN} not available (${err.code || err.message}) — server readout disabled. ` +
      `Install with: sudo apt install espeak-ng`);
  }
}

function runNext() {
  if (speaking) return;
  const job = queue.shift();
  if (!job) return;
  speaking = true;

  const args = ['-v', job.voice || 'en', '-s', String(job.rate || 175), '--', job.text];
  let child;
  try {
    child = spawn(BIN, args, { stdio: 'ignore' });
  } catch (e) {
    speaking = false; warnMissing(e); return;
  }
  child.on('error', (e) => {
    available = false; speaking = false;
    warnMissing(e);
    // Don't drain the queue trying a dead binary.
    queue.length = 0;
  });
  child.on('exit', () => {
    available = true;
    speaking = false;
    runNext();
  });
}

/**
 * Speak a line out the server's audio device. Serialised; excess is dropped.
 * @param {string} text
 * @param {{voice?:string, rate?:number}} [opts]
 */
exports.speak = function speak(text, opts = {}) {
  if (available === false) return;               // known-missing → silent no-op
  const line = String(text || '').trim();
  if (!line) return;
  queue.push({ text: line, voice: opts.voice, rate: opts.rate });
  while (queue.length > MAX_QUEUE) queue.shift(); // keep only the most recent
  runNext();
};

// Drop anything pending (used on a TC jump so stale calls don't fire).
exports.flush = function flush() { queue.length = 0; };

exports.available = () => available;
