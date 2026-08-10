'use strict';
// ArtNet Timecode receiver (Art-TimeCode packets on UDP 6454)
// Art-TimeCode OpCode = 0x9700 (little-endian 0x00 0x97)

const dgram = require('dgram');
const os    = require('os');

let activeSockets = [];
let lastLogged    = '';

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
  // Log on the second, not every frame — timecode arrives 25-30x/sec.
  const stamp = tc.slice(0, 8);
  if (stamp !== lastLogged) { lastLogged = stamp; console.log(`[ArtNet TC] ${tc}`); }
  cb(tc);
}

function ipToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const b = Number(part);
    if (!Number.isInteger(b) || b < 0 || b > 255) return null;
    n = (n * 256) + b;
  }
  return n;
}

// Art-Net is broadcast, and a socket bound to a specific unicast address never
// receives broadcast datagrams. So we always bind the wildcard and apply the
// chosen interface as a filter on the sender instead of as a bind address.
// Returns null to accept everything, or a predicate on the source IP.
function makeFilter(addresses) {
  const wanted = (Array.isArray(addresses) ? addresses : [addresses])
    .filter(a => a != null && a !== '');
  if (!wanted.length || wanted.includes('all')) return null;

  const ifaces = os.networkInterfaces();
  const nets   = [];
  for (const want of wanted) {
    if (want === '127.0.0.1') continue; // loopback is always allowed below
    let matched = false;
    for (const addrs of Object.values(ifaces)) {
      for (const a of (addrs || [])) {
        if (a.family !== 'IPv4' || a.address !== want) continue;
        const ip   = ipToInt(a.address);
        const mask = ipToInt(a.netmask);
        if (ip !== null && mask !== null) { nets.push({ ip, mask }); matched = true; }
      }
    }
    // Address not on any live adapter (unplugged?) — fall back to an exact match
    if (!matched) {
      const ip = ipToInt(want);
      if (ip !== null) nets.push({ ip, mask: 0xFFFFFFFF });
    }
  }

  return function accept(srcIp) {
    if (srcIp === '127.0.0.1') return true; // local TC apps always allowed
    const src = ipToInt(srcIp);
    if (src === null) return false;
    return nets.some(({ ip, mask }) => ((src & mask) >>> 0) === ((ip & mask) >>> 0));
  };
}

function makeSocket(bindAddr, cb, accept) {
  const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  s.on('message', (buf, rinfo) => {
    if (accept && !accept(rinfo.address)) return;
    parsePacket(buf, cb);
  });
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
  lastLogged = '';
};

// addresses: 'all' (or omitted) accepts timecode from any sender.
// A specific interface IP accepts only senders on that adapter's subnet.
// Loopback senders are always accepted so local TC apps keep working.
exports.start = function start(cb, addresses) {
  exports.stop();

  const accept = makeFilter(addresses);
  // 0.0.0.0 is what actually receives broadcast Art-Net. The extra loopback
  // bind only wins the demux for unicast sent to 127.0.0.1, which another
  // wildcard listener on 6454 would otherwise take from us.
  activeSockets.push(makeSocket('0.0.0.0', cb, accept));
  activeSockets.push(makeSocket('127.0.0.1', cb, accept));

  const label = accept
    ? `senders on ${Array.isArray(addresses) ? addresses.join(', ') : addresses} (+ loopback)`
    : 'any sender';
  console.log(`[ArtNet TC] Accepting ${label}`);
};
