/**
 * main: the bridge process. It dials *out* to the relay, so the PC needs no
 * inbound port, no port forwarding, and no static address — which is what makes
 * a watch on mobile data able to reach it.
 *
 * Usage:
 *   node src/main.mjs --relay ws://127.0.0.1:8787 --token <relay-token> \
 *                     --pairing <pairing-secret> [--pc <id>] [--dsh http://127.0.0.1:3080]
 *
 * Configuration precedence: command line, then environment, then defaults.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { hostname, networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { Bridge } from './bridge.mjs';
import { readConfig, writeConfig } from './config.mjs';
import { loadDescriptors } from './descriptors.mjs';
import { startDiscovery } from './discovery.mjs';
import { loadWebSocket } from './deps.mjs';
import { openFrame, openFrameDiagnostic } from './protocol.mjs';

const { WebSocket } = loadWebSocket();

/**
 * Parse `--flag value` pairs and bare `--bool` switches.
 * @param argv - process arguments after the script.
 * @returns the parsed flags.
 */
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

/** Read a secret from a flag, a file, or the environment, generating one when asked. */
function resolveSecret(flagValue, fileValue, envValue, generate) {
  if (typeof flagValue === 'string') return flagValue;
  if (typeof fileValue === 'string') return readFileSync(fileValue, 'utf8').trim();
  if (typeof envValue === 'string' && envValue !== '') return envValue;
  if (!generate) return undefined;
  return randomBytes(24).toString('base64url');
}

const args = parseArgs(process.argv.slice(2));
const dshHome = String(args['dsh-home'] ?? process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh'));
const baseUrl = String(args.dsh ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080');
const stateDir = String(args.state ?? join(process.cwd(), '.state'));

// A config file supplies whatever the flags did not. This is what makes a remote
// setup reproducible: the file is a complete description of how to reach this
// bridge, so a rebuilt or second watch pairs from it with nothing typed.
/**
 * Read a non-empty string from a config file.
 *
 * `readConfig` returns `{ relayToken: '' }` rather than omitting a field, so a
 * blank value has to mean "absent" and fall through to the next source.
 */
function fromConfig(value) {
  return value === undefined || value === '' ? undefined : value;
}

const configPath = args.config === undefined ? join(stateDir, 'watch-config.json') : String(args.config);
const fileConfig = readConfig(configPath);
if (fileConfig !== undefined) {
  console.log(`main: read settings from ${configPath}`);
}

// Precedence is command line, then environment, then the config file, then a
// generated default. Each source is tried only when the previous one is absent.
const relayToken = resolveSecret(args.token, args['token-file'], process.env.WATCH_DSH_RELAY_TOKEN, false)
  ?? fromConfig(fileConfig?.relayToken);
if (relayToken === undefined) {
  console.error('main: a relay token is required (--token, --token-file, WATCH_DSH_RELAY_TOKEN, or a config file)');
  process.exit(2);
}

// The pairing secret is the end-to-end key between this PC and the watch. It is
// persisted so a restart does not force re-pairing the watch.
mkdirSync(stateDir, { recursive: true });
const pairingPath = join(stateDir, 'pairing-secret');
let pairing = resolveSecret(args.pairing, args['pairing-file'], process.env.WATCH_DSH_PAIRING, false)
  ?? fromConfig(fileConfig?.pairingSecret);
if (pairing === undefined) {
  if (existsSync(pairingPath)) {
    pairing = readFileSync(pairingPath, 'utf8').trim();
  } else {
    pairing = randomBytes(32).toString('base64url');
    writeFileSync(pairingPath, `${pairing}\n`, { mode: 0o600 });
    console.log(`main: generated a new pairing secret at ${pairingPath}`);
  }
}

const pcId = String(
  args.pc ?? process.env.WATCH_DSH_PC_ID
  ?? fromConfig(fileConfig?.pcId)
  ?? hostname().toLowerCase().replace(/[^a-z0-9-]/gu, '-'),
);
/**
 * Where a locally run relay listens.
 *
 * Used when this machine must advertise a relay for a *broadcast*, which is only
 * ever useful on this network. It is the port `lan-test.ps1` and the documented
 * local setup use.
 */
const LOCAL_RELAY_PORT = 8787;

/** Whether a relay URL points at this machine rather than somewhere durable. */
function isLocalRelay(url) {
  if (url === undefined) return false;
  try {
    const { hostname } = new URL(url);
    return hostname === '0.0.0.0' || hostname === '::' || hostname === '[::]' ||
      hostname === '127.0.0.1' || hostname === 'localhost' ||
      /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./u.test(hostname);
  } catch {
    return false;
  }
}

/**
 * Where the relay lives.
 *
 * A LAN address is deliberately NOT read from the config file. It is a fact about
 * the current network, not a durable setting: DHCP moves this machine, and a
 * stored address then points at whatever held that address before. Re-reading it
 * would also make `--write-config` self-perpetuating — it would copy a stale
 * address straight back into the file it had just read.
 *
 * A remote relay is a durable setting, so that one is taken from the file.
 */
const configuredRelayUrl = args.relay ?? process.env.WATCH_DSH_RELAY;
const fromFile = fromConfig(fileConfig?.relayUrl);
const relayUrl = String(
  configuredRelayUrl ?? (isLocalRelay(fromFile) ? undefined : fromFile) ?? 'ws://127.0.0.1:8787',
);

/**
 * The address the bridge itself can dial, made watch-dialable.
 *
 * Only a *local* relay needs rewriting: one started with `--host 0.0.0.0` accepts
 * connections on every interface, but neither `0.0.0.0` nor `127.0.0.1` is
 * reachable from the watch — the first is not an address at all, and the second
 * means "this device". So a local relay becomes this machine's LAN address.
 *
 * A remote relay is returned unchanged, because a watch away from home has to
 * reach it by that exact public name. What a broadcast advertises is a separate
 * question, answered by {@link lanRelayUrl}.
 */
function dialableRelayUrl(url) {
  if (!isLocalRelay(url)) return url;
  const address = lanAddress();
  if (address === undefined) return url;
  const parsed = new URL(url);
  parsed.hostname = address;
  return parsed.href.replace(/\/$/u, '');
}

/** This machine's IPv4 address on the local network, if it has one. */
function lanAddress() {
  const interfaces = networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && entry.internal !== true) return entry.address;
    }
  }
  return undefined;
}

