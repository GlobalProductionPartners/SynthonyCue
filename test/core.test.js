'use strict';
// Tests for the time math the show runs on. The functions live in
// public/cue-utils.js (shared by admin and kiosk); they are loaded here in a
// VM sandbox so the browser file stays the single source of truth.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sandbox = {
  window: { innerHeight: 1080, addEventListener() {} },
  document: { getElementById: () => null, querySelector: () => null },
  localStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); } },
  performance: { now: () => 0 },
  State: { songs: [], tc: '00:00:00:00', tcFrames: 0, config: {} },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'cue-utils.js'), 'utf8'), sandbox);
// A later runInContext call sees the prior call's top-level `const`s (FR, …), but
// cue-caller's own `const Caller` isn't a property of the context — hang it on the
// global so the tests can reach it.
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'public', 'cue-caller.js'), 'utf8') + '\nthis.Caller = Caller;',
  sandbox);

// ── parseTC ───────────────────────────────────────────────────────────────────
test('parseTC round numbers', () => {
  assert.equal(sandbox.parseTC('00:00:00:00'), 0);
  assert.equal(sandbox.parseTC('00:00:01:00'), 25);          // 25fps
  assert.equal(sandbox.parseTC('00:01:00:00'), 60 * 25);
  assert.equal(sandbox.parseTC('01:00:00:00'), 3600 * 25);
  assert.equal(sandbox.parseTC('01:02:03:04'), ((3600 + 120 + 3) * 25) + 4);
});

test('parseTC edge inputs', () => {
  assert.equal(sandbox.parseTC(''), 0);
  assert.equal(sandbox.parseTC(null), 0);
  assert.equal(sandbox.parseTC(undefined), 0);
});

// ── parseDuration ─────────────────────────────────────────────────────────────
test('parseDuration m:ss and h:mm:ss', () => {
  assert.equal(sandbox.parseDuration('2:51'), (2 * 60 + 51) * 25);
  assert.equal(sandbox.parseDuration('0:05'), 5 * 25);
  assert.equal(sandbox.parseDuration('1:02:03'), (3600 + 120 + 3) * 25);
});

test('parseDuration bare seconds and empties', () => {
  assert.equal(sandbox.parseDuration('90'), 90 * 25);
  assert.equal(sandbox.parseDuration(''), 0);
  assert.equal(sandbox.parseDuration(null), 0);
});

// ── formatHMSF / framesToDisplay ─────────────────────────────────────────────
test('formatHMSF renders m:ss', () => {
  assert.equal(sandbox.formatHMSF(0), '0:00');
  assert.equal(sandbox.formatHMSF(25), '0:01');
  assert.equal(sandbox.formatHMSF(171 * 25), '2:51');
});

test('framesToDisplay compact countdown', () => {
  assert.equal(sandbox.framesToDisplay(4 * 25), '4s');
  assert.equal(sandbox.framesToDisplay((6 * 60 + 11) * 25), '6m 11s');
});

// ── song / cue selection ──────────────────────────────────────────────────────
function loadShow(songs, tcFrames) {
  sandbox.State.songs = songs;
  sandbox.State.tcFrames = tcFrames;
}

// Cue content is spreadsheet-driven and lives in cue.extra keyed by column name.
const SHOW = [
  { id: 'a', trackName: 'A', timecode: '01:00:00:00', duration: '2:00', cues: [
    { id: 'a1', offset: '00:00:05:00', extra: { 'Stage Cue': 'A-EARLY' } },
    { id: 'a2', offset: '00:01:00:00', extra: { 'Stage Cue': 'A-MID' } },
  ]},
  { id: 'b', trackName: 'B', timecode: '02:00:00:00', duration: '3:00', cues: [
    { id: 'b1', offset: '00:00:10:00', extra: { 'Stage Cue': 'B-FIRST' } },
  ]},
];

test('getCurrentSong picks the latest started song', () => {
  loadShow(SHOW, sandbox.parseTC('01:00:01:00'));
  assert.equal(sandbox.getCurrentSong().id, 'a');
  loadShow(SHOW, sandbox.parseTC('02:30:00:00'));
  assert.equal(sandbox.getCurrentSong().id, 'b');
  loadShow(SHOW, sandbox.parseTC('00:30:00:00'));
  assert.equal(sandbox.getCurrentSong(), null);
});

