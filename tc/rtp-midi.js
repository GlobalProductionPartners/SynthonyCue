'use strict';
// RTP-MIDI timecode receiver via node-rtpmidi

exports.start = function start(cb) {
  const rtpMidi = require('node-rtpmidi');
  const session = rtpMidi.manager.createSession({ localName: 'Synthony-TC', bonjourName: 'Synthony TC', port: 5004 });

  session.on('ready', () => console.log('[RTP-MIDI] Session ready'));

  session.on('message', (_delta, msg) => {
    const [status, data1] = msg;

    // Quarter-frame 0xF1
    if (status === 0xF1) {
      // Delegate full assembly to a simple state machine
      rtpQF(data1, cb);
    }

    // Full-frame SysEx
    if (status === 0xF0 && msg[3] === 0x01 && msg[4] === 0x01) {
      const h = msg[5] & 0x1F;
      const m = msg[6];
      const s = msg[7];
      const f = msg[8];
      const tc = [h, m, s, f].map(n => String(n).padStart(2, '0')).join(':');
      if (cb) cb(tc);
    }
  });

  rtpMidi.manager.start();
};

const _qf = new Array(8).fill(0);
let _qfIdx = 0;

function rtpQF(data, cb) {
  const piece = (data >> 4) & 0x07;
  _qf[piece] = data & 0x0F;
  _qfIdx++;
  if (_qfIdx % 8 === 0 && piece === 7) {
    const frames = _qf[0] | (_qf[1] << 4);
    const secs   = _qf[2] | (_qf[3] << 4);
    const mins   = _qf[4] | (_qf[5] << 4);
    const hours  = _qf[6] | ((_qf[7] & 0x01) << 4);
    const tc = [hours, mins, secs, frames].map(n => String(n).padStart(2, '0')).join(':');
    if (cb) cb(tc);
  }
}
