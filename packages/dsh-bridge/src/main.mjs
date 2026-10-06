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
import { fileURLToPath } from 'node:url';
import { Bridge } from './bridge.mjs';
import { readConfig, writeConfig } from './config.mjs';
import { loadDescriptors } from './descriptors.mjs';
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

/**
 * Where the bridge keeps the state a watch depends on.
 *
 * Not relative to the working directory, which is what it used to be. That made
 * the pairing secret, the relay token, and the pc id depend on *where* the bridge
 * was launched from: started from the repository it found them and reused them,
 * and started from anywhere else it created a fresh `.state` and generated a new
 * pairing secret - silently locking out every watch already paired to it. The
 * failure looks like "the watch stopped working", with nothing pointing at the
 * directory it was started in, and it lands hardest on exactly the setup that is
 * most likely to hit it: a launcher, a shortcut, or a scheduled task, none of
 * which run from the repository.
 *
 * So the default is anchored to this file's own location. A launcher can then be
 * pointed anywhere and still find the same identity.
 */
const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultStateDir = join(scriptDir, '..', '..', '..', '.state');
const stateDir = String(args.state ?? process.env.WATCH_DSH_STATE ?? defaultStateDir);

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
// Two addresses go into a config, because neither is right in both places.
//
// `watchRelayUrl` is where this bridge is attached - the address a watch must use
// to reach this PC from wherever it is, including a remote `wss://` URL.
//
// `lanRelayUrl` is this machine on the local network, which the watch tries first:
// it is faster at home and keeps working with no internet. The watch falls back to
// the other when it cannot be reached, so a DHCP change repairs itself.
const watchRelayUrl = dialableRelayUrl(relayUrl);

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
  // Both addresses go in, so the watch can use the local one at home and the
  // public one away without being re-paired and without needing a broadcast to
  // tell it which is which.
  writeConfig(target, {
    relayUrl: watchRelayUrl,
    lanRelayUrl: lanRelayUrl(),
    relayToken,
    pairingSecret: pairing,
    pcId,
  });
  console.log(`main: wrote a watch config to ${target}`);
  console.log('main: import it on the watch with:');
  console.log(`  adb push "${target}" /sdcard/Android/data/dev.watchdsh/files/watch-config.json`);
  process.exit(0);
}

const descriptors = loadDescriptors(dshHome);
// `stateDir` is passed so the bridge can publish its live status for whoever is
// watching the PC end. Without it the only record of whether a watch is attached
// was the log, and a log line saying a watch attached stays there after it leaves.
const bridge = new Bridge({ dshHome, baseUrl, pairingSecret: pairing, pcId, descriptors, stateDir });
await bridge.start();

// The values the watch needs are printed once, together. There is no broadcast and
// no pairing handshake: the config file is the only way the watch learns any of
// this, so these are for writing that file by hand or for checking what it holds.
console.log('');
console.log('  -- the watch reaches this bridge with these values ---------------------');
console.log(`  Relay URL       ${watchRelayUrl}`);
if (lanRelayUrl() !== undefined) console.log(`  LAN Relay URL   ${lanRelayUrl()}`);
console.log(`  Relay token     ${relayToken}`);
console.log(`  Pairing secret  ${pairing}`);
console.log(`  PC id           ${pcId}`);
console.log('  -----------------------------------------------------------------------');
console.log(`  write them to a config with:  --write-config <path>`);
console.log('');
console.log(`main: harness ready at ${baseUrl} (${String(descriptors.all.length)} endpoints known)`);

/**
 * How often to ping the relay, and how long to wait for a pong before deciding the
 * link is dead.
 *
 * The timeout is generous compared with the interval because the point is to catch
 * a link that is silently gone, not to measure latency: a slow round trip over
 * mobile data is not a failure, while no answer at all across several intervals is.
 */
const PING_INTERVAL_MS = 20_000;
const PONG_TIMEOUT_MS = 70_000;

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

  /**
   * When the last pong arrived, or the time the last ping went out unanswered.
   *
   * A relay connection can die without a close frame - a laptop suspends, a NAT
   * mapping expires, a Durable Object is evicted - and the socket then looks open
   * forever. The relay keeps treating this PC as attached, so watches connect,
   * are told the PC is online, and get no answer, while this side never learns it
   * has to reconnect. That is what the heartbeat below detects.
   */
  let lastPong = Date.now();
  let heartbeat;
  let heartbeatTimeout;
  let beats = 0;

  const stopHeartbeat = () => {
    clearInterval(heartbeat);
    clearTimeout(heartbeatTimeout);
  };

  const beat = () => {
    if (socket.readyState !== WebSocket.OPEN) return;
    const silentFor = Date.now() - lastPong;
    if (silentFor > PONG_TIMEOUT_MS) {
      // Silently dead: terminate rather than close, because a close frame cannot
      // be delivered over a connection that is not carrying anything. `close`
      // fires the reconnect path either way.
      console.log(`main: relay stopped answering; reconnecting (silent ${String(silentFor)}ms)`);
      stopHeartbeat();
      socket.terminate();
      return;
    }
    // Logged periodically rather than per beat, so the log stays readable while
    // still showing at a glance whether the link is answering at all.
    beats += 1;
    if (beats % 5 === 0) {
      console.log(`main: relay link alive (pong ${String(silentFor)}ms ago)`);
    }
    try {
      socket.ping();
    } catch (error) {
      console.log(`main: ping failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  socket.on('open', () => {
    reconnectDelay = 1000;
    lastPong = Date.now();
    stopHeartbeat();
    heartbeat = setInterval(beat, PING_INTERVAL_MS);
    // Node timers would hold the process open on their own; this one is meant to.
    heartbeat.unref?.();
    console.log(`main: attached to relay as pc "${pcId}" (${relayUrl})`);
    // Told rather than assumed: this socket is the only place that knows, and the
    // published status otherwise kept saying "disconnected" for the life of a
    // perfectly connected process - a status that contradicts the log beside it.
    bridge.setRelayState('connected');
  });

  socket.on('pong', () => {
    lastPong = Date.now();
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
      // Frames reach this bridge sealed with the pairing secret, or as one of the
      // relay's own transport notices. There is no unsealed application frame any
      // more: the secret arrives in the watch's imported config, so a watch that
      // does not hold it has nothing to say and is refused by the sealing check
      // below rather than answered.
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
    stopHeartbeat();
    for (const watchId of socket.watchLinks.keys()) bridge.detachWatch(watchId);
    socket.watchLinks.clear();
    bridge.setRelayState('disconnected');
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
    bridge.close();
    socket?.close(1001, 'bridge shutting down');
    setTimeout(() => { process.exit(0); }, 200);
  });
}
