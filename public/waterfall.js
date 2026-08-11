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
  windowSec: 300,
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

  render() {
    const body = document.getElementById('wf-body');
    const sel  = document.getElementById('wf-filter');
    if (!body) return;
    if (sel && sel.value !== this._cueType) sel.value = this._cueType;

    const now  = State.tcFrames || parseTC(State.tc);
    const all  = this._entries();
    const cnt  = document.getElementById('wf-count');
    if (cnt) cnt.textContent = all.length + (all.length === 1 ? ' cue' : ' cues');

    if (!all.length) { body.innerHTML = '<div class="wf-empty">No cues' + (this._cueType === 'any' ? '' : ' for this type') + '</div>'; return; }

    // First upcoming entry = the position marker anchor.
    let nextIdx = all.findIndex(e => e.abs > now);
    if (nextIdx < 0) nextIdx = all.length;

    const from = Math.max(0, nextIdx - this.pastShown);
    const slice = all.slice(from, Math.min(all.length, nextIdx + this.maxRows));
    const winF  = this.windowSec * FR;

    let html = '';
    let markerPlaced = false;
    for (const e of slice) {
      const isPast = e.abs <= now;
      if (!isPast && !markerPlaced) {
        html += '<div class="wf-nowline"><span>NOW</span></div>';
        markerPlaced = true;
      }
      const tSec = Math.max(0, Math.round((e.abs - now) / FR));
      // Bar grows toward fire: full at 0s, minimum at the horizon.
      let pct = isPast ? 100 : Math.round((1 - (e.abs - now) / winF) * 100);
      pct = Math.max(this.minWidthPct, Math.min(100, pct));
      const col = WF_COLOUR[e.type] || WF_COLOUR.description;
      const m = Math.floor(tSec / 60), sctext = String(tSec % 60).padStart(2, '0');
      const cd = isPast ? '' : `-${String(m).padStart(2, '0')}:${sctext}`;
      const imminent = !isPast && tSec <= 10 ? ' imminent' : '';
      html += `<div class="wf-row${isPast ? ' past' : ''}" style="--wf:${col};--wf-dim:${col}22">
        <div class="wf-bar"><div class="wf-fill" style="width:${pct}%"></div>
          <span class="wf-num">${e.num}</span>
          <span class="wf-text">${_wfEsc(e.text)}</span>
        </div>
        <div class="wf-cd${imminent}">${cd}</div>
      </div>`;
    }
    body.innerHTML = html;

    // Keep the NOW marker parked near the top as cues advance.
    if (this._lastNum !== (slice[0] && slice[0].num)) {
      this._lastNum = slice[0] && slice[0].num;
    }
    const mk = body.querySelector('.wf-nowline');
    if (mk) {
      const target = mk.offsetTop - body.clientHeight * 0.18;
      if (Math.abs(body.scrollTop - target) > 40) body.scrollTop = Math.max(0, target);
    }
  }
};
