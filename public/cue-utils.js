'use strict';
// Shared utilities — loaded by both admin (index.html) and kiosk (kiosk.html)
// Depends on globals: State (defined in each page's inline script)
// Depends on: getField (defined in stage-cue.js, loaded after this file)

const FR = 25;

// ── TC / duration helpers ─────────────────────────────────────────────────────

function parseTC(tc) {
  if (!tc) return 0;
  const [h, m, s, f] = (tc || '00:00:00:00').split(':').map(Number);
  return ((h * 3600 + m * 60 + s) * FR) + (f || 0);
}

function parseDuration(dur) {
  if (!dur) return 0;
  const parts = String(dur).split(':').map(Number);
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * FR;
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * FR;
  return Number(dur) * FR || 0;
}

function formatHMSF(frames) {
  const totalSec = Math.floor(frames / FR);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function framesToDisplay(frames) {
  const totalSec = Math.floor(frames / FR);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

// ── Song helpers ──────────────────────────────────────────────────────────────

function getCurrentSong() {
  const now = State.tcFrames || parseTC(State.tc);
  let song = null, songTC = -1;
  for (const s of State.songs) {
    const tc = parseTC(s.timecode);
    if (tc <= now && tc > songTC) { song = s; songTC = tc; }
  }
  return song;
}

function getNextSong() {
  const now = State.tcFrames || parseTC(State.tc);
  let next = null, nextTC = Infinity;
  for (const s of State.songs) {
    const tc = parseTC(s.timecode);
    if (tc > now && tc < nextTC) { next = s; nextTC = tc; }
  }
  return next;
}

function getCurrentCue(song) {
  if (!song) return null;
  const now = State.tcFrames || parseTC(State.tc);
  const elapsed = now - parseTC(song.timecode);
  let cur = null;
  for (const c of (song.cues || [])) {
    if (parseTC(c.offset) <= elapsed) cur = c; else break;
  }
  return cur;
}

// ── Global cue helpers ────────────────────────────────────────────────────────

// description uses cue.description; all other types use cue[type+'Cue']
function _hasCueField(cue, type) {
  if (type === 'description') return !!cue.description;
  return !!(cue[type + 'Cue']);
}

// ── Manual fire override ──────────────────────────────────────────────────────
// Set when an operator fires a cue by hand. Operator views (stage/console)
// show it as NOW for its duration; TC-derived views are unaffected.
let ManualCue = null;
function setManualCue(msg) {
  ManualCue = msg && msg.cue ? { cue: msg.cue, atFrames: msg.atFrames || 0 } : null;
}
function manualCueFor(type) {
  if (!ManualCue) return null;
  if (type && !_hasCueField(ManualCue.cue, type)) return null;
  const now = State.tcFrames || parseTC(State.tc);
  const durF = ManualCue.cue.duration ? parseDuration(ManualCue.cue.duration) : 60 * FR;
  if (now < ManualCue.atFrames || now > ManualCue.atFrames + durF) return null;
  return { song: getCurrentSong(), cue: ManualCue.cue, absFrames: ManualCue.atFrames };
}

// Past cues across ALL songs, most-recent first. skip=0 → last fired, skip=1 → one before.
function getPrevCueGlobal(type, skip = 0) {
  const now = State.tcFrames || parseTC(State.tc);
  const candidates = [];
  for (const song of State.songs) {
    const songStart = parseTC(song.timecode);
    for (const cue of (song.cues || [])) {
      const abs = songStart + parseTC(cue.offset);
      if (abs <= now && (!type || _hasCueField(cue, type))) candidates.push({ song, cue, absFrames: abs });
    }
  }
  candidates.sort((a, b) => a.absFrames - b.absFrames);
  // A manual fire outranks the natural history unless something fired later.
  const manual = manualCueFor(type);
  if (manual && skip === 0) {
    const natural = candidates[candidates.length - 1];
    if (!natural || manual.absFrames >= natural.absFrames) return manual;
  }
  return candidates[candidates.length - 1 - skip] || null;
}

// Next cue across ALL songs. skip=0 → next, skip=1 → one after that.
// Uses song-array order for future songs so non-sequential timecodes work correctly.
function getNextCueGlobal(type, skip = 0) {
  const now = State.tcFrames || parseTC(State.tc);
  const curSong = getCurrentSong();
  let count = 0;

  if (curSong) {
    const curIdx   = State.songs.indexOf(curSong);
    const curStart = parseTC(curSong.timecode);
    const elapsed  = now - curStart;

    const curCues = (curSong.cues || [])
      .filter(c => parseTC(c.offset) > elapsed && (!type || _hasCueField(c, type)))
      .sort((a, b) => parseTC(a.offset) - parseTC(b.offset));
    for (const cue of curCues) {
      if (count++ === skip) return { song: curSong, cue, absFrames: curStart + parseTC(cue.offset) };
    }

    for (let i = curIdx + 1; i < State.songs.length; i++) {
      const song   = State.songs[i];
      const sStart = parseTC(song.timecode);
      const sCues  = (song.cues || [])
        .filter(c => !type || _hasCueField(c, type))
        .sort((a, b) => parseTC(a.offset) - parseTC(b.offset));
      for (const cue of sCues) {
        if (count++ === skip) return { song, cue, absFrames: sStart + parseTC(cue.offset) };
      }
    }
    return null;
  }

  // No current song: fall back to raw TC ordering
  const cands = [];
  for (const song of State.songs) {
    const sStart = parseTC(song.timecode);
    for (const cue of (song.cues || [])) {
      const abs = sStart + parseTC(cue.offset);
      if (abs > now && (!type || _hasCueField(cue, type))) cands.push({ song, cue, absFrames: abs });
    }
  }
  cands.sort((a, b) => a.absFrames - b.absFrames);
  return cands[skip] || null;
}

// Duration-chained countdown — chains song.duration fields rather than raw TC gaps,
// so shows with non-sequential timecodes still give accurate remaining times.
function durationCountdown(nextGlobal) {
  if (!nextGlobal) return Infinity;
  const now     = State.tcFrames || parseTC(State.tc);
  const curSong = getCurrentSong();
  if (!curSong) return Math.max(0, nextGlobal.absFrames - now);

  const curStart = parseTC(curSong.timecode);
  const elapsed  = now - curStart;

  if (nextGlobal.song === curSong) return Math.max(0, parseTC(nextGlobal.cue.offset) - elapsed);

  const songs     = State.songs;
  const curIdx    = songs.indexOf(curSong);
  const targetIdx = songs.indexOf(nextGlobal.song);
  if (curIdx < 0 || targetIdx <= curIdx) return Math.max(0, nextGlobal.absFrames - now);

  const curDurF = curSong.duration ? parseDuration(curSong.duration) : 0;
  let total = Math.max(0, curDurF - elapsed);
  for (let i = curIdx + 1; i < targetIdx; i++) total += songs[i].duration ? parseDuration(songs[i].duration) : 0;
  total += parseTC(nextGlobal.cue.offset);
  return Math.max(0, total);
}

// ── Fit-to-box type ───────────────────────────────────────────────────────────
// Sizes an element's font so its text fills the available box. This is what
// "readable from a distance" actually requires: clamp() ceilings cap the type
// while the container flexes, which measured out at 49-74% empty screen on a
// 1080p panel. Binary search costs ~9 layout passes, and the result is cached
// against text + box size so the 25fps render loop pays nothing on idle.
function fitText(el, box, min = 16, max, widthOnly = false) {
  if (!el) return;
  box = box || el;
  // Ceiling is a fraction of screen height, not the box: filling space must
  // not tip into shouting. ~16vh reads strongly from distance without
  // dominating the room; callers can pass a tighter or looser cap.
  if (max == null) max = Math.round(window.innerHeight * 0.16);
  // A placeholder dash is not information — never blow it up into a headline
  // (at 480px an em-dash renders as a giant white bar).
  if (el.textContent.trim() === '—' || el.textContent.trim() === '') max = Math.min(max, 64);
  const key = el.textContent + '|' + box.clientWidth + 'x' + box.clientHeight;
  if (el._fitKey === key) return;
  if (!box.clientWidth) return;           // hidden view — leave untouched
  let lo = min, hi = max;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    el.style.fontSize = mid + 'px';
    // widthOnly: a single-line element fitted against itself has no real
    // height box — descenders push scrollHeight past clientHeight at any
    // size and the search collapses to `min`. Width is the only honest axis.
    const fits = el.scrollWidth <= box.clientWidth + 1 &&
                 (widthOnly || el.scrollHeight <= box.clientHeight + 1);
    if (fits) lo = mid; else hi = mid - 1;
  }
  el.style.fontSize = lo + 'px';
  // Cache with the box as it is *after* fitting — auto-height boxes settle here.
  el._fitKey = el.textContent + '|' + box.clientWidth + 'x' + box.clientHeight;
}

// ── Console view renderer ─────────────────────────────────────────────────────
// Shared between admin (renderTestStage) and kiosk (renderTestView).
// `slots` is an object: { a: 'stage'|'host'|..., b: '...' }

function renderConsoleView(slots) {
  const song     = getCurrentSong();
  const nextSong = getNextSong();
  const nowF     = State.tcFrames || parseTC(State.tc);

  const recEl = document.getElementById('con-receiving');
  if (recEl) { recEl.textContent = State.tcRunning ? '●RECEIVING' : '●OFFLINE'; recEl.className = 'con-receiving' + (State.tcRunning ? '' : ' offline'); }

  const trackEl = document.getElementById('con-track-name');
  if (trackEl) {
    const name = song?.trackName || '—';
    trackEl.textContent = name;
    fitText(trackEl, trackEl, 24, Math.round(window.innerHeight * 0.13), true);
  }
  const bpmEl = document.getElementById('con-bpm-key');
  if (bpmEl) bpmEl.textContent = song?.bpm ? `BPM  ${song.bpm}` : '';

  if (song) {
    const started = parseTC(song.timecode);
    const elapsed = nowF - started;
    const storedF = song.duration ? parseDuration(song.duration) : 0;
    const nxtSong = State.songs.find(s => parseTC(s.timecode) > started);
    const durF    = storedF > 0 ? storedF : (nxtSong ? parseTC(nxtSong.timecode) - started : 0);
    if (durF > 0) {
      const remaining = durF - elapsed;
      // Neutral until the last 30s, so red still carries meaning when it lands.
      const remSecSong = Math.floor(Math.max(0, remaining) / FR);
      const barState   = remSecSong <= 10 ? ' urgent' : remSecSong <= 30 ? ' warn' : '';
      const bar = document.getElementById('con-prog-bar');
      if (bar) { bar.style.width = Math.min(100, Math.max(0, (elapsed / durF) * 100)) + '%'; bar.className = 'con-prog-bar' + barState; }
      const elEl  = document.getElementById('con-elapsed');
      const remEl = document.getElementById('con-remaining');
      if (elEl)  { elEl.textContent  = formatHMSF(Math.max(0, elapsed));         elEl.className = 'con-time-val' + barState; }
      if (remEl) { remEl.textContent = '-' + formatHMSF(Math.max(0, remaining)); remEl.className = 'con-time-val right' + barState; }
    } else {
      const bar = document.getElementById('con-prog-bar');
      if (bar) { bar.style.width = '0%'; bar.className = 'con-prog-bar'; }
      const elEl  = document.getElementById('con-elapsed');
      const remEl = document.getElementById('con-remaining');
      if (elEl)  elEl.textContent = formatHMSF(Math.max(0, elapsed));
      if (remEl) remEl.textContent = '—';
    }
  } else {
    const bar = document.getElementById('con-prog-bar');
    if (bar) bar.style.width = '0%';
    const elEl  = document.getElementById('con-elapsed');
    const remEl = document.getElementById('con-remaining');
    if (elEl)  elEl.textContent  = '—';
    if (remEl) remEl.textContent = '—';
  }

  const nxNameEl = document.getElementById('con-next-track');
  const nxMetaEl = document.getElementById('con-next-meta');
  if (nextSong) {
    if (nxNameEl) nxNameEl.textContent = nextSong.trackName;
    const diff = parseTC(nextSong.timecode) - nowF;
    const parts = [];
    if (nextSong.bpm) parts.push(nextSong.bpm + ' BPM');
    if (diff > 0) parts.push('in ' + framesToDisplay(diff));
    if (nxMetaEl) nxMetaEl.textContent = parts.join('  ·  ');
  } else {
    if (nxNameEl) nxNameEl.textContent = '—';
    if (nxMetaEl) nxMetaEl.textContent = '';
  }

  const PRE_FIRE_F = 5 * FR;
  const HOLD_F     = 5 * FR;
  const holdMode   = State.config?.cueHoldMode || 'timed';
  const labelMap = { stage: 'STAGE CUE', host: 'HOST CUE', camera: 'CAMERA', conductor: 'CONDUCTOR', description: 'DESCRIPTION' };

  for (const slot of ['a', 'b']) {
    const type        = slots[slot];
    const nextGlobal  = getNextCueGlobal(type);
    const lastFired   = getPrevCueGlobal(type);
    const lastElapsed = lastFired ? nowF - lastFired.absFrames : 0;
    const lastDurF    = lastFired?.cue?.duration ? parseDuration(lastFired.cue.duration) : 0;
    const liveWindowF = holdMode === 'until-next' ? Infinity : (lastDurF > 0 ? lastDurF : HOLD_F);
    const sameSong    = !song || !lastFired || lastFired.song === song;
    const isLive      = !!lastFired && lastElapsed < liveWindowF && sameSong;
    const remToNext   = nextGlobal ? durationCountdown(nextGlobal) : Infinity;
    const isPreFire   = !isLive && !!nextGlobal && isFinite(remToNext) && remToNext <= PRE_FIRE_F;

    const prevCue  = isLive ? getPrevCueGlobal(type, 1) : lastFired;
    const prevEl   = document.getElementById(`con-prev-${slot}`);
    if (prevEl) prevEl.textContent = prevCue ? (getField(prevCue.cue, type) || '—') : '—';

    const typeEl = document.getElementById(`con-panel-${slot}-type`);
    if (typeEl) typeEl.textContent = labelMap[type] || type.toUpperCase();

    const panelEl = document.getElementById(`con-panel-${slot}`);
    if (panelEl) panelEl.className = 'con-panel' + (isLive ? ' live' : isPreFire ? ' prefire' : '');

    const pillEl = document.getElementById(`con-pill-${slot}`);
    if (pillEl) {
      if (isLive)         { pillEl.textContent = '●LIVE'; pillEl.className = 'con-pill live'; }
      else if (isPreFire) { pillEl.textContent = '●NEXT'; pillEl.className = 'con-pill next'; }
      else                { pillEl.textContent = '';      pillEl.className = 'con-pill'; }
    }

    const cueEl = document.getElementById(`con-cue-${slot}`);
    if (cueEl) {
      var _cueBox = cueEl.parentElement; // .con-panel-body — flex:1, overflow hidden
      if (isLive) {
        cueEl.textContent = getField(lastFired.cue, type) || '—';
        cueEl.classList.add('is-live');
      } else {
        cueEl.textContent = '—';
        cueEl.classList.remove('is-live');
      }
      fitText(cueEl, _cueBox, 18, Math.round(window.innerHeight * 0.06));
    }

    const footCdEl  = document.getElementById(`con-foot-cd-${slot}`);
    const miniBarEl = document.getElementById(`con-mini-bar-${slot}`);

    // Countdown text
    if (isLive) {
      const remSec = isFinite(remToNext) ? Math.floor(remToNext / FR) : Infinity;
      if (footCdEl) { footCdEl.textContent = isFinite(remToNext) ? framesToDisplay(remToNext) : '∞'; footCdEl.classList.toggle('urgent', remSec <= 10); }
    } else if (isPreFire || isFinite(remToNext)) {
      const remSec = Math.floor(remToNext / FR);
      if (footCdEl) { footCdEl.textContent = framesToDisplay(remToNext); footCdEl.classList.toggle('urgent', remSec <= 5); }
    } else {
      if (footCdEl) { footCdEl.textContent = '—'; footCdEl.classList.remove('urgent'); }
    }

    // Progress bar: elapsed since last cue / total gap to next cue
    if (miniBarEl) {
      const lastAbsF = lastFired ? lastFired.absFrames : null;
      const nextAbsF = nextGlobal ? nextGlobal.absFrames : null;
      if (lastAbsF !== null && nextAbsF !== null && nextAbsF > lastAbsF) {
        const pct = Math.min(100, Math.max(0, (nowF - lastAbsF) / (nextAbsF - lastAbsF) * 100));
        miniBarEl.style.width = pct + '%';
        miniBarEl.className = 'con-mini-bar' + (isLive ? ' live' : '');
      } else {
        miniBarEl.style.width = isLive ? '100%' : '0%';
        miniBarEl.className = 'con-mini-bar' + (isLive ? ' live' : '');
      }
    }

    const nowLblEl  = document.getElementById(`con-now-lbl-${slot}`);
    const nowTextEl = document.getElementById(`con-now-text-${slot}`);
    if (nowLblEl)  { nowLblEl.textContent = 'Next'; nowLblEl.className = 'con-now-lbl' + (nextGlobal ? ' next' : ' prev'); }
    if (nowTextEl) {
      nowTextEl.textContent = nextGlobal ? (getField(nextGlobal.cue, type) || '—') : '—';
      nowTextEl.className = 'con-now-text' + (nextGlobal ? ' next' : ' prev');
    }
  }
}
