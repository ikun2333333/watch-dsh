/**
 * sample: capture real Session frames from a live Harness so the bridge maps
 * event shapes that actually occur rather than shapes guessed from type names.
 *
 * Usage:
 *   node src/sample.mjs                       # first listed session
 *   node src/sample.mjs --session <id>
 *   node src/sample.mjs --frames 40
 */

import { join } from 'node:path';
import { DshClient, loadBrowserSessionSecret } from './dsh-client.mjs';
import { loadDescriptors } from './descriptors.mjs';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    args[token.slice(2)] = argv[index + 1];
    index += 1;
  }
  return args;
}

/** One-line, size-bounded JSON so a huge frame stays readable. */
function brief(value, limit = 600) {
  const text = JSON.stringify(value);
  return text === undefined ? 'undefined' : text.length > limit ? `${text.slice(0, limit)}… (${String(text.length)} chars)` : text;
}

const args = parseArgs(process.argv.slice(2));
const baseUrl = args.url ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080';
const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');
const frameLimit = Number(args.frames ?? 30);

const client = new DshClient({ baseUrl, secret: loadBrowserSessionSecret(dshHome), descriptors: loadDescriptors(dshHome) });

const list = await client.call('session/list', {});
if (list.ok !== true) {
  console.log('session/list failed:', brief(list.error));
  process.exit(1);
}
console.log(`session/list -> ${String(list.value.items.length)} session(s)`);
for (const item of list.value.items.slice(0, 10)) {
  console.log(`  ${item.sessionId}  updated=${new Date(item.updatedAt).toISOString()}  running=${String(item.running)}  blank=${String(item.blank)}  cwd=${item.cwd ?? '-'}`);
}

const target = args.session ?? list.value.items[0]?.sessionId;
if (target === undefined) {
  console.log('no session to follow');
  process.exit(0);
}
console.log(`\nfollowing ${target} …\n`);

const controller = new AbortController();
setTimeout(() => { controller.abort(); }, Number(args.seconds ?? 20) * 1000);

let count = 0;
try {
  for await (const frame of client.stream('session/follow', {
    address: { kind: 'session', sessionId: target },
    maxMessages: 10,
    assistantStream: true,
  }, { signal: controller.signal })) {    count += 1;
    const kind = frame?.type === 'event' ? `event:${String(frame.event?.type)}` : `frame:${String(frame?.type)}`;
    console.log(`[${String(count).padStart(3)}] ${kind}`);
    console.log(`      ${brief(frame?.type === 'event' ? frame.event?.data : frame)}`);
    if (count >= frameLimit) break;
  }
} catch (error) {
  console.log(`\nstream ended: ${error.message}`);
}

client.close();
console.log(`\ncaptured ${String(count)} frame(s).`);
