/**
 * probe: prove the locally minted browser-session cookie authenticates against a
 * running `dsh web`, then enumerate the Remote endpoints actually mounted.
 *
 * Usage: node src/probe.mjs [--url http://127.0.0.1:3080]
 */

import { join } from 'node:path';
import { loadBrowserSessionSecret, DshClient, mintSessionCookie } from './dsh-client.mjs';

const args = process.argv.slice(2);
const urlIndex = args.indexOf('--url');
const baseUrl = urlIndex === -1 ? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080' : args[urlIndex + 1];
const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh');

function log(...parts) { console.log(...parts); }

log('dsh home :', dshHome);
log('base url :', baseUrl);

const secret = loadBrowserSessionSecret(dshHome);
log('secret   : loaded,', secret.byteLength, 'bytes');

const client = new DshClient({ baseUrl, secret });
log('authority:', client.authority);
log('cookie   :', mintSessionCookie(secret, client.authority).slice(0, 60) + '...');

// 1. Does the minted cookie authenticate a plain HTTP request?
const root = await fetch(new URL('/', baseUrl), { headers: { host: client.authority, cookie: mintSessionCookie(secret, client.authority) } });
log('\n[1] GET / with minted cookie ->', root.status);

// 2. Does it authenticate the shared /api channel? An unknown endpoint should
//    come back as a handler-level error, never a 401/403.
const unknown = await client.call('__bridge/probe__', {});
log('[2] POST /api unknown endpoint ->', JSON.stringify(unknown));

// 3. Enumerate the mounted Remote endpoints. Typert reports an unknown-endpoint
//    error; a mounted endpoint answers on its own terms.
const candidates = [
  'sessions/list', 'session/list', 'session/create', 'session/load', 'session/query',
  'settings/get', 'workspace/list', 'goals/list', 'agents/list', 'models/list',
  'session/follow', 'session/subscribe', 'session/messages', 'chat/send', 'session/prompt',
];
log('\n[3] endpoint probe');
for (const endpoint of candidates) {
  const result = await client.call(endpoint, {});
  const label = result?.ok === true
    ? `OK    ${JSON.stringify(result.value).slice(0, 120)}`
    : `FAIL  ${result?.error?.code ?? '?'} ${(result?.error?.message ?? '').slice(0, 110)}`;
  log(`  ${endpoint.padEnd(22)} ${label}`);
}

// 4. Does the Remote stream mux WebSocket upgrade succeed with the cookie?
log('\n[4] stream mux upgrade');
try {
  const iterator = client.stream('$events', { args: {} });
  const first = await Promise.race([
    iterator.next(),
    new Promise((resolve) => setTimeout(() => { resolve({ timeout: true }); }, 5000)),
  ]);
  log('  $events first frame ->', JSON.stringify(first).slice(0, 200));
  await iterator.return?.();
} catch (error) {
  log('  $events failed ->', error.message);
}

client.close();
log('\ndone.');
