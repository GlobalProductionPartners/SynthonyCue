'use strict';
// Waterfall — every upcoming cue as a countdown bar that grows toward full
// width as its fire time approaches. Shared by kiosk and admin.
// Depends on cue-utils.js: parseTC, _ovField (via show-overview), State, FR.

const WF_TYPES = ['stage', 'host', 'conductor', 'camera', 'description'];
const WF_COLOUR = {
  stage:       '#F59E0B',  // amber
  host:        '#3B82F6',  // blue
  conductor:   '#8B5CF6',  // purple
  camera:      '#06B6D4',  // cyan
  description: '#8A8F98',  // grey
};

function _wfField(cue, type) {
  if (type === 'description') return cue.description || '';
  return cue[type + 'Cue'] || '';
}
function _wfEsc(s) {
  return String(s || '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}

const Waterfall = {
  // Countdown horizon: a bar is full at fire time, and this many seconds out
  // it has shrunk to its minimum. 5 min matches typical cue lead times.
  windowSec: 90,        // bars grow only in the final 90s — tighter lead time
  minWidthPct: 8,
  pastShown: 3,          // greyed just-fired rows kept for context
  maxRows: 60,
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
    const types = this._cueType === 'any' ? WF_TYPES : [this._cueType];
    const out = [];
    for (const song of (State.songs || [])) {
      const start = parseTC(song.timecode);
      for (const cue of (song.cues || [])) {
        const abs = start + parseTC(cue.offset);
        for (const t of types) {
          const text = _wfField(cue, t);
          if (text) out.push({ abs, type: t, text, id: cue.id + ':' + t });
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
  render() {
    const body = document.getElementById('wf-body');
    const sel  = document.getElementById('wf-filter');
    if (!body) return;
    if (sel && sel.value !== this._cueType) sel.value = this._cueType;

    this._anchorFrames = State.tcFrames || parseTC(State.tc);
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
    if (sig !== this._sig) {
      let html = '', markerPlaced = false;
      for (const e of this._slice) {
        const isPast = e.abs <= now;
        if (!isPast && !markerPlaced) { html += '<div class="wf-nowline"><span>NOW</span></div>'; markerPlaced = true; }
        const col = WF_COLOUR[e.type] || WF_COLOUR.description;
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
  }
};