test('getCurrentCue respects offsets and ORDER — out-of-order lists mis-fire', () => {
  loadShow(SHOW, sandbox.parseTC('01:00:06:00')); // 6s into song A
  assert.equal(sandbox.getCurrentCue(sandbox.getCurrentSong()).id, 'a1');
  loadShow(SHOW, sandbox.parseTC('01:01:30:00'));
  assert.equal(sandbox.getCurrentCue(sandbox.getCurrentSong()).id, 'a2');

  // The property the editor+server sort now guarantees: unsorted cues break
  // selection because getCurrentCue stops at the first future offset.
  const unsorted = JSON.parse(JSON.stringify(SHOW));
  unsorted[0].cues.reverse(); // a2 (1:00) before a1 (0:05)
  loadShow(unsorted, sandbox.parseTC('01:00:06:00')); // 6s in — a1 should be live
  assert.notEqual(sandbox.getCurrentCue(sandbox.getCurrentSong())?.id, 'a1',
    'documents WHY sorted order is a hard requirement');
});

test('getNextCueGlobal walks into the next song', () => {
  loadShow(SHOW, sandbox.parseTC('01:01:30:00')); // after a2
  const next = sandbox.getNextCueGlobal('Stage Cue');
  assert.equal(next.cue.id, 'b1');
});

test('durationCountdown chains song durations, not raw TC gaps', () => {
  // 30s into A (duration 2:00) → 1:30 left in A, then B starts, b1 at +10s.
  loadShow(SHOW, sandbox.parseTC('01:00:30:00'));
  const next = sandbox.getNextCueGlobal('Stage Cue', 1); // skip a2 → b1
  assert.equal(next.cue.id, 'b1');
  const frames = sandbox.durationCountdown(next);
  assert.equal(frames, (90 + 10) * 25); // NOT the raw hour gap to 02:00:00:00
});

// ── cue ordering (mirrors editor sortCues / server normalisation) ────────────
test('sort by parseTC(offset) is stable for equal offsets', () => {
  const cues = [
    { offset: '00:01:00:00', n: 1 },
    { offset: '00:00:05:00', n: 2 },
    { offset: '00:01:00:00', n: 3 },
  ];
  cues.sort((x, y) => sandbox.parseTC(x.offset) - sandbox.parseTC(y.offset));
  assert.deepEqual(cues.map(c => c.n), [2, 1, 3]);
});

// ── Cue Readout: standby/go event generation (shared with server checkCueFires) ─
function readoutSetup(depts, lead = 10) {
  sandbox.State.songs = [
    { id: 's1', timecode: '01:00:00:00', cues: [
      { id: 'c1', offset: '00:00:30:00', extra: { 'Stage Cue': 'Go SR', 'Pyro': 'Flames' } },
    ]},
  ];
  sandbox.State.config = { readout: { lead, depts } };
}

test('readout emits standby+go for an sg department', () => {
  readoutSetup({ 'Stage Cue': { on: true, style: 'sg' } });
  const ev = sandbox.Caller._events();
  const cf = sandbox.parseTC('01:00:30:00');            // absolute cue frame
  assert.equal(ev.length, 2);
  const sb = ev.find(e => e.phase === 'sb'), go = ev.find(e => e.phase === 'go');
  assert.equal(sb.line, 'Standby, Go SR');              // department name omitted from speech
  assert.equal(sb.at, cf - 10 * 25);                    // lead 10s before the cue
  assert.equal(go.line, 'Go');
  assert.equal(go.at, cf);
});

test('readout style sr reads the cue text at GO; go/ro skip standby', () => {
  readoutSetup({ Pyro: { on: true, style: 'sr' } });
  let ev = sandbox.Caller._events();
  assert.equal(ev.find(e => e.phase === 'sb').line, 'Standby, Flames');
  assert.equal(ev.find(e => e.phase === 'go').line, 'Flames');   // reads cue text

  readoutSetup({ Pyro: { on: true, style: 'go' } });
  ev = sandbox.Caller._events();
  assert.equal(ev.length, 1);                                    // no standby
  assert.equal(ev[0].line, 'Go');

  readoutSetup({ Pyro: { on: true, style: 'ro' } });
  ev = sandbox.Caller._events();
  assert.equal(ev.length, 1);
  assert.equal(ev[0].line, 'Flames');
});

test('readout ignores unticked departments', () => {
  readoutSetup({ 'Stage Cue': { on: false, style: 'sg' } });   // Pyro not configured at all
  assert.equal(sandbox.Caller._events().length, 0);
});