// Two addresses answer two different questions, and conflating them made both
// wrong.
//
// `watchRelayUrl` answers "which relay is this bridge attached to" - the address a
// watch must be told to reach this PC from wherever it is. A config export carries
// this one, including a remote `wss://` URL, because that is the point of
// exporting a remote configuration.
//
// `discoveryUrl` answers "where is a relay on this network" - what a broadcast
// answered by *this* machine can usefully advertise, which is always a LAN address
// when one exists, even while the bridge is attached to a public relay. A watch
// that can hear a broadcast is by definition on this network, so sending it to the
// internet wastes the LAN and makes a local connection depend on being online.
const watchRelayUrl = dialableRelayUrl(relayUrl);
const discoveryUrl = lanRelayUrl() ?? watchRelayUrl;

/** This machine's own relay address, or undefined when it has no LAN address. */
function lanRelayUrl() {
  const address = lanAddress();
  return address === undefined ? undefined : `ws://${address}:${LOCAL_RELAY_PORT}`;
}

// Export the portable config, then exit. Doing this before connecting keeps it
// usable on a machine that is not currently running a relay, which is exactly
// when someone is preparing a remote setup.
if (args['write-config'] !== undefined) {
  const target = args['write-config'] === true ? configPath : String(args['write-config']);
  writeConfig(target, { relayUrl: watchRelayUrl, relayToken, pairingSecret: pairing, pcId });
  console.log(`main: wrote a watch config to ${target}`);
  console.log('main: import it on the watch with:');
  console.log(`  adb push "${target}" /sdcard/Android/data/dev.watchdsh/files/watch-config.json`);
  process.exit(0);
}

const descriptors = loadDescriptors(dshHome);
const bridge = new Bridge({ dshHome, baseUrl, pairingSecret: pairing, pcId, descriptors });
await bridge.start();

// Answer LAN discovery probes unless explicitly disabled. This is what lets a
// watch on the same Wi-Fi pair with no typing at all.
let discovery;
if (args['no-discovery'] !== true) {
  discovery = startDiscovery({
    pcId,
    relayUrl: discoveryUrl,
    relayToken,
    onProbe: (event) => {
      if (event.kind === 'listening') {
        console.log(`main: answering LAN discovery on udp/${String(event.port)} (${event.addresses.join(', ') || 'no LAN address'})`);
      } else if (event.kind === 'error') {
        console.log(`main: discovery problem: ${event.message}`);
      } else if (event.kind === 'answered') {
        console.log(`main: answered a discovery probe from ${event.address}`);
      }
    },
  });
}

