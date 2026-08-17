'use strict';
// Multi Cue (stage) view — shared between admin (index.html) and kiosk (kiosk.html)
// Depends on globals: State, FR, parseTC, parseDuration, getCurrentSong,
//   getNextCueGlobal, getPrevCueGlobal, durationCountdown, framesToDisplay, formatHMSF

function getField(cue, type) {
  // All cue content is spreadsheet-driven and lives in cue.extra (see cue-utils).
  return cueFieldRaw(cue, type);
}

function renderStage(slots, prefix = '') {
  const $ = id => document.getElementById(prefix + id);
  const song = getCurrentSong();
  const nowF = State.tcFrames || parseTC(State.tc);

  const nameEl = $('stage-song-name');
  if (nameEl) {
    nameEl.textContent = song?.trackName || '—';
    fitText(nameEl, nameEl, 32, Math.round(window.innerHeight * 0.13));
  }

  if (song) {
    const started  = parseTC(song.timecode);
    const elapsed  = nowF - started;
    const storedF  = song.duration ? parseDuration(song.duration) : 0;
    const nextSong = State.songs.find(s => parseTC(s.timecode) > started);
    const tcDurF   = nextSong ? parseTC(nextSong.timecode) - started : 0;
    const durF     = storedF > 0 ? storedF : tcDurF;
    if (durF > 0) {
      const remaining = durF - elapsed;
      const pct    = Math.min(100, Math.max(0, (elapsed / durF) * 100));
      // State as a class, not an inline colour. Neutral until the last 30s so
      // that red still means something when it finally appears.
      const remSec = Math.floor(Math.max(0, remaining) / FR);
      const state  = remSec <= 10 ? ' urgent' : remSec <= 30 ? ' warn' : '';
      const bar    = $('stage-progress-bar');
      if (bar) { bar.style.width = pct + '%'; bar.className = 'stage-progress-bar' + state; }
      const timesEl = document.querySelector('.stage-progress-time');
      if (timesEl) timesEl.className = 'stage-progress-time' + state;
      const elEl  = $('stage-elapsed');
      const remEl = $('stage-remaining');
      if (elEl)  elEl.textContent  = formatHMSF(Math.max(0, elapsed));
      if (remEl) remEl.textContent = '-' + formatHMSF(Math.max(0, remaining));
    } else {
      const bar = $('stage-progress-bar');
      if (bar) { bar.style.width = '0%'; bar.className = 'stage-progress-bar'; }
      const timesEl = document.querySelector('.stage-progress-time');
      if (timesEl) timesEl.className = 'stage-progress-time';
      const elEl  = $('stage-elapsed');
      const remEl = $('stage-remaining');
      if (elEl)  elEl.textContent = '—';
      if (remEl) remEl.textContent = '—';
    }
  } else {
    const bar = $('stage-progress-bar');
    if (bar) { bar.style.width = '0%'; bar.className = 'stage-progress-bar'; }
    const timesEl = document.querySelector('.stage-progress-time');
    if (timesEl) timesEl.className = 'stage-progress-time';
    const elEl  = $('stage-elapsed');
    const remEl = $('stage-remaining');
    if (elEl)  elEl.textContent = '—';
    if (remEl) remEl.textContent = '—';
  }

  for (const slot of ['a', 'b']) {
    const type       = slots[slot];
    const nextGlobal = getNextCueGlobal(type);
    const lastFired  = getPrevCueGlobal(type);
    const beforeLast = getPrevCueGlobal(type, 1);
    const lastDurF   = lastFired?.cue?.duration ? parseDuration(lastFired.cue.duration) : 0;
    const lastElapsed = lastFired ? nowF - lastFired.absFrames : 0;
    // Per cue-type hold: 'until next' never expires by time; a timed hold clears
    // after its window (explicit seconds, else the cue's duration, else 5s).
    const holdWinF   = cueHoldWindow(type, lastDurF);
    const expired    = !lastFired ? false : holdWinF === Infinity ? false : lastElapsed >= holdWinF;
    const nowGlobal  = expired ? null : lastFired;
    const prevGlobal = expired ? lastFired : beforeLast;
    const remFrames  = nextGlobal ? durationCountdown(nextGlobal) : Infinity;

    const nextEl = $(`slot-${slot}-next`);
    const curEl  = $(`slot-${slot}-current`);
    const prevEl = $(`slot-${slot}-prev`);
    if (nextEl) {
      nextEl.textContent = nextGlobal ? (getField(nextGlobal.cue, type) || '—') : '—';
      nextEl.style.fontSize = '';   // size is uniform now — clear any fitted leftover
    }
    if (curEl)  curEl.textContent  = nowGlobal  ? (getField(nowGlobal.cue,  type) || '—') : '—';
    if (prevEl) prevEl.textContent = prevGlobal ? (getField(prevGlobal.cue, type) || '—') : '—';

    const cntEl = $(`slot-${slot}-countdown`);
    if (cntEl) {
      if (nextGlobal && remFrames !== Infinity) {
        const remSec = Math.floor(remFrames / FR);
        cntEl.textContent      = framesToDisplay(remFrames);
        cntEl.className = 'stage-countdown' + (remSec <= 10 ? ' urgent' : '');
      } else { cntEl.textContent = '—'; }
    }

    const barEl = $(`slot-${slot}-progress`);
    if (barEl) {
      if (nextGlobal) {
        const nowElapsed = nowGlobal ? (nowF - nowGlobal.absFrames) : 0;
        const span = remFrames + nowElapsed;
        barEl.style.width = span > 0 ? Math.min(100, Math.max(0, (remFrames / span) * 100)) + '%' : '0%';
      } else { barEl.style.width = '0%'; }
    }

    // The NOW bar counts down the cue-hold window: a timed hold (e.g. 5s) drains
    // over exactly those seconds, so the bar IS the countdown to the cue clearing.
    // An "until next" hold has no fixed end, so fall back to the cue's own
    // duration if it has one, otherwise show a steady full bar.
    const nowBarWrap = $(`slot-${slot}-now-bar-wrap`);
    const nowBar     = $(`slot-${slot}-now-bar`);
    const holdEl     = $(`slot-${slot}-hold`);
    if (nowBarWrap && nowBar) {
      if (nowGlobal && holdWinF !== Infinity && holdWinF > 0) {
        nowBarWrap.style.display = '';
        const remF   = Math.max(0, holdWinF - lastElapsed);
        const remSec = Math.ceil(remF / FR);
        nowBar.style.width = Math.min(100, Math.max(0, (remF / holdWinF) * 100)) + '%';
        const urgent = remSec <= 2;
        nowBar.className = 'stage-cue-progress-bar stage-cue-now-bar' + (urgent ? ' urgent' : '');
        if (holdEl) { holdEl.textContent = remSec + 's'; holdEl.className = 'stage-now-hold' + (urgent ? ' urgent' : ''); }
      } else if (nowGlobal && lastDurF > 0) {
        nowBarWrap.style.display = '';
        const pct = Math.min(100, Math.max(0, (lastElapsed / lastDurF) * 100));
        nowBar.style.width = pct + '%';
        nowBar.className = 'stage-cue-progress-bar stage-cue-now-bar' + (lastElapsed > lastDurF * 0.85 ? ' urgent' : '');
        if (holdEl) holdEl.textContent = '';
      } else {
        nowBarWrap.style.display = 'none';
        if (holdEl) holdEl.textContent = '';
      }
    }
  }
}

