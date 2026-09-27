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
  _forwardCap: 80,       // upcoming cues in the DOM; grows as the host scrolls near the end
  // manual-scroll / pagination state
  _userHold: false, _holdTimer: null, _scrollBound: false,
  _frozen: null, _moreAvailable: false, _progUntil: 0, _from: 0, _end: 0,
  // Which cue types to show. 'any' = all types (including any that appear later);
  // otherwise an explicit array of ticked type names. Persisted as JSON, with a
  // fallback to the old single-value key so existing screens keep their choice.
  _cueTypes: (function () {
    try { const j = localStorage.getItem('wf-cue-types'); if (j) { const v = JSON.parse(j); if (v === 'any' || Array.isArray(v)) return v; } } catch {}
    const legacy = localStorage.getItem('wf-cue-type');
    return (legacy && legacy !== 'any') ? [legacy] : 'any';
  })(),
  _lastNum: null,

  // The effective list of type names to render right now (intersected with the
  // types the loaded show actually has).
  _activeTypes() {
    const avail = customCueTypes();
    if (this._cueTypes === 'any') return [...CUE_BASE_TYPES, ...avail];
    return this._cueTypes.filter(t => avail.includes(t));
  },
  isTypeOn(t) { return this._cueTypes === 'any' || this._cueTypes.includes(t); },

  // Persist + re-render + push to other screens. `val` is 'any' or an array.
  setCueTypes(val, opts) {
    this._cueTypes = (val === 'any' || Array.isArray(val)) ? val : 'any';
    try { localStorage.setItem('wf-cue-types', JSON.stringify(this._cueTypes)); } catch {}
    this._typeSig = null;                 // force the checkbox menu + label to rebuild
    this._sig = null;                     // force the cue list to rebuild
    this.render();
    if (!(opts && opts.silent) && typeof sendScreenUpdate === 'function') try { sendScreenUpdate(); } catch {}
  },
  // Tick/untick one type. Collapses to 'any' when everything ends up ticked.
  toggleType(t, on) {
    const avail = customCueTypes();
    const set = new Set(this._cueTypes === 'any' ? avail : this._cueTypes.filter(x => avail.includes(x)));
    if (on) set.add(t); else set.delete(t);
    const next = avail.every(x => set.has(x)) ? 'any' : [...set];
    this.setCueTypes(next);
  },
  setAll(on) { this.setCueTypes(on ? 'any' : []); },
  // Legacy single-value entry point (old screen_command payloads).
  setCueType(val) { this.setCueTypes(!val || val === 'any' ? 'any' : [val]); },

  toggleFilterMenu(ev) {
    if (ev) ev.stopPropagation();
    const menu = document.getElementById('wf-filter-menu');
    if (!menu) return;
    if (menu.hidden) { this._typeSig = null; this._buildFilterMenu(); menu.hidden = false; this._bindMenuOutside(); }
    else menu.hidden = true;
  },
  _bindMenuOutside() {
    if (this._menuBound) return; this._menuBound = true;
    document.addEventListener('click', (e) => {
      const menu = document.getElementById('wf-filter-menu');
      const wrap = document.querySelector('.wf-filter-wrap');
      if (menu && !menu.hidden && wrap && !wrap.contains(e.target)) menu.hidden = true;
    });
  },
  _buildFilterMenu() {
    const menu = document.getElementById('wf-filter-menu');
    if (!menu) return;
    const types = customCueTypes();
    const allOn = this._cueTypes === 'any';
    let html = `<label class="wf-fopt wf-fall"><input type="checkbox" ${allOn ? 'checked' : ''} onchange="Waterfall.setAll(this.checked)"><span class="wf-fname">All cues</span></label>`;
    if (types.length) html += '<div class="wf-fsep"></div>';
    for (const t of types) {
      const on = this.isTypeOn(t);
      html += `<label class="wf-fopt"><input type="checkbox" ${on ? 'checked' : ''} onchange="Waterfall.toggleType('${_wfEsc(t).replace(/'/g, "\\'")}', this.checked)"><span class="wf-sw" style="background:${cueTypeColour(t)}"></span><span class="wf-fname">${_wfEsc(t)}</span></label>`;
    }
    if (!types.length) html += '<div class="wf-fopt" style="opacity:.6">No cue types in show</div>';
    menu.innerHTML = html;
  },
  _updateFilterLabel() {
    const lbl = document.getElementById('wf-filter-label');
    if (!lbl) return;
    const total = customCueTypes().length;
    if (this._cueTypes === 'any') lbl.textContent = 'All cues';
    else if (!this._cueTypes.length) lbl.textContent = 'None';
    else {
      const on = this._activeTypes();
      lbl.textContent = on.length === 1 ? on[0] : `${on.length} of ${total} types`;
    }
  },

  // Flatten every song's cues into time-sorted entries. A cue with several
  // populated (and ticked) fields yields one row per field, so ticking multiple
  // types shows all of their content interleaved on the timeline.
  _entries() {
    const types = this._activeTypes();
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

  // Rebuild the type-filter UI (checkbox popover + button label) only when the
  // show's set of cue types changes, or when the selection changes.
  _syncTypeOptions() {
    const custom = customCueTypes();
    const sig = custom.join('|') + '#' + JSON.stringify(this._cueTypes);
    if (sig === this._typeSig) return;
    this._typeSig = sig;
    const menu = document.getElementById('wf-filter-menu');
    if (menu && !menu.hidden) this._buildFilterMenu();   // keep an open menu in sync
    this._updateFilterLabel();
  },
  render() {
    const body = document.getElementById('wf-body');
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

    this._anchorFrames = getShowTime();   // play-timeline position, matches _entries ordering
    this._anchorWall   = performance.now();

    const now = this._anchorFrames;
    const all = this._entries();
    const cnt = document.getElementById('wf-count');
    if (cnt) cnt.textContent = all.length + (all.length === 1 ? ' cue' : ' cues');

    if (!all.length) { body.innerHTML = '<div class="wf-empty">No cues' + (this._cueTypes === 'any' ? '' : ' for the selected types') + '</div>'; this._sig = null; return; }

    let nextIdx = all.findIndex(e => e.abs > now);
    if (nextIdx < 0) nextIdx = all.length;

    // Window into the cue list. Normally it follows NOW live; while the host is
    // browsing it FREEZES (so the list can't shift under them), and scrolling
    // near the end grows the frozen window — paginated "load more".
    let from, end;
    if (this._userHold && this._frozen) {
      from = this._frozen.from;
      end  = Math.min(all.length, this._frozen.end);
    } else {
      from = Math.max(0, nextIdx - this.pastShown);
      end  = Math.min(all.length, nextIdx + this._forwardCap);
    }
    this._from = from; this._end = end;
    this._moreAvailable = end < all.length;
    this._slice = all.slice(from, end);

    const sig = this._slice.map(e => e.id).join('|') + '#' + JSON.stringify(this._cueTypes);
    if (sig !== this._sig) {
      const held = this._userHold;
      const keepTop = held ? body.scrollTop : null;   // preserve position when browsing
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

      if (keepTop !== null) {
        // Restore the browsing position instantly (rows only grew at the end).
        this._progUntil = performance.now() + 700;
        const sb = body.style.scrollBehavior; body.style.scrollBehavior = 'auto';
        body.scrollTop = keepTop; body.style.scrollBehavior = sb;
      } else {
        const mk = body.querySelector('.wf-nowline');
        if (mk) { this._progUntil = performance.now() + 900; const t = Math.max(0, mk.offsetTop - body.clientHeight * 0.18); body.scrollTo({ top: t, behavior: 'smooth' }); }
      }
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
    const startHold = () => {
      if (!this._userHold) {
        this._userHold = true;
        this._frozen = { from: this._from, end: this._end };   // freeze the current window
        const v = document.getElementById('view-waterfall'); if (v) v.classList.add('wf-holding');
      }
      clearTimeout(this._holdTimer);
      this._holdTimer = setTimeout(() => this.backToNow(), 15000);
    };
    body.addEventListener('wheel', startHold, { passive: true });
    body.addEventListener('touchstart', startHold, { passive: true });
    body.addEventListener('scroll', () => {
      if (performance.now() < this._progUntil) return;   // ignore our own programmatic scrolls
      startHold();
      // Paginate: near the end, pull in the next batch of upcoming cues.
      if (this._moreAvailable && body.scrollTop + body.clientHeight >= body.scrollHeight - 700) this._loadMore();
    }, { passive: true });
  },
  _loadMore() {
    if (!this._frozen) this._frozen = { from: this._from, end: this._end };
    this._frozen.end += 60;   // grow the window; render() clamps it to the show length
    this._sig = null;
    this.render();
  },
  backToNow() {
    clearTimeout(this._holdTimer);
    this._userHold = false; this._frozen = null; this._forwardCap = 80;
    const v = document.getElementById('view-waterfall'); if (v) v.classList.remove('wf-holding');
    this._sig = null;         // force a fresh render + scroll-to-now
    this.render();
  }
};
