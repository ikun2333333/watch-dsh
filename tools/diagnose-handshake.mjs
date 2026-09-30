/**
 * Diagnose the bridge's command handling with frames built exactly as the watch
 * builds them.
 *
 * This exists because a watch produces no readable console: when a handshake
 * hangs there is no way to tell whether the bridge ignored the request or the
 * watch could not read the answer. Driving the same bytes from here separates
 * those two, and it is also how the Kotlin and Node sealing implementations are
 * proved compatible without a device.
 *
 * Usage: node tools/diagnose-handshake.mjs
 */

import { readFileSync } from 'node:fs';
import { loadWebSocket } from '../packages/dsh-bridge/src/deps.mjs';
import { COMMANDS, PROTOCOL_VERSION, command, openFrame, sealFrame } from '../packages/dsh-bridge/src/protocol.mjs';

const { WebSocket } = loadWebSocket();

const config = JSON.parse(readFileSync('.state/watch-config.json', 'utf8'));
console.log(`target: pc=${config.pcId} relay=${config.relayUrl}`);

const url = new URL('/watch', config.relayUrl);
url.searchParams.set('token', config.relayToken);
url.searchParams.set('pc', config.pcId);
const socket = new WebSocket(url);

const socketOpen = new Promise((resolve, reject) => {
  socket.once('open', () => { resolve(true); });
  socket.once('error', reject);
});

/** Resolves with the next frame, decoding sealed ones with the config secret. */
function nextFrame(timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('no frame')); }, timeoutMs);
    const onMessage = (data) => {
      let envelope;
      try {
        envelope = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (envelope?.t === 'ready' || envelope?.t === 'watch-online' || envelope?.t === 'watch-offline') return;
      socket.off('message', onMessage);
      clearTimeout(timer);
      void (async () => {
        if (envelope.t !== 'sealed') {
          resolve({ raw: envelope });
          return;
        }
        const frame = await openFrame(config.pairingSecret, 'b2w', envelope);
        resolve(frame === undefined ? { undecryptable: true } : frame);
      })();
    };
    socket.on('message', onMessage);
  });
}

await socketOpen;
console.log('connected; sending hello sealed with the config secret');

const hello = await sealFrame(
  config.pairingSecret,
  'w2b',
  command('diag-1', COMMANDS.HELLO, { app: 'diagnose', protocol: PROTOCOL_VERSION }),
);
socket.send(JSON.stringify(hello));

try {
  const reply = await nextFrame();
  console.log('reply:', JSON.stringify(reply).slice(0, 400));
} catch (error) {
  console.log('no reply:', error.message);
}

// A second command proves the session flow, not just the handshake.
const sessions = await sealFrame(config.pairingSecret, 'w2b', command('diag-2', COMMANDS.SESSIONS, {}));
socket.send(JSON.stringify(sessions));
try {
  const reply = await nextFrame();
  const count = Array.isArray(reply.sessions) ? reply.sessions.length : '?';
  console.log(`sessions reply: ok=${String(reply.ok)} count=${String(count)}`);
} catch (error) {
  console.log('no sessions reply:', error.message);
}

socket.close();