// Host view — a big track name plus two configurable cue types (Single Cue with
// a second cue). Shared by admin and kiosk via the element id prefix.
function renderHostView(hslots, prefix = '') {
  const $ = id => document.getElementById(prefix + id);
  const song   = getCurrentSong();
  const curCue = getCurrentCue(song);
  // These are single-line headings, so fit to WIDTH (widthOnly): fitting a line
  // against its own height collapses it to the min on large screens because a
  // tight line-height pushes scrollHeight past clientHeight. The cap is a
  // fraction of viewport height so the hero stays dominant without shouting.
  const H = window.innerHeight;
  const nameEl = $('host-label');
  if (nameEl) {
    nameEl.textContent = song?.trackName || '—';
    // Song title — H2 (a heading, not the hero).
    fitText(nameEl, nameEl, 28, Math.round(H * 0.11), true);
  }
  for (const slot of ['a', 'b']) {
    const type   = hslots[slot];
    const nextG  = getNextCueGlobal(type);
    const curTx  = getField(curCue, type);
    const nextTx = getField(nextG?.cue, type);
    const txEl = $('host-text-' + slot);
    if (txEl) {
      txEl.textContent = curTx || nextTx || '—';
      txEl.classList.toggle('is-upcoming', !curTx && !!nextTx);
      // Cue 1 (slot a) is a subtitle (H4, tight under the title); Cue 2 is the hero (H1).
      const maxFrac = slot === 'a' ? 0.055 : 0.28;
      fitText(txEl, txEl, slot === 'a' ? 18 : 40, Math.round(H * maxFrac), true);
    }
    const tyEl = $('host-type-' + slot);
    if (tyEl) { tyEl.textContent = (type || '—').toUpperCase(); tyEl.style.color = type ? cueTypeColour(type) : ''; }
  }
}
