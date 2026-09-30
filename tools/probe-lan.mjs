/**
 * Probe whether this machine can reach its own LAN address on the relay port.
 *
 * A relay bound to `0.0.0.0` is reachable over loopback by construction, but the
 * path a watch actually takes is the LAN address. Those two can differ when a
 * firewall, a VPN adapter, or the network profile treats inbound traffic on the
 * physical adapter differently, so this measures the LAN path specifically.
 *
 * Usage: node tools/probe-lan.mjs [ip] [port]
 */

import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';

const port = Number(process.argv[3] ?? 8787);
const explicit = process.argv[2];

/** Every non-internal IPv4 address on this machine. */
function lanAddresses() {
  const found = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && entry.internal !== true) found.push({ name, address: entry.address });
    }
  }
  return found;
}

const targets = explicit !== undefined
  ? [{ name: 'explicit', address: explicit }]
  : [{ name: 'loopback', address: '127.0.0.1' }, ...lanAddresses()];

console.log(`probing TCP port ${String(port)}`);
for (const target of targets) {
  const started = Date.now();
  const ok = await new Promise((resolve) => {
    const socket = connect({ host: target.address, port, timeout: 3000 });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
  });
  console.log(`  ${target.name.padEnd(10)} ${target.address.padEnd(16)} ${ok ? 'REACHABLE' : 'unreachable'}  (${String(Date.now() - started)}ms)`);
}
