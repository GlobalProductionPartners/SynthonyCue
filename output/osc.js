'use strict';
// OSC output sender via node-osc

const { Client } = require('node-osc');

// Cache clients by host:port to avoid recreating sockets
const clientCache = new Map();

function getClient(host, port) {
  const key = `${host}:${port}`;
  if (!clientCache.has(key)) {
    clientCache.set(key, new Client(host, port));
  }
  return clientCache.get(key);
}

/**
 * Send an OSC message
 * @param {string} host
 * @param {number} port
 * @param {string} address  - OSC address e.g. '/cue/fire'
 * @param {string} args     - space-separated args e.g. '1 hello 3.14'
 * @param {function} cb     - cb(err)
 */
exports.send = function send(host, port, address, args, cb) {
  try {
    const client = getClient(host, Number(port));
    const parsed = parseArgs(args);
    client.send(address, ...parsed, (err) => {
      if (cb) cb(err || null);
    });
  } catch (e) {
    if (cb) cb(e);
  }
};

function parseArgs(str) {
  if (!str) return [];
  return String(str).trim().split(/\s+/).map(token => {
    if (/^-?\d+$/.test(token))        return parseInt(token, 10);
    if (/^-?\d*\.\d+$/.test(token))   return parseFloat(token);
    if (token === 'true')              return true;
    if (token === 'false')             return false;
    return token;
  });
}
