'use strict';
// Waterfall — every upcoming cue as a countdown bar that grows toward full
// width as its fire time approaches. Shared by kiosk and admin.
// Depends on cue-utils.js: parseTC, _ovField (via show-overview), State, FR.

function _wfField(cue, type) { return cueFieldRaw(cue, type); }
function _wfEsc(s) {
  return String(s || '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}

const Waterfall = {
  // Countdown horizon: a bar is full at fire time, and this many seconds out
  // it has shrunk to its minimum. 5 min matches typical cue lead times.
  windowSec: 90,        // bars grow only in the final 90s — tighter lead time
  minWidthPct: 8,
  pastShown: 30,         // history kept in the DOM so the host can scroll back
  maxRows: 120,          // upcoming cues kept in the DOM so the host can scroll to later songs
  _userHold: false, _holdTimer: null, _scrollBound: false,   // manual-scroll state
  _cueType: localStorage.getItem('wf-cue-type') || 'any',
  _lastNum: null,

  setCueType(val) {
    if (!val) return;
    this._cueType = val;
    localStorage.setItem('wf-cue-type', val);
    const sel = document.getElementById('wf-filter');
    if (sel && sel.value !== val) sel.value = val;
    this.render();
    if (typeof sendScreenUpdate === 'function') try { sendScreenUpdate(); } catch {}
  },

  // Flatten every song's cues into time-sorted entries. In 'any' mode a cue
  // with several populated fields yields one row per field, so "All" really
  // shows all cue content; a filter narrows to one type.
  _entries() {
    const types = this._cueType === 'any' ? [...CUE_BASE_TYPES, ...customCueTypes()] : [this._cueType];
    const songs = State.songs || [];
    // Order cues by when they PLAY, not by absolute timecode. Songs are jammed
    // to their own non-sequential TC islands, so a play-order timeline —
    // cumulative song durations + the cue's offset — is what counts down
    // correctly (matches getShowTime, used as "now"). base[i] = show-time frames
    // before song i. Without this the waterfall counts down to whatever cue has
    // the next-lowest wall-TC, which can be a far-off song, so it looks stuck.
    const base = []; let acc = 0;
    for (let i = 0; i < songs.length; i++) { base[i] = acc; acc += parseDuration(songs[i].duration || ''); }
    const out = [];
    for (let i = 0; i < songs.length; i++) {
      const songName = songs[i].trackName || '';
      for (const cue of (songs[i].cues || [])) {
        const pos = base[i] + parseTC(cue.offset);   // frames along the play timeline
        for (const t of types) {
          const text = _wfField(cue, t);
          if (text) out.push({ abs: pos, type: t, text, id: cue.id + ':' + t, song: songName });
        }
      }
    }
    out.sort((a, b) => a.abs - b.abs);
    out.forEach((e, i) => { e.num = i + 1; });
    return out;
  },

  _anchorFrames: 0, _anchorWall: 0, _raf: null, _lastSec: -1,

  // Continuous "now" in frames, interpolated from the last authoritative TC
  // using the browser clock — so motion is smooth between the ~1/s TC updates.
  _nowFrames() {
    const base = this._anchorFrames;
    if (!(State.tcRunning)) return base;
    return base + ((performance.now() - this._anchorWall) / 1000) * FR;
  },

  _visible() {
    const b = document.getElementById('wf-body');
    return b && b.offsetParent !== null;
  },

  // Called on every TC update (via renderCurrent): re-anchor to the true TC
  // and rebuild the row set only when it structurally changes.
  _syncTypeOptions() {
    const sel = document.getElementById('wf-filter');
    if (!sel) return;
    const custom = customCueTypes();
    const sig = custom.join('|');
    if (sig === this._typeSig) return;
    this._typeSig = sig;
    const cur = sel.value;
    const base = '<option value="any">All cues</option>'
      + CUE_BASE_TYPES.map(t => `<option value="${t}">${t[0].toUpperCase()+t.slice(1)}</option>`).join('');
    sel.innerHTML = base + custom.map(t => `<option value="${_wfEsc(t)}">${_wfEsc(t)}</option>`).join('');
    sel.value = cur;
  },
  render() {
    const body = document.getElementById('wf-body');
    const sel  = document.getElementById('wf-filter');
    if (!body) return;
    if (!this._scrollBound) { this._bindScroll(body); this._scrollBound = true; }
    // Always-visible NOW / NEXT track reference (uses setlist play order).
    { const songs = State.songs || [];
      const curSong = getCurrentSong();
      const ci = curSong ? songs.indexOf(curSong) : -1;
      const nextSong = ci >= 0 ? songs[ci + 1] : (songs[0] || null);
      const c = document.getElementById('wf-cur-track'), n = document.getElementById('wf-next-track');
      if (c) c.textContent = curSong ? curSong.trackName : '—';
      if (n) n.textContent = nextSong ? nextSong.trackName : '—'; }
    this._syncTypeOptions();
    if (sel && sel.value !== this._cueType) sel.value = this._cueType;

    this._anchorFrames = getShowTime();   // play-timeline position, matches _entries ordering
    this._anchorWall   = performance.now();

    const now = this._anchorFrames;
    const all = this._entries();
    const cnt = document.getElementById('wf-count');
    if (cnt) cnt.textContent = all.length + (all.length === 1 ? ' cue' : ' cues');

    if (!all.length) { body.innerHTML = '<div class="wf-empty">No cues' + (this._cueType === 'any' ? '' : ' for this type') + '</div>'; this._sig = null; return; }

    let nextIdx = all.findIndex(e => e.abs > now);
    if (nextIdx < 0) nextIdx = all.length;
    const from  = Math.max(0, nextIdx - this.pastShown);
    this._slice = all.slice(from, Math.min(all.length, nextIdx + this.maxRows));

    const sig = this._slice.map(e => e.id).join('|') + '#' + this._cueType;
    // While the host has scrolled back through history, don't rebuild/scroll the
    // list out from under them — the bars still tick via _paint below. It snaps
    // back to NOW after they stop (or tap "Back to now").
    if (sig !== this._sig && !this._userHold) {
      let html = '', markerPlaced = false, prevSong = null;
      for (const e of this._slice) {
        const isPast = e.abs <= now;
        if (!isPast && !markerPlaced) { html += '<div class="wf-nowline"><span>NOW</span></div>'; markerPlaced = true; }
        // Song header before each song's first cue, so the host can see and
        // scroll to upcoming songs.
        if (e.song !== prevSong) { html += `<div class="wf-song${isPast ? ' past' : ''}">${_wfEsc(e.song || '—')}</div>`; prevSong = e.song; }
        const col = cueTypeColour(e.type);
        html += `<div class="wf-row${isPast ? ' past' : ''}" data-id="${e.id}" style="--wf:${col};--wf-dim:${col}22">
          <div class="wf-bar"><div class="wf-fill"></div>
            <span class="wf-num">${e.num}</span>
            <span class="wf-text">${_wfEsc(e.text)}</span>
          </div>
          <div class="wf-cd"></div>
        </div>`;
      }
      body.innerHTML = html;
      // cache row element refs so the rAF loop doesn't query the DOM each frame
      this._els = this._slice.map(e => {
        const row = body.querySelector(`.wf-row[data-id="${CSS.escape(e.id)}"]`);
        return row ? { e, row, fill: row.querySelector('.wf-fill'), cd: row.querySelector('.wf-cd') } : null;
      }).filter(Boolean);
      this._sig = sig;
      this._lastSec = -1;

      const mk = body.querySelector('.wf-nowline');
      if (mk) { const t = Math.max(0, mk.offsetTop - body.clientHeight * 0.18); body.scrollTo({ top: t, behavior: 'smooth' }); }
    }

    this._paint();       // immediate paint
    this._startLoop();   // ensure the smooth loop is running
  },

  // Runs ~60fps while the view is visible: sets each bar width from the
  // interpolated now. No CSS transition involved, so no stop-start.
  _paint() {
    if (!this._els) return;
    const now  = this._nowFrames();
    const winF = this.windowSec * FR;
    const sec  = Math.floor(now / FR);
    const secChanged = sec !== this._lastSec; this._lastSec = sec;
    for (const it of this._els) {
      const dt = it.e.abs - now;
      const isPast = dt <= 0;
      let pct = isPast ? 100 : (1 - dt / winF) * 100;
      pct = Math.max(this.minWidthPct, Math.min(100, pct));
      if (it.fill) it.fill.style.width = pct.toFixed(2) + '%';
      // Countdown text only needs updating when the whole second changes.
      if (secChanged && it.cd) {
        const tSec = Math.max(0, Math.round(dt / FR));
        const m = Math.floor(tSec / 60), ss = String(tSec % 60).padStart(2, '0');
        it.cd.textContent = isPast ? '' : `-${String(m).padStart(2, '0')}:${ss}`;
        it.cd.classList.toggle('imminent', !isPast && tSec <= 10);
        it.row.classList.toggle('past', isPast);
      }
    }
  },

  _startLoop() {
    if (this._raf) return;
    const loop = () => {
      if (!this._visible()) { this._raf = null; return; }
      this._paint();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  },

  // Manual scrolling: when the host scrolls (wheel/touch) to look back or ahead,
  // hold the auto-scroll + list-rebuild so it doesn't jump. Resume automatically
  // after a lull, or when they tap "Back to now".
  _bindScroll(body) {
    const onHold = () => {
      if (!this._userHold) {
        this._userHold = true;
        const v = document.getElementById('view-waterfall'); if (v) v.classList.add('wf-holding');
      }
      clearTimeout(this._holdTimer);
      this._holdTimer = setTimeout(() => this.backToNow(), 12000);
    };
    body.addEventListener('wheel', onHold, { passive: true });
    body.addEventListener('touchstart', onHold, { passive: true });
    body.addEventListener('touchmove', onHold, { passive: true });
  },
  backToNow() {
    clearTimeout(this._holdTimer);
    this._userHold = false;
    const v = document.getElementById('view-waterfall'); if (v) v.classList.remove('wf-holding');
    this._sig = null;      // force a fresh render + scroll-to-now
    this.render();
  }
};
