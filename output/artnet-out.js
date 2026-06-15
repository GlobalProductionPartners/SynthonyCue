'use strict';
// ArtNet DMX output sender

const dgram = require('dgram');

const socket = dgram.createSocket('udp4');

/**
 * Send a single DMX channel value via ArtNet
 * @param {string} host       - destination IP
 * @param {number} universe   - 0-indexed universe
 * @param {number} channel    - 1-indexed DMX channel
 * @param {number} value      - 0-255
 * @param {function} cb       - cb(err)
 */
exports.send = function send(host, universe, channel, value, cb) {
  try {
    const buf = buildArtDmx(universe, channel, value);
    socket.send(buf, 0, buf.length, 6454, host, (err) => {
      if (cb) cb(err || null);
    });
  } catch (e) {
    if (cb) cb(e);
  }
};

function buildArtDmx(universe, channel, value) {
  // ArtDmx packet: 18 byte header + 512 byte DMX data
  const buf = Buffer.alloc(18 + 512, 0);

  // ID: "Art-Net\0"
  buf.write('Art-Net\0', 0, 'ascii');
  // OpCode: OpDmx = 0x5000 (little-endian)
  buf.writeUInt16LE(0x5000, 8);
  // ProtVer: 14 (big-endian)
  buf.writeUInt16BE(14, 10);
  // Sequence: 0 (disabled)
  buf[12] = 0;
  // Physical: 0
  buf[13] = 0;
  // Universe: low byte, high byte
  buf.writeUInt16LE(universe & 0x7FFF, 14);
  // Length: 512 (big-endian)
  buf.writeUInt16BE(512, 16);
  // DMX data starts at byte 18; channel is 1-indexed
  const ch = Math.max(1, Math.min(512, channel));
  buf[18 + ch - 1] = Math.max(0, Math.min(255, value));

  return buf;
}
