/**
 * discovery: lets a watch on the same Wi-Fi find this bridge with no typing.
 *
 * Two values are unavoidable on the watch — a relay address and a token — and
 * typing either on a watch keyboard is the worst part of setting this up. On a
 * LAN neither needs to be typed: the bridge is already reachable, so it can
 * answer a probe and hand them over.
 *
 * Protocol
 * --------
 * UDP, no connection, port {@link DISCOVERY_PORT}. The watch broadcasts a probe
 * to every interface's broadcast address; each bridge on the network answers
 * directly to the sender.
 *
 *   probe     { "dsh": "watch-dsh", "v": 1, "probe": true }
 *   response  { "dsh": "watch-dsh", "v": 1, "pcId": …, "relayUrl": …,
 *               "relayToken": … }
 *
 * Safety
 * ------
 * Routers do not forward broadcasts between subnets, so a probe reaches the
 * local network and nothing beyond it. The response carries the relay token,
 * which is what a LAN observer could already read from the ws:// URL, so
 * discovery does not widen exposure. What it deliberately does not carry is the
 * pairing secret: that is the end-to-end key, and the bridge hands it to a watch
 * only after the relay has authenticated the token.
 */

import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';

/** UDP port the bridge listens on and the watch broadcasts to. */
export const DISCOVERY_PORT = 8788;

/** Magic value identifying this protocol. */
const MAGIC = 'watch-dsh';

/** Protocol version; a probe with another version is ignored. */
const VERSION = 1;

/**
 * Start answering discovery probes.
 *
 * @param options - how to describe this bridge, and an optional port override
 *   (tests use a non-default port so they cannot collide with a real bridge).
 * @returns a handle whose `close()` stops the responder.
 */
export function startDiscovery({ pcId, relayUrl, relayToken, port = DISCOVERY_PORT, onProbe }) {
  const socket = createSocket({ type: 'udp4', reuseAddr: true });

  socket.on('error', (error) => {
    // A port already in use is the one failure worth reporting: it means another
    // bridge owns discovery, and silently answering nothing would look like a
    // broken network rather than a configuration clash.
    onProbe?.({ kind: 'error', message: error.message });
  });

  socket.on('message', (message, sender) => {
    let probe;
    try {
      probe = JSON.parse(message.toString('utf8'));
    } catch {
      return;
    }
    if (probe?.dsh !== MAGIC || probe?.v !== VERSION || probe?.probe !== true) return;

    // The reply is sent from the socket that received the probe, so the source
    // address is automatically one the watch can reach.
    const response = Buffer.from(
      JSON.stringify({ dsh: MAGIC, v: VERSION, pcId, relayUrl, relayToken }),
      'utf8',
    );
    socket.send(response, sender.port, sender.address, (error) => {
      if (error) onProbe?.({ kind: 'error', message: error.message });
      else onProbe?.({ kind: 'answered', address: sender.address });
    });
  });

  socket.bind(port, () => {
    // Binding to the wildcard address is what lets one responder serve every
    // interface, including a Wi-Fi adapter that changes address.
    onProbe?.({ kind: 'listening', port, addresses: localAddresses() });
  });

  return {
    port,
    /** Stop listening. */
    close() {
      try {
        socket.close();
      } catch {
        // Already closed; nothing to release.
      }
    },
  };
}

/** This machine's non-internal IPv4 addresses, for logging. */
function localAddresses() {
  const found = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && entry.internal !== true) found.push(entry.address);
    }
  }
  return found;
}

/**
 * Ask the local network for bridges, as the watch does.
 *
 * This exists so the discovery path can be tested from the PC without a watch.
 *
 * @param options - how long to wait, and an optional port override.
 * @returns the responses received.
 */
export async function probeForBridges({ timeoutMs = 2000, port = DISCOVERY_PORT } = {}) {
  const socket = createSocket({ type: 'udp4', reuseAddr: true });
  const found = [];

  const closed = new Promise((resolve) => {
    socket.on('message', (message) => {
      try {
        const response = JSON.parse(message.toString('utf8'));
        if (response?.dsh === MAGIC && response?.v === VERSION) found.push(response);
      } catch {
        // A stray datagram on this port is not a bridge.
      }
    });
    socket.on('error', () => { resolve(); });
    setTimeout(resolve, timeoutMs);
  });

  await new Promise((resolve) => {
    socket.bind(() => {
      socket.setBroadcast(true);
      const probe = Buffer.from(JSON.stringify({ dsh: MAGIC, v: VERSION, probe: true }), 'utf8');
      for (const address of broadcastAddresses()) {
        socket.send(probe, port, address, () => undefined);
      }
      resolve();
    });
  });

  await closed;
  try {
    socket.close();
  } catch {
    // Already closed.
  }
  return found;
}

/**
 * Broadcast addresses to probe.
 *
 * The limited broadcast address reaches the local subnet on every interface,
 * which is enough here and avoids computing a per-interface subnet broadcast.
 */
function broadcastAddresses() {
  return ['255.255.255.255'];
}
