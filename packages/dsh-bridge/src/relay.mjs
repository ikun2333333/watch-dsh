/**
 * relay: a Node deployment of the watch ⇄ bridge meeting point.
 *
 * Use this when you have somewhere always-on to run it (a home server, a VPS, a
 * container host). When you have nowhere to run it, `relay-worker.mjs` deploys
 * the same routing logic to Cloudflare's free Workers tier instead.
 *
 * The relay authenticates both peers with a shared token, tracks which PC ids
 * are online, and copies opaque sealed frames between them. It holds no sealing
 * key: it can route traffic but cannot read or forge it.
 *
 * Topology
 * --------
 *   watch ──wss──▶ /watch?token=…&pc=<id> ──┐
 *                                           ├─ relay ─ copy frames by pcId
 *   pc    ──wss──▶ /pc?token=…&pc=<id>    ──┘
 *
 * Both sides dial *out*, so no inbound port, no port forwarding, and no static
 * address are required anywhere.
 *
 * Usage:
 *   node src/relay.mjs --port 8787 --token <shared-token>
 *   node src/relay.mjs --port 8787 --token-file .state/relay-token --verbose
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { loadWebSocket } from './deps.mjs';
import { PC_ROLE, RelayCore, WATCH_ROLE } from './relay-core.mjs';

const { WebSocketServer, WebSocket } = loadWebSocket();

/** Parse `--flag value` pairs and bare `--bool` switches. */
function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const port = Number(args.port ?? process.env.WATCH_DSH_RELAY_PORT ?? 8787);
const host = String(args.host ?? process.env.WATCH_DSH_RELAY_HOST ?? '0.0.0.0');
const token = String(
  args.token
  ?? (args['token-file'] === undefined
    ? process.env.WATCH_DSH_RELAY_TOKEN ?? ''
    : readFileSync(String(args['token-file']), 'utf8').trim()),
);
if (token === '') {
  console.error('relay: a shared token is required (--token, --token-file, or WATCH_DSH_RELAY_TOKEN)');
  process.exit(2);
}
const verbose = args.verbose === true;

/** Constant-time token comparison over UTF-8 bytes. */
function tokenMatches(candidate) {
  const actual = Buffer.from(String(candidate ?? ''), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

const core = new RelayCore();

const server = createServer((request, response) => {
  // A plain HTTP surface keeps the relay observable without opening a socket.
  if (request.url === '/healthz') {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ ok: true, protocol: 1, peers: core.describe() }));
    return;
  }
  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('watch-dsh relay: connect over websocket at /pc or /watch\n');
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', 'http://relay.invalid');
  const role = url.pathname === '/pc' ? PC_ROLE : url.pathname === '/watch' ? WATCH_ROLE : undefined;
  const pcId = url.searchParams.get('pc') ?? '';
  // Logged before any validation: whether an upgrade request arrives at all is
  // what separates "the relay refused it" from "the network never delivered it",
  // and those two faults look identical from the client side.
  if (verbose) {
    console.log(`relay: upgrade attempt from ${String(request.socket.remoteAddress)} path=${url.pathname} hasToken=${url.searchParams.has('token')} hasPc=${pcId !== ''}`);
  }
  if (role === undefined) {
    socket.destroy();
    return;
  }
  if (!tokenMatches(url.searchParams.get('token') ?? '')) {
    if (verbose) console.log(`relay: rejected ${role} with a bad token`);
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  if (pcId === '') {
    if (verbose) console.log(`relay: rejected ${role} without a pc id`);
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request, { role, pcId });
  });
});

/** Adapt a `ws` socket to the transport surface {@link RelayCore} expects. */
function peerOf(socket) {
  return {
    send: (text) => { if (socket.readyState === WebSocket.OPEN) socket.send(text, { binary: false }); },
    close: (code, reason) => { socket.close(code, reason); },
  };
}

wss.on('connection', (socket, _request, { role, pcId }) => {
  const peer = peerOf(socket);
  const { watchId, pcOnline, notices } = core.join(peer, role, pcId);
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
  if (verbose) console.log(`relay: ${role} attached to ${pcId} (${JSON.stringify(core.describe())})`);

  // Tell the newcomer who else is present, then deliver the notices the join
  // implied (a PC learning about waiting watches, or a PC learning about a new watch).
  socket.send(JSON.stringify({
    t: 'ready',
    role,
    pcId,
    pcOnline,
    ...(watchId === undefined ? {} : { from: watchId }),
  }));
  for (const notice of notices) notice.peer.send(notice.text);

  socket.on('message', (data) => {
    const text = typeof data === 'string' ? data : data.toString();
    const output = core.route(peer, role, pcId, watchId, text);
    if (output.length === 0 && verbose) console.log(`relay: ${role} frame had no route`);
    for (const frame of output) frame.peer.send(frame.text);
  });

  socket.on('close', () => {
    // `leave` computes which survivors must be told; the core stays the single
    // source of truth for who is online.
    for (const notice of core.leave(peer, role, pcId, watchId)) notice.peer.send(notice.text);
    if (verbose) console.log(`relay: ${role} detached from ${pcId} (${JSON.stringify(core.describe())})`);
  });

  socket.on('error', (error) => {
    if (verbose) console.log(`relay: ${role} socket error: ${error.message}`);
  });
});

// Detect dead peers so a half-open mobile connection is not treated as online.
const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    client.ping();
  }
}, 25_000);

server.listen(port, host, () => {
  console.log(`relay: listening on ws://${host}:${String(port)}  (/pc and /watch, token ${String(token.length)} chars)`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    clearInterval(heartbeat);
    console.log('\nrelay: shutting down');
    for (const client of wss.clients) client.close(1001, 'relay shutting down');
    server.close(() => { process.exit(0); });
  });
}
