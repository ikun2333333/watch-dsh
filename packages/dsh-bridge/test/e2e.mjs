/**
 * e2e: drive the whole chain the way the watch will, with no Android involved.
 *
 *   this test  ──ws──▶  relay  ──ws──▶  bridge  ──http/ws──▶  dsh web
 *
 * It plays the watch: pairs with the bridge's secret, lists sessions, opens a
 * session, sends a prompt, and asserts that streamed text and a turn end arrive.
 * Because the same sealed frames flow here as on the watch, a green run means
 * the watch's protocol is proven and only Kotlin UI work remains.
 *
 * Usage: node test/e2e.mjs [--relay ws://127.0.0.1:8787] [--token-file .state/relay-token]
 *                          [--pairing-file .state/pairing-secret] [--prompt "…"]
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadWebSocket } from '../src/deps.mjs';
import { COMMANDS, EVENTS, command, openFrame, sealFrame } from '../src/protocol.mjs';

const { WebSocket } = loadWebSocket();

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) { args[token.slice(2)] = true; continue; }
    args[token.slice(2)] = next;
    index += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const root = resolve(process.cwd());
const relayUrl = String(args.relay ?? process.env.WATCH_DSH_RELAY ?? 'ws://127.0.0.1:8787');
const relayToken = String(args.token ?? (args['token-file'] === undefined && process.env.WATCH_DSH_RELAY_TOKEN === undefined
  ? readFileSync(join(root, '.state', 'relay-token'), 'utf8').trim()
  : args['token-file'] !== undefined ? readFileSync(String(args['token-file']), 'utf8').trim() : process.env.WATCH_DSH_RELAY_TOKEN));
const pairing = String(args.pairing ?? (args['pairing-file'] === undefined && process.env.WATCH_DSH_PAIRING === undefined
  ? readFileSync(join(root, '.state', 'pairing-secret'), 'utf8').trim()
  : args['pairing-file'] !== undefined ? readFileSync(String(args['pairing-file']), 'utf8').trim() : process.env.WATCH_DSH_PAIRING));
const pcId = String(args.pc ?? process.env.WATCH_DSH_PC_ID ?? 'e2e-test-pc');
const promptText = String(args.prompt ?? 'Reply with exactly the text: watch-ok. Nothing else.');
const budgetSeconds = Number(args.seconds ?? 120);

/** Assertion accounting. */
const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}`);
}

const url = new URL('/watch', relayUrl);
url.searchParams.set('token', relayToken);
url.searchParams.set('pc', pcId);
const socket = new WebSocket(url);

/** Commands awaiting a response. */
const pending = new Map();
let commandSeq = 0;

/** Resolves once the relay link is usable, so no command races the handshake. */
const socketOpen = new Promise((resolvePromise, rejectPromise) => {
  socket.once('open', () => { resolvePromise(true); });
  socket.once('error', (error) => { rejectPromise(error); });
});

/** Send a sealed command and await its response. */
async function call(cmd, body = {}, timeoutMs = 30_000) {
  await socketOpen;
  const id = `c${++commandSeq}`;
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectPromise(new Error(`command ${cmd} timed out`));
    }, timeoutMs);
    pending.set(id, { resolve: resolvePromise, timer });
    void sealFrame(pairing, 'w2b', command(id, cmd, body)).then((envelope) => {
      socket.send(JSON.stringify(envelope));
    });
  });
}

/** Every event received, in order, for assertions after the fact. */
const received = [];
/** Streaming text accumulated from DELTA events. */
let streamedText = '';
/** Resolver for the "turn ended" condition. */
let turnEnded;
const turnEndedPromise = new Promise((resolvePromise) => { turnEnded = resolvePromise; });

socket.on('open', () => { console.log(`connected to relay at ${relayUrl} as pc "${pcId}"`); });
socket.on('error', (error) => { console.log(`watch socket error: ${error.message}`); });

socket.on('message', (data) => {
  void (async () => {
    let envelope;
    try { envelope = JSON.parse(data.toString()); } catch { return; }
    if (typeof envelope?.t === 'string' && envelope.t !== 'sealed') {
      if (envelope.t === 'ready') console.log(`relay ready: role=${String(envelope.role)} pcOnline=${String(envelope.pcOnline)}`);
      else console.log(`transport: ${envelope.t}`);
      return;
    }
    const frame = await openFrame(pairing, 'b2w', envelope);
    if (frame === undefined) {
      console.log('received a frame that failed authentication');
      return;
    }
    received.push(frame);
    if (frame.ch === 'res' && typeof frame.id === 'string') {
      const waiting = pending.get(frame.id);
      if (waiting !== undefined) {
        clearTimeout(waiting.timer);
        pending.delete(frame.id);
        waiting.resolve(frame);
        return;
      }
      console.log(`res for unclaimed id ${frame.id}`);
      return;
    }
    if (frame.ch === 'evt') {
      switch (frame.evt) {
        case EVENTS.DELTA:
          if (typeof frame.text === 'string') streamedText += frame.text;
          break;
        case EVENTS.TRANSCRIPT: {
          const last = (frame.entries ?? []).at(-1);
          console.log(`evt transcript: ${String(last?.kind)} ${JSON.stringify(String(last?.text ?? '').slice(0, 70))}`);
          break;
        }
        case EVENTS.SESSIONS:
          console.log(`evt sessions: ${String((frame.sessions ?? []).length)} row(s)`);
          break;
        case EVENTS.SESSION:
          console.log(`evt session: ${JSON.stringify(frame.session)}`);
          break;
        case EVENTS.TOOL:
          console.log(`evt tool: ${String(frame.state)} ${String(frame.name ?? frame.callId ?? '')} ${String(frame.summary ?? '')}`.trim());
          break;
        case EVENTS.TURN:
          console.log(`evt turn: ${String(frame.state)} ${String(frame.reason ?? '')}`);
          if (frame.state === 'end') turnEnded();
          break;
        case EVENTS.APPROVAL:
          console.log(`evt APPROVAL: tool=${String(frame.approval?.toolName)} reason=${String(frame.approval?.reason ?? '')} id=${String(frame.approval?.approvalId)}`);
          break;
        case EVENTS.APPROVAL_CLOSED:
          console.log(`evt approval closed: ${String(frame.approvalId)} ${String(frame.outcome ?? frame.reason ?? '')}`);
          break;
        case EVENTS.STATUS:
          console.log(`evt status: ${JSON.stringify(frame.status)}`);
          break;
        case EVENTS.NOTICE:
          console.log(`evt notice: ${String(frame.level)} ${String(frame.message)}`);
          break;
        default:
          console.log(`evt ${String(frame.evt)}`);
      }
    }
  })();
});

/** Wait until the bridge answers, or fail the run. */
async function waitForBridge(seconds = 20) {
  const deadline = Date.now() + seconds * 1000;
  let lastError = 'no attempt made';
  while (Date.now() < deadline) {
    try {
      const reply = await call(COMMANDS.HELLO, { app: 'e2e', protocol: 1 }, Math.min(5000, Math.max(1000, deadline - Date.now())));
      if (reply.ok === true) return reply;
      lastError = reply.error?.message ?? 'hello returned not-ok';
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
  }
  throw new Error(`bridge never answered hello: ${lastError}`);
}

console.log('\n--- 1. handshake ---');
const hello = await waitForBridge();
check('bridge answers hello', hello.ok === true, JSON.stringify(hello.status ?? {}));

console.log('\n--- 2. session list ---');
const sessions = await call(COMMANDS.SESSIONS);
check('session list returns rows', sessions.ok === true && Array.isArray(sessions.sessions), `${String(sessions.sessions?.length ?? 0)} row(s)`);

console.log('\n--- 3. open a fresh session ---');
const opened = await call(COMMANDS.SESSION_OPEN, {});
check('session created', opened.ok === true && typeof opened.sessionId === 'string', String(opened.sessionId ?? opened.error?.message));
const sessionId = opened.sessionId;

console.log('\n--- 4. send a prompt and watch it stream ---');
const sent = await call(COMMANDS.SEND, { sessionId, text: promptText });
check('prompt accepted', sent.ok === true, JSON.stringify(sent.error ?? sent.requestId ?? {}));

const streamed = await Promise.race([
  turnEndedPromise.then(() => true),
  new Promise((resolvePromise) => setTimeout(() => { resolvePromise(false); }, budgetSeconds * 1000)),
]);
check('turn ended within budget', streamed);
check('streamed text arrived', streamedText.length > 0, JSON.stringify(streamedText.slice(0, 80)));
check('streamed text matches the request', streamedText.includes('watch-ok'), JSON.stringify(streamedText.slice(0, 80)));

console.log('\n--- 5. transcript history ---');
const transcript = await call(COMMANDS.TRANSCRIPT, { sessionId });
const kinds = (transcript.entries ?? []).map((entry) => entry.kind);
check('transcript has user and assistant entries', transcript.ok === true && kinds.includes('user') && kinds.includes('assistant'), JSON.stringify(kinds));
check('assistant entry contains the reply', (transcript.entries ?? []).some((entry) => String(entry.text).includes('watch-ok')));

console.log('\n--- 6. error handling ---');
const bad = await call(COMMANDS.SEND, { sessionId, text: '   ' });
check('empty prompt is rejected', bad.ok === false, String(bad.error?.code));
const unknown = await call('nonsense.command', {});
check('unknown command is rejected', unknown.ok === false && unknown.error?.code === 'unsupported', String(unknown.error?.code));

socket.close();
const failures = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
console.log(`events received: ${String(received.length)}`);
process.exit(failures.length === 0 ? 0 : 1);
