'use strict';
// ArtNet Timecode receiver (Art-TimeCode packets on UDP 6454)
// Art-TimeCode OpCode = 0x9700 (little-endian 0x00 0x97)

const dgram = require('dgram');

let activeSockets = [];

function parsePacket(buf, cb) {
  if (buf.length < 19) return;
  if (buf.toString('ascii', 0, 7) !== 'Art-Net') return;
  const opCode = buf.readUInt16LE(8);
  if (opCode !== 0x9700) return; // Art-TimeCode opcode

  // Layout: [ID 8][OpCode 2][ProtVer 2][Filler 2][Frames 1][Seconds 1][Minutes 1][Hours 1][Type 1]
  const frames  = buf[14];
  const seconds = buf[15];
  const minutes = buf[16];
  const hours   = buf[17];
  const tc = [hours, minutes, seconds, frames].map(n => String(n).padStart(2, '0')).join(':');
  console.log(`[ArtNet TC] ${tc}`);
  cb(tc);
}

function makeSocket(bindAddr, cb) {
  const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  s.on('message', (buf) => parsePacket(buf, cb));
  s.on('error', (e) => console.error(`[ArtNet TC ${bindAddr}]`, e.message));
  s.bind(6454, bindAddr, () => {
    try { s.setBroadcast(true); } catch (_) {}
    console.log(`[ArtNet TC] Listening on ${bindAddr}:6454`);
  });
  return s;
}

exports.stop = function stop() {
  for (const s of activeSockets) {
    try { s.close(); } catch (_) {}
  }
  activeSockets = [];
};

// addresses: array of IP strings to bind on.
// 'all' or omitted → 0.0.0.0 (network) + 127.0.0.1 (loopback).
// Specific IP → that IP + 127.0.0.1 (loopback always included for local sources).
exports.start = function start(cb, addresses) {
  exports.stop();

  let addrs;
  if (!addresses || addresses === 'all' || (Array.isArray(addresses) && addresses.includes('all'))) {
    addrs = ['0.0.0.0', '127.0.0.1'];
  } else {
    addrs = Array.isArray(addresses) ? addresses : [addresses];
    // Always include loopback so local TC apps (Timecode Monitor etc.) still work
    if (!addrs.includes('127.0.0.1')) addrs.push('127.0.0.1');
  }

  for (const addr of addrs) {
    activeSockets.push(makeSocket(addr, cb));
  }
};
