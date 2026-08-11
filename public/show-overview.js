'use strict';
// Show Overview — 3-column full-show status view
// Depends on: State, FR, parseTC, parseDuration, framesToDisplay,
//             getCurrentSong, getPrevCueGlobal, getNextCueGlobal, durationCountdown
// (all from cue-utils.js, loaded before this file)

function _ovField(cue, type) {
  if (!cue) return '';
  switch (type) {
    case 'stage':       return cue.stageCue || '';
    case 'host':        return cue.hostCue || '';
    case 'conductor':   return cue.conductorCue || '';
    case 'camera':      return cue.cameraCue || '';
    case 'description': return cue.description || '';
    default:            return cue.stageCue || cue.hostCue || cue.conductorCue || cue.cameraCue || cue.description || '';
  }
}

function _ovEsc(s) {
  return String(s || '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

function _ovScrollCenter(container, el) {
  if (!container || !el) return;
  const top = el.offsetTop - container.clientHeight / 2 + el.offsetHeight / 2;
  container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

const Overview = {
  _songsKey:    null,
  _markerState: null,
  _cueType:     localStorage.getItem('ov-cue-type') || 'any',
  _cueScope:    localStorage.getItem('ov-cue-scope') || 'song',
  _anchorFrames: 0, _anchorWall: 0, _raf: null, _cueEls: null,

  setCueType(val) {
    this._cueType = val;
    localStorage.setItem('ov-cue-type', val);
    this._songsKey = null; this._cueListSong = null; // force list rebuild
  },
  setScope(val) {
    if (!val) return;
    this._cueScope = val;
    localStorage.setItem('ov-cue-scope', val);
    this._cueListSong = null;               // force cue-list rebuild
    const sel = document.getElementById('ov-scope-sel');
    if (sel && sel.value !== val) sel.value = val;
    this.render();
    if (typeof sendScreenUpdate === 'function') try { sendScreenUpdate(); } catch {}
  },

  // Continuous 'now' interpolated from the browser clock between TC updates,
  // so the per-cue countdown bars move smoothly rather than stepping.
  _nowFrames() {
    if (!State.tcRunning) return this._anchorFrames;
    return this._anchorFrames + ((performance.now() - this._anchorWall) / 1000) * FR;
  },
  _paintBars() {
    if (!this._cueEls || !this._cueEls.length) return;
    const now = this._nowFrames();
    const winF = 90 * FR;   // bars grow in the final 90s (matches waterfall)
    for (const it of this._cueEls) {
      const dt = it.abs - now;
      if (dt <= 0) { it.fill.style.width = '100%'; continue; }
      let pct = (1 - dt / winF) * 100;
      pct = Math.max(0, Math.min(100, pct));
      it.fill.style.width = pct.toFixed(2) + '%';
      const remSec = Math.round(dt / FR);
      const cls = remSec <= 10 ? 'urgent' : remSec <= 30 ? 'warn' : '';
      if (it.fill.dataset.st !== cls) { it.fill.className = 'ov-cue-fill' + (cls ? ' ' + cls : ''); it.fill.dataset.st = cls; }
      if (it.cd) {
        const m = Math.floor(remSec / 60), ss = String(remSec % 60).padStart(2,'0');
        it.cd.textContent = `-${m}:${ss}`;
        if (it.cd.dataset.st !== cls) { it.cd.className = 'ov-cue-cd' + (cls ? ' ' + cls : ''); it.cd.dataset.st = cls; }
      }
    }
  },
  _startBarLoop() {
    if (this._raf) return;
    const loop = () => {
      const b = document.getElementById('ov-cuelist-body');
      if (!b || b.offsetParent === null) { this._raf = null; return; }
      this._paintBars();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  },

  render() {
    const nowF    = State.tcFrames || parseTC(State.tc);
    const song    = getCurrentSong();
    const cueType = this._cueType;
    // null = no filter (auto); named type = only cues with that field populated
    const effectiveType = cueType === 'any' ? null : cueType;

    const lastFired = getPrevCueGlobal(effectiveType);
    const prevFired = getPrevCueGlobal(effectiveType, 1);
    const sameSong  = !lastFired || !song || lastFired.song === song;

    // Sync select element to current type (persisted across page loads)
    const typeSelEl = document.getElementById('ov-cue-type-sel');
    if (typeSelEl && typeSelEl.value !== cueType) typeSelEl.value = cueType;

    // ── Determine isLive per hold mode ────────────────────────────────────────
    const holdMode = State.config?.cueHoldMode || 'timed';
    let isLive = !!lastFired && sameSong;
    if (isLive && holdMode === 'timed') {
      const HOLD_F      = 5 * FR;
      const lastElapsed = nowF - lastFired.absFrames;
      const lastDurF    = lastFired?.cue?.duration ? parseDuration(lastFired.cue.duration) : 0;
      const liveWindowF = lastDurF > 0 ? lastDurF : HOLD_F;
      if (lastElapsed >= liveWindowF) isLive = false;
    }

    // ── Column 1: Prev / Current / Next ───────────────────────────────────────

    const prevEl = document.getElementById('ov-prev-text');
    if (prevEl) {
      const prevCue = isLive ? prevFired : lastFired;
      prevEl.textContent = prevCue ? (_ovField(prevCue.cue, cueType) || '—') : '—';
    }

    const curLblEl  = document.getElementById('ov-current-lbl');
    const curTextEl = document.getElementById('ov-current-text');
    if (curTextEl && curLblEl) {
      if (isLive) {
        curTextEl.textContent = _ovField(lastFired.cue, cueType) || '—';
        curTextEl.className   = 'ov-current-text live';
        curLblEl.className    = 'ov-current-lbl live';
      } else {
        curTextEl.textContent = '—';
        curTextEl.className   = 'ov-current-text';
        curLblEl.className    = 'ov-current-lbl';
      }
      fitText(curTextEl, curTextEl, 24, Math.round(window.innerHeight * 0.10), true);
    }

    const nextGlobal = getNextCueGlobal(effectiveType);
    const remToNext  = nextGlobal ? durationCountdown(nextGlobal) : Infinity;
    const nextTextEl = document.getElementById('ov-next-text');
    const nextCdEl   = document.getElementById('ov-next-cd');
    const nextBarEl  = document.getElementById('ov-next-bar');

    if (nextGlobal && isFinite(remToNext)) {
      if (nextTextEl) nextTextEl.textContent = _ovField(nextGlobal.cue, cueType) || '—';
      if (nextCdEl)   nextCdEl.textContent   = framesToDisplay(remToNext);
      if (nextBarEl) {
        const lastAbsF = lastFired ? lastFired.absFrames : null;
        const nextAbsF = nextGlobal.absFrames;
        if (lastAbsF !== null && nextAbsF > lastAbsF) {
          const pct = Math.min(100, Math.max(0, (nowF - lastAbsF) / (nextAbsF - lastAbsF) * 100));
          nextBarEl.style.width = pct + '%';
        } else {
          nextBarEl.style.width = '0%';
        }
      }
    } else {
      if (nextTextEl) nextTextEl.textContent = '—';
      if (nextCdEl)   nextCdEl.textContent   = '—';
      if (nextBarEl)  nextBarEl.style.width  = '0%';
    }

    // ── Rebuild list HTML only when songs change ──────────────────────────────
    const songsKey    = State.songs.map(s => s.id || s.timecode).join(',');
    const rebuildLists = songsKey !== this._songsKey;
    this._songsKey = songsKey;

    const filteredSongs  = State.songs.filter(s => !s.trackName.toLowerCase().includes('next track'));
    const curSongArrIdx  = State.songs.indexOf(song);
    const curFilteredIdx = filteredSongs.findIndex(s => s === song || (song && s.id && s.id === song.id));
    const liveCueId      = isLive && lastFired?.cue?.id ? String(lastFired.cue.id) : '';
    const markerState    = `${liveCueId}|${curSongArrIdx}`;

    // ── Column 2: Set list ────────────────────────────────────────────────────
    const cntEl = document.getElementById('ov-setlist-count');
    if (cntEl) cntEl.textContent = (curFilteredIdx >= 0 ? curFilteredIdx + 1 : '–') + ' / ' + filteredSongs.length;

    const setBody = document.getElementById('ov-setlist-body');
    if (setBody) {
      if (rebuildLists) {
        setBody.innerHTML = filteredSongs.map((s, i) => `
          <div class="ov-song-item" id="ov-song-${_ovEsc(s.id || i)}" data-fidx="${i}">
            <span class="ov-song-num">${i + 1}</span>
            <div class="ov-song-info">
              <div class="ov-song-name">${_ovEsc(s.trackName)}</div>
              <div class="ov-song-meta">${_ovEsc(s.timecode)}${s.cues?.length ? '  ·  ' + s.cues.length + (s.cues.length !== 1 ? ' cues' : ' cue') : ''}</div>
            </div>
          </div>`).join('');
        delete setBody.dataset.markerState;
      }

      if (setBody.dataset.markerState !== markerState) {
        setBody.querySelectorAll('.ov-song-item').forEach(el => {
          const idx = parseInt(el.dataset.fidx);
          el.classList.remove('active', 'past');
          if (idx === curFilteredIdx)    el.classList.add('active');
          else if (idx < curFilteredIdx) el.classList.add('past');
        });
        if (curFilteredIdx >= 0) {
          _ovScrollCenter(setBody, setBody.querySelector('.ov-song-item.active'));
        }
        setBody.dataset.markerState = markerState;
      }
    }

    // ── Column 3: Cue list — CURRENT song only ────────────────────────────────
    // Show just the running song's cues (or the next song's before the show
    // starts) so operators see only what's relevant, not the whole show.
    // Scope: 'song' shows the running (or next) song only; 'all' shows every song.
    const scopeSel = document.getElementById('ov-scope-sel');
    if (scopeSel && scopeSel.value !== this._cueScope) scopeSel.value = this._cueScope;
    const listSong  = song || getNextSong();
    const scopeSongs = this._cueScope === 'all'
      ? State.songs.filter(s => (s.cues || []).some(c => _ovField(c, cueType)))
      : (listSong ? [listSong] : []);
    const shownCount = scopeSongs.reduce((n, s) => n + (s.cues || []).filter(c => _ovField(c, cueType)).length, 0);
    const cueCntEl  = document.getElementById('ov-cuelist-count');
    if (cueCntEl) cueCntEl.textContent = shownCount;

    // Anchor the interpolation clock every render (TC update).
    this._anchorFrames = nowF;
    this._anchorWall   = performance.now();

    const cueBody = document.getElementById('ov-cuelist-body');
    if (cueBody) {
      const scopeKey   = this._cueScope + ':' + scopeSongs.map(s => s.id || s.timecode).join(',');
      const rebuildCue = rebuildLists || scopeKey !== this._cueListSong;
      if (rebuildCue) {
        let html = '';
        for (const s of scopeSongs) {
          const cs = (s.cues || []).filter(c => _ovField(c, cueType));
          if (!cs.length) continue;
          const sid    = _ovEsc(s.id || s.timecode);
          const sStart = parseTC(s.timecode);
          html += `<div class="ov-cue-song-hdr" id="ov-ch-${sid}" data-songid="${sid}">${_ovEsc(s.trackName)}</div>`;
          for (const c of s.cues) {
            const text = _ovField(c, cueType);
            if (!text) continue;
            const absF = sStart + parseTC(c.offset);
            html += `<div class="ov-cue-row" id="ov-ci-${_ovEsc(c.id)}" data-abs="${absF}" data-cueid="${_ovEsc(c.id)}">
              <div class="ov-cue-head"><span class="ov-cue-tc">${_ovEsc(c.offset)}</span><span class="ov-cue-cd"></span></div>
              <span class="ov-cue-text">${_ovEsc(text)}</span>
              <div class="ov-cue-bar"><div class="ov-cue-fill"></div></div>
            </div>`;
          }
        }
        cueBody.innerHTML = html;
        this._cueListSong = scopeKey;
        // Cache fill/countdown elements for the rAF loop.
        this._cueEls = Array.from(cueBody.querySelectorAll('.ov-cue-row')).map(row => ({
          abs: parseInt(row.dataset.abs || '0'),
          fill: row.querySelector('.ov-cue-fill'),
          cd: row.querySelector('.ov-cue-cd')
        }));
        delete cueBody.dataset.markerState;
      }
      this._paintBars();
      this._startBarLoop();

      if (cueBody.dataset.markerState !== markerState) {
        // Mark past/active on cue rows using data-abs
        cueBody.querySelectorAll('.ov-cue-row').forEach(el => {
          const abs = parseInt(el.dataset.abs || '0');
          el.classList.remove('past', 'active');
          if (abs < nowF) el.classList.add('past');
        });
        // Override: active cue is not past
        if (liveCueId) {
          const activeRow = document.getElementById('ov-ci-' + liveCueId);
          if (activeRow) {
            activeRow.classList.remove('past');
            activeRow.classList.add('active');
            _ovScrollCenter(cueBody, activeRow);
          }
        }

        // Mark past/active on song headers
        cueBody.querySelectorAll('.ov-cue-song-hdr').forEach(el => {
          const songid = el.dataset.songid;
          const sIdx   = State.songs.findIndex(s => (s.id || s.timecode) == songid);
          el.classList.remove('past', 'active');
          if (sIdx >= 0 && sIdx < curSongArrIdx) el.classList.add('past');
          else if (sIdx === curSongArrIdx)        el.classList.add('active');
        });

        cueBody.dataset.markerState = markerState;
      }
    }
  }
};