// The values the watch needs are printed once, together, in the order its
// pairing screen asks for them. The pairing secret is listed as well so it can
// be entered by hand if discovery is unavailable, but on a LAN the watch
// receives it over the authenticated relay link and nothing needs typing.
console.log('');
console.log('  -- LAN mode: open the watch app and tap "Find my PC" ------------------');
if (discovery !== undefined) console.log(`  (discovery is answering on udp/${String(discovery.port)})`);
console.log('');
console.log('  -- or enter these values by hand --------------------------------------');
console.log(`  Relay URL       ${watchRelayUrl}`);
console.log(`  Relay token     ${relayToken}`);
console.log(`  Pairing secret  ${pairing}`);
console.log(`  PC id           ${pcId}`);
console.log('  -----------------------------------------------------------------------');
console.log('');
console.log(`main: harness ready at ${baseUrl} (${String(descriptors.all.length)} endpoints known)`);

/** Watch attachment ids, so a relay reconnect re-attaches cleanly. */
let socket;
let reconnectDelay = 1000;

/** Dial the relay as the PC peer and pump sealed watch frames into the bridge. */
function connect() {
  const url = new URL('/pc', relayUrl);
  url.searchParams.set('token', relayToken);
  url.searchParams.set('pc', pcId);
  socket = new WebSocket(url);
  /** Per-watch links on this relay connection, keyed by the relay's `from` id. */
  socket.watchLinks = new Map();

  socket.on('open', () => {
    reconnectDelay = 1000;
    console.log(`main: attached to relay as pc "${pcId}" (${relayUrl})`);
  });

  socket.on('message', (data) => {
    void (async () => {
      try {
        await handleFrame(data);
      } catch (error) {
        console.log(`main: error handling a relay frame: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  });

  /** Handle one frame from the relay: either a transport notice or a sealed watch frame. */
  async function handleFrame(data) {
      let envelope;
      try {
        envelope = JSON.parse(data.toString());
      } catch {
        console.log('main: ignoring a non-JSON frame from the relay');
        return;
      }
      // A pairing request cannot be sealed: sealing needs the very secret the
      // watch is asking for. Its authorization is the relay's, which admits only
      // peers presenting the shared relay token. It is recognised by its `ch`
      // field, not by a `t` field, because the relay forwards the request frame
      // verbatim. This check comes before the notice branch below, which would
      // otherwise swallow it.
      if (envelope?.ch === 'pair') {
        const frame = envelope;
        const link = socket.watchLinks.get(String(envelope.from));
        if (link !== undefined) await link.deliver(frame);
        else console.log(`main: pairing request from unknown watch ${String(envelope.from)}; ignoring`);
        return;
      }
      // Transport notices are the relay's own frames, not sealed payloads.
      if (typeof envelope?.t === 'string' && envelope.t !== 'sealed') {
        if (envelope.t === 'watch-online') {
          console.log(`main: watch ${String(envelope.from)} attached`);
          socket.watchLinks.set(String(envelope.from), bridge.attachWatch(socket, String(envelope.from)));
        } else if (envelope.t === 'watch-offline') {
          console.log(`main: watch ${String(envelope.from)} detached`);
          bridge.detachWatch(String(envelope.from));
          socket.watchLinks.delete(String(envelope.from));
        } else if (envelope.t === 'peer-offline') {
          console.log('main: relay reported the watch side offline');
        }
        return;
      }

      const frame = await openFrame(pairing, 'w2b', envelope);
      if (frame === undefined) {
        // The failure mode is reported precisely: "wrong secret" is only one of
        // several causes, and guessing at it wastes a lot of time on a device
        // whose only console is a file pulled over adb.
        const diagnosis = await openFrameDiagnostic(pairing, 'w2b', envelope);
        console.log(`main: dropped a watch frame: ${diagnosis.error ?? 'decoded but unusable'}`);
        return;
      }
      // One relay link carries every watch, so route by the relay's `from` id.
      const link = socket.watchLinks.get(String(envelope.from));
      if (link === undefined) {
        console.log(`main: frame from unknown watch ${String(envelope.from)}; ignoring`);
        return;
      }
      await link.deliver(frame);
  }

  socket.on('close', (code) => {
    console.log(`main: relay link closed (${String(code)}); retrying in ${String(reconnectDelay)}ms`);
    for (const watchId of socket.watchLinks.keys()) bridge.detachWatch(watchId);
    socket.watchLinks.clear();
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  });

  socket.on('error', (error) => {
    console.log(`main: relay link error: ${error.message}`);
  });
}

connect();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\nmain: shutting down');
    discovery?.close();
    bridge.close();
    socket?.close(1001, 'bridge shutting down');
    setTimeout(() => { process.exit(0); }, 200);
  });
}
