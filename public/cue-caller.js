'use strict';
// Cue Readout — spoken cue calling in the browser (Web Speech API). Shared by
// admin and kiosk. It mirrors the server-side caller in server.js
// (checkCueFires) so a laptop, a display Pi and the server Pi all announce
// identically. Departments = spreadsheet cue-type columns.
//
// "What to call" (which departments, each department's style, the standby lead)
// is a SHARED show setting living in config.readout — edited by the admin,
// broadcast to everyone, and honoured by every caller. "How I speak" (this
// device's voice / rate / volume / on-off) is local to each device.
//
// Depends on cue-utils.js: State, FR, parseTC, customCueTypes, cueTypeColour.

const CALL_STYLES = [
  ['sg', 'Standby → GO'],
  ['sr', 'Standby → read cue'],
  ['go', 'GO only'],
  ['ro', 'Read cue only'],
];
const SRV_VOICES = [['en', 'English'], ['en-us', 'English (US)'], ['en-gb', 'English (UK)'],
  ['en+f3', 'Female'], ['en+m3', 'Male']];

function _crEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}

const Caller = {
  // This device (local)
  enabled:  localStorage.getItem('caller-enabled') === '1',
  voiceURI: localStorage.getItem('caller-voice') || '',
  rate:     parseFloat(localStorage.getItem('caller-rate'))   || 1,
  volume:   parseFloat(localStorage.getItem('caller-volume')) || 1,

  log: [],
  _spoken: new Set(),
  _voices: [],
  _raf: null,
  _srcFrames: -1, _anchorWall: 0, _last: 0, _lastEval: 0,
  _sig: null, _wired: false,

  get ADMIN() { return !!window.__ADMIN__; },

  // ── Shared "what to call" (config.readout) ──────────────────────────────────
  _cfg() { return (State.config && State.config.readout) || { lead: 10, depts: {} }; },
  lead() { return this._cfg().lead || 10; },
  dept(type) { return (this._cfg().depts || {})[type] || { on: false, style: 'sg' }; },

  _save() {
    localStorage.setItem('caller-enabled', this.enabled ? '1' : '0');
    localStorage.setItem('caller-voice', this.voiceURI);
    localStorage.setItem('caller-rate', this.rate);
    localStorage.setItem('caller-volume', this.volume);
  },

  // Push a change to the shared readout config (admin only — server gates it).
  _saveShared(patch) {
    if (!this.ADMIN || typeof wsSend !== 'function') return;
    const next = { ...(this._cfg()), ...patch };
    if (State.config) State.config.readout = next;   // optimistic
    wsSend({ type: 'save_config', config: { readout: next } });
  },

  // ── Voices ──────────────────────────────────────────────────────────────────
  init() {
    if ('speechSynthesis' in window) {
      this._loadVoices();
      speechSynthesis.onvoiceschanged = () => { this._loadVoices(); if (this._active()) this.render(); };
    }
    if (this.enabled) this._startEngine();
  },
  _loadVoices() { try { this._voices = speechSynthesis.getVoices() || []; } catch { this._voices = []; } },
  _active() { const r = document.getElementById('view-cueread'); return r && r.offsetParent !== null; },

  // ── Speech ────────────────────────────────────────────────────────────────
  speak(text) {
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(text);
      const v = this._voices.find(v => v.voiceURI === this.voiceURI);
      if (v) u.voice = v;
      u.rate = this.rate; u.volume = this.volume;
      try { speechSynthesis.speak(u); } catch {}
    }
    this._pushLog(text);
  },
  _pushLog(text) {
    this.log.unshift({ t: Date.now(), text });
    if (this.log.length > 50) this.log.length = 50;
    if (this._active()) this._renderLog();
  },

  // ── Engine ──────────────────────────────────────────────────────────────────
  // Interpolate "now" between the ~per-frame TC updates so GO lands on time.
  _nowFrames() {
    const src = State.tcFrames || parseTC(State.tc || '00:00:00:00');
    if (src !== this._srcFrames) { this._srcFrames = src; this._anchorWall = performance.now(); }
    if (!State.tcRunning) return src;
    return src + ((performance.now() - this._anchorWall) / 1000) * FR;
  },

  setEnabled(on) {
    on = !!on;
    if (on === this.enabled) return;
    this.enabled = on; this._save();
    if (on) { this._spoken.clear(); this._startEngine(); }
    else { try { speechSynthesis.cancel(); } catch {} }
    if (this._active()) this._refresh();
  },
  toggle() { this.setEnabled(!this.enabled); },

  _startEngine() {
    if (this._raf) return;
    const loop = () => {
      if (!this.enabled) { this._raf = null; return; }
      this._evaluate();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  },

  // All standby/go moments across the show, for the enabled departments.
  _events() {
    const out = [];
    const leadF = this.lead() * FR;
    const depts = this._cfg().depts || {};
    for (const song of (State.songs || [])) {
      const sf = parseTC(song.timecode);
      for (const cue of (song.cues || [])) {
        const cf = sf + parseTC(cue.offset);
        for (const type in (cue.extra || {})) {
          const text = cue.extra[type];
          const d = depts[type];
          if (!text || !d || !d.on) continue;
          const style = d.style || 'sg';
          // Spoken lines deliberately omit the department name (the column
          // headers are long and awkward aloud) — just "Standby, <cue>" / "Go".
          if (style === 'sg' || style === 'sr')
            out.push({ at: cf - leadF, cueId: cue.id, type, phase: 'sb', line: `Standby, ${text}` });
          const go = (style === 'sr' || style === 'ro') ? String(text) : 'Go';
          out.push({ at: cf, cueId: cue.id, type, phase: 'go', line: go });
        }
      }
    }
    return out;
  },

  _evaluate() {
    if (!this.enabled) return;
    const now = this._nowFrames();
    // Backward jump → forget what's been said and drop anything queued.
    if (now < this._last - 50) { this._spoken.clear(); try { speechSynthesis.cancel(); } catch {} }
    this._last = now;
    if (!State.tcRunning) return;
    // 10 Hz is ample — TTS latency dwarfs a frame, and it keeps a big show cheap.
    if (performance.now() - this._lastEval < 100) return;
    this._lastEval = performance.now();
    const WINDOW = 2 * FR;
    for (const e of this._events()) {
      const k = `${e.cueId}:${e.type}:${e.phase}`;
      if (now >= e.at && now < e.at + WINDOW && !this._spoken.has(k)) {
        this._spoken.add(k); this.speak(e.line);
      }
    }
  },

  test() { this.speak('Synthony cue readout test. Stage, go.'); },
  testServer() { if (typeof wsSend === 'function') wsSend({ type: 'test_readout' }); },

  // ── Shared-config setters (admin) ─────────────────────────────────────────
  setLead(v) { this._saveShared({ lead: Math.max(3, Math.min(60, parseInt(v) || 10)) }); },
  setDeptOn(type, on) {
    const depts = { ...(this._cfg().depts || {}) };
    depts[type] = { ...(depts[type] || { style: 'sg' }), on: !!on };
    this._saveShared({ depts });
    if (this._active()) this._renderNext();
  },
  setDeptStyle(type, style) {
    const depts = { ...(this._cfg().depts || {}) };
    depts[type] = { ...(depts[type] || { on: true }), style };
    this._saveShared({ depts });
    if (this._active()) this._renderNext();
  },

  // ── This-device setters ───────────────────────────────────────────────────
  setVoice(uri)  { this.voiceURI = uri; this._save(); },
  setRate(v)     { this.rate = parseFloat(v) || 1; this._save(); },
  setVolume(v)   { this.volume = parseFloat(v) || 1; this._save(); },

  // ── Server-caller setters (admin) ─────────────────────────────────────────
  setServerEnabled(on) { this._saveShared({ enabled: !!on }); if (this._active()) this._refresh(); },
  setServerVoice(v)    { this._saveShared({ voice: v }); },
  setServerRate(v)     { this._saveShared({ rate: parseInt(v) || 175 }); },

  // ── View ────────────────────────────────────────────────────────────────────
  render() {
    const root = document.getElementById('view-cueread');
    if (!root) return;
    this._loadVoices();
    const sig = customCueTypes().join('|') + '|' + (this.ADMIN ? 'a' : 'k') + '|' + this._voices.length;
    if (sig !== this._sig) { this._sig = sig; root.innerHTML = this._html(); this._wire(root); }
    this._refresh();
    this._renderNext();
    this._renderLog();
  },

  _html() {
    const types = customCueTypes();
    const admin = this.ADMIN;
    const voiceOpts = this._voices.length
      ? this._voices.map(v => `<option value="${_crEsc(v.voiceURI)}"${v.voiceURI === this.voiceURI ? ' selected' : ''}>${_crEsc(v.name)} (${_crEsc(v.lang)})</option>`).join('')
      : '<option value="">— no voices on this device —</option>';
    const styleOpts = sel => CALL_STYLES.map(([v, l]) => `<option value="${v}"${v === sel ? ' selected' : ''}>${l}</option>`).join('');
    const dis = admin ? '' : ' disabled';

    const deptRows = types.length ? types.map(t => {
      const d = this.dept(t);
      return `<div class="cr-dept">
        <span class="cr-dot" style="background:${cueTypeColour(t)}"></span>
        <input type="checkbox" data-act="dept-on" data-type="${_crEsc(t)}" ${d.on ? 'checked' : ''}${dis}>
        <span class="cr-dept-name">${_crEsc(t)}</span>
        <select data-act="dept-style" data-type="${_crEsc(t)}"${dis}>${styleOpts(d.style || 'sg')}</select>
      </div>`;
    }).join('') : '<div class="cr-empty">No cue types in this show yet.</div>';

    const cfg = this._cfg();
    const serverPanel = admin ? `
      <div class="cr-panel">
        <div class="cr-panel-h">🎛 Server readout <span class="cr-sub">(this server's audio out)</span></div>
        <button class="cr-switch${cfg.enabled ? ' on' : ''}" data-act="srv-toggle">${cfg.enabled ? 'CALLING ●' : 'OFF'}</button>
        <label class="cr-field">Voice
          <select data-act="srv-voice">${SRV_VOICES.map(([v, l]) => `<option value="${v}"${v === (cfg.voice || 'en') ? ' selected' : ''}>${l}</option>`).join('')}</select>
        </label>
        <label class="cr-field">Rate <input type="number" min="80" max="400" step="5" value="${cfg.rate || 175}" data-act="srv-rate" style="width:70px"></label>
        <button class="cr-btn" data-act="srv-test">Test server voice</button>
        <div class="cr-note">espeak-ng out the server Pi's jack/USB. Robotic but always available.</div>
      </div>` : '';

    return `
    <div class="cr-head">
      <button class="cr-switch cr-master${this.enabled ? ' on' : ''}" data-act="dev-toggle">${this.enabled ? '🔊 CALLING ●' : '🔇 READOUT OFF'}</button>
      <span class="cr-tc" id="cr-tc">${_crEsc(State.tc || '00:00:00:00')}</span>
    </div>

    <div class="cr-grid">
      <div class="cr-col">
        <div class="cr-panel">
          <div class="cr-panel-h">What to call ${admin ? '' : '<span class="cr-sub">(set by admin)</span>'}</div>
          <label class="cr-field">Standby lead
            <input type="number" min="3" max="60" value="${cfg.lead || 10}" data-act="lead" style="width:64px"${dis}> s
          </label>
          <div class="cr-depts">${deptRows}</div>
        </div>

        <div class="cr-panel">
          <div class="cr-panel-h">🔊 This device <span class="cr-sub">(browser voice)</span></div>
          <label class="cr-field">Voice <select data-act="dev-voice" ${this._voices.length ? '' : 'disabled'}>${voiceOpts}</select></label>
          <label class="cr-field">Rate <input type="range" min="0.6" max="1.6" step="0.05" value="${this.rate}" data-act="dev-rate"></label>
          <label class="cr-field">Volume <input type="range" min="0" max="1" step="0.05" value="${this.volume}" data-act="dev-volume"></label>
          <button class="cr-btn" data-act="dev-test">Test voice</button>
          ${this._voices.length ? '' : '<div class="cr-note cr-warn">No speech voices on this device. On a Raspberry Pi: <code>sudo apt install speech-dispatcher espeak-ng</code>, or use the server readout.</div>'}
        </div>

        ${serverPanel}
      </div>

      <div class="cr-col">
        <div class="cr-panel cr-flex">
          <div class="cr-panel-h">Next</div>
          <div class="cr-next" id="cr-next"></div>
        </div>
        <div class="cr-panel cr-flex">
          <div class="cr-panel-h">Call log</div>
          <div class="cr-log" id="cr-log"></div>
        </div>
      </div>
    </div>`;
  },

  _wire(root) {
    if (root._crWired) return;
    root._crWired = true;
    const handle = (e) => {
      const el = e.target.closest('[data-act]');
      if (!el || !root.contains(el)) return;
      const act = el.dataset.act, type = el.dataset.type;
      switch (act) {
        case 'dev-toggle': this.toggle(); break;
        case 'dev-voice':  this.setVoice(el.value); break;
        case 'dev-rate':   this.setRate(el.value); break;
        case 'dev-volume': this.setVolume(el.value); break;
        case 'dev-test':   this.test(); break;
        case 'lead':       this.setLead(el.value); break;
        case 'dept-on':    this.setDeptOn(type, el.checked); break;
        case 'dept-style': this.setDeptStyle(type, el.value); break;
        case 'srv-toggle': this.setServerEnabled(!this._cfg().enabled); break;
        case 'srv-voice':  this.setServerVoice(el.value); break;
        case 'srv-rate':   this.setServerRate(el.value); break;
        case 'srv-test':   this.testServer(); break;
      }
    };
    root.addEventListener('click', e => { if (e.target.closest('button[data-act]')) handle(e); });
    root.addEventListener('change', e => { if (e.target.closest('select[data-act],input[data-act]')) handle(e); });
  },

  _refresh() {
    const tc = document.getElementById('cr-tc'); if (tc) tc.textContent = State.tc || '00:00:00:00';
    const m = document.querySelector('#view-cueread .cr-master');
    if (m) { m.classList.toggle('on', this.enabled); m.textContent = this.enabled ? '🔊 CALLING ●' : '🔇 READOUT OFF'; }
    const s = document.querySelector('#view-cueread [data-act="srv-toggle"]');
    if (s) { const on = !!this._cfg().enabled; s.classList.toggle('on', on); s.textContent = on ? 'CALLING ●' : 'OFF'; }
  },

  _renderNext() {
    const el = document.getElementById('cr-next'); if (!el) return;
    const now = this._nowFrames();
    const up = this._events().filter(e => e.at > now - FR).sort((a, b) => a.at - b.at).slice(0, 8);
    if (!up.length) { el.innerHTML = '<div class="cr-empty">Nothing armed — tick some departments.</div>'; return; }
    el.innerHTML = up.map(e => {
      const dt = Math.max(0, Math.round((e.at - now) / FR));
      const mm = String(Math.floor(dt / 60)).padStart(2, '0'), ss = String(dt % 60).padStart(2, '0');
      const tag = e.phase === 'go' ? 'GO' : 'SB';
      return `<div class="cr-next-row ${e.phase}">
        <span class="cr-dot" style="background:${cueTypeColour(e.type)}"></span>
        <span class="cr-next-tag">${tag}</span>
        <span class="cr-next-type">${_crEsc(e.type)}</span>
        <span class="cr-next-line">${_crEsc(e.line)}</span>
        <span class="cr-next-cd">-${mm}:${ss}</span>
      </div>`;
    }).join('');
  },

  _renderLog() {
    const el = document.getElementById('cr-log'); if (!el) return;
    if (!this.log.length) { el.innerHTML = '<div class="cr-empty">No calls yet.</div>'; return; }
    el.innerHTML = this.log.map(l => {
      const d = new Date(l.t), hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0'), ss = String(d.getSeconds()).padStart(2, '0');
      return `<div class="cr-log-row"><span class="cr-log-t">${hh}:${mm}:${ss}</span><span>${_crEsc(l.text)}</span></div>`;
    }).join('');
  },
};
