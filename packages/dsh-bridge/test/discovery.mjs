/**
 * Test LAN discovery and bootstrapping, the way the watch does it.
 *
 * The order matters and is the whole point of the design:
 *
 *   1. broadcast a probe            -> learn relay URL, token, pc id (no typing)
 *   2. send an unsealed `pair`      -> learn the pairing secret
 *   3. seal a `hello` with it       -> prove the secret works, then talk normally
 *
 * If this passes, a watch on the same Wi-Fi pairs with no typed input at all.
 *
 * This talks to whatever bridge is already on the LAN, so two conditions make it
 * report failures that are not code defects:
 *
 *   - A bridge pointed at a remote relay advertises a `wss://` URL, so steps 2
 *     and 3 exercise that relay instead of the local one.
 *   - The relay keeps one watch per pc id, so a real watch attached to the same
 *     bridge takes the slot and pushes this test's simulated watch out mid
 *     handshake.
 *
 * Stop the bridge, or disconnect the watch, before reading a failure here as
 * meaningful. The end-to-end suite is immune to both because it uses its own pc id.
 *
 * Usage: node test/discovery.mjs
 */

import { probeForBridges } from '../src/discovery.mjs';
import { loadWebSocket } from '../src/deps.mjs';
import { COMMANDS, PROTOCOL_VERSION, command, openFrame, pairRequest, sealFrame } from '../src/protocol.mjs';

const { WebSocket } = loadWebSocket();

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition) });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}`);
}

/** Brief JSON for log lines; `JSON.stringify(undefined)` is not a string. */
const brief = (value) => (JSON.stringify(value) ?? String(value)).slice(0, 140);

console.log('--- 1. probe the local network ---');
const found = await probeForBridges({ timeoutMs: 3000 });
check('a bridge answered the probe', found.length > 0, `${String(found.length)} response(s)`);
if (found.length === 0) {
  console.log('\nno bridge answered. Start one with: node packages/dsh-bridge/src/main.mjs --relay ws://127.0.0.1:8787 --token-file .state/relay-token --state .state');
  process.exit(1);
}

const answer = found[0];
console.log(`      pcId=${answer.pcId}  relayUrl=${answer.relayUrl}`);
check('the answer names a pc', typeof answer.pcId === 'string' && answer.pcId !== '');
check('the answer carries a dialable relay URL', /^wss?:\/\//u.test(answer.relayUrl ?? ''), String(answer.relayUrl));
check('the answer carries a relay token', typeof answer.relayToken === 'string' && answer.relayToken.length > 10);
check('the answer does not leak the pairing secret', answer.pairingSecret === undefined);

console.log('\n--- 2. connect with only the discovered values ---');
const url = new URL('/watch', answer.relayUrl);
url.searchParams.set('token', answer.relayToken);
url.searchParams.set('pc', answer.pcId);
const socket = new WebSocket(url);

const socketOpen = new Promise((resolve, reject) => {
  socket.once('open', () => { resolve(true); });
  socket.once('error', reject);
});

/**
 * Wait for the next application frame.
 *
 * The relay's own transport notices are skipped by their `t` value alone: a
 * pairing reply is also unsealed, so keying off `t` being absent would discard
 * the very frame this test needs.
 *
 * @param options - the secret to open sealed frames with, and a timeout.
 */
function nextFrame({ secret, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('timed out waiting for a frame')); }, timeoutMs);
    const transport = new Set(['ready', 'watch-online', 'watch-offline', 'peer-offline']);
    const onMessage = (data) => {
      let envelope;
      try {
        envelope = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (typeof envelope?.t === 'string' && transport.has(envelope.t)) return;
      socket.off('message', onMessage);
      clearTimeout(timer);
      void (async () => {
        if (envelope.t !== 'sealed') {
          // Unsealed application frame, i.e. a pairing reply.
          resolve(envelope);
          return;
        }
        if (secret === undefined) {
          resolve({ unopenable: true });
          return;
        }
        const frame = await openFrame(secret, 'b2w', envelope);
        resolve(frame ?? { failedToOpen: true });
      })();
    };
    socket.on('message', onMessage);
  });
}

await socketOpen;
check('the relay accepted the discovered token', true);

// The relay assigns this connection an id in its ready frame, and the bridge
// resolves the reply destination from it, so a pairing request must carry it.
console.log('\n--- 2b. learn this connection\'s relay id ---');
const ready = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { reject(new Error('no ready frame')); }, 5000);
  socket.on('message', (data) => {
    let frame;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (frame?.t !== 'ready') return;
    clearTimeout(timer);
    resolve(frame);
  });
});
check('the relay assigned this connection an id', typeof ready.from === 'string' && ready.from !== '', String(ready.from));

console.log('\n--- 3. pairing request supplies the end-to-end key ---');
socket.send(JSON.stringify(pairRequest('pair-1', ready.from, { protocol: PROTOCOL_VERSION })));
const pairReply = await nextFrame();
check('the pairing reply arrives unsealed and readable', pairReply.ok === true, brief(pairReply.error ?? pairReply.pcId));
const secret = pairReply.pairingSecret;
check('the reply carries a pairing secret', typeof secret === 'string' && secret.length >= 32, `${String(secret?.length ?? 0)} chars`);
check('the reply names the pc that answered', pairReply.pcId === answer.pcId, String(pairReply.pcId));

console.log('\n--- 4. the secret works for sealed traffic ---');
await sealFrame(secret, 'w2b', command('hello-1', COMMANDS.HELLO, { app: 'discovery-test' }))
  .then((envelope) => { socket.send(JSON.stringify(envelope)); });
const hello = await nextFrame({ secret });
check('a hello sealed with the discovered secret is answered', hello.ok === true, brief(hello.status ?? hello.error));
check('the handshake reports the harness state', typeof hello.status?.harness === 'string', String(hello.status?.harness));

console.log('\n--- 5. a wrong secret is refused ---');
socket.send(JSON.stringify(await sealFrame('definitely-not-the-secret', 'w2b', command('hello-2', COMMANDS.HELLO, {}))));
const refused = await nextFrame({ timeoutMs: 3000 }).then(() => 'replied').catch(() => 'silent');
check('a frame sealed with the wrong secret gets no reply', refused === 'silent', refused);

socket.close();
const failures = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
process.exit(failures.length === 0 ? 0 : 1);
