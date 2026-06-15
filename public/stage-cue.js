'use strict';
// Multi Cue (stage) view — shared between admin (index.html) and kiosk (kiosk.html)
// Depends on globals: State, FR, parseTC, parseDuration, getCurrentSong,
//   getNextCueGlobal, getPrevCueGlobal, durationCountdown, framesToDisplay, formatHMSF

function getField(cue, type) {
  if (!cue) return '';
  const map = { stage: 'stageCue', host: 'hostCue', camera: 'cameraCue', conductor: 'conductorCue', description: 'description' };
  return cue[map[type] || type] || '';
}

function renderStage(slots, prefix = '') {
  const $ = id => document.getElementById(prefix + id);
  const song = getCurrentSong();
  const nowF = State.tcFrames || parseTC(State.tc);

  const nameEl = $('stage-song-name');
  if (nameEl) nameEl.textContent = song?.trackName || '—';

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
      const remSec = Math.floor(Math.max(0, remaining) / FR);
      const col    = remSec <= 30 ? 'var(--red)' : 'var(--amber)';
      const bar    = $('stage-progress-bar');
      if (bar) { bar.style.width = pct + '%'; bar.style.background = col; }
      const elEl  = $('stage-elapsed');
      const remEl = $('stage-remaining');
      if (elEl)  { elEl.textContent  = formatHMSF(Math.max(0, elapsed));         elEl.style.color  = col; }
      if (remEl) { remEl.textContent = '-' + formatHMSF(Math.max(0, remaining)); remEl.style.color = col; }
    } else {
      const bar = $('stage-progress-bar');
      if (bar) bar.style.width = '0%';
      const elEl  = $('stage-elapsed');
      const remEl = $('stage-remaining');
      if (elEl)  elEl.textContent = '—';
      if (remEl) remEl.textContent = '—';
    }
  } else {
    const bar = $('stage-progress-bar');
    if (bar) bar.style.width = '0%';
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
    const expired    = lastDurF > 0 ? lastElapsed > lastDurF
                     : lastFired ? (song ? lastFired.song !== song : lastElapsed > 300 * FR)
                     : false;
    const nowGlobal  = expired ? null : lastFired;
    const prevGlobal = expired ? lastFired : beforeLast;
    const remFrames  = nextGlobal ? durationCountdown(nextGlobal) : Infinity;

    const nextEl = $(`slot-${slot}-next`);
    const curEl  = $(`slot-${slot}-current`);
    const prevEl = $(`slot-${slot}-prev`);
    if (nextEl) nextEl.textContent = nextGlobal ? (getField(nextGlobal.cue, type) || '—') : '—';
    if (curEl)  curEl.textContent  = nowGlobal  ? (getField(nowGlobal.cue,  type) || '—') : '—';
    if (prevEl) prevEl.textContent = prevGlobal ? (getField(prevGlobal.cue, type) || '—') : '—';

    const cntEl = $(`slot-${slot}-countdown`);
    if (cntEl) {
      if (nextGlobal && remFrames !== Infinity) {
        const remSec = Math.floor(remFrames / FR);
        cntEl.textContent      = framesToDisplay(remFrames);
        cntEl.style.background = remSec <= 10 ? 'rgba(255,69,58,0.15)' : 'rgba(255,214,10,0.1)';
        cntEl.style.color      = remSec <= 10 ? 'var(--red)' : 'var(--amber)';
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

    const nowBarWrap = $(`slot-${slot}-now-bar-wrap`);
    const nowBar     = $(`slot-${slot}-now-bar`);
    if (nowBarWrap && nowBar) {
      if (nowGlobal && lastDurF > 0) {
        nowBarWrap.style.display = '';
        const pct = Math.min(100, Math.max(0, (lastElapsed / lastDurF) * 100));
        nowBar.style.width = pct + '%';
        nowBar.className = 'stage-cue-progress-bar stage-cue-now-bar' + (lastElapsed > lastDurF * 0.85 ? ' urgent' : '');
      } else { nowBarWrap.style.display = 'none'; }
    }
  }
}
