/**
 * livetest: drive one real prompt through the bridge's exact code path, in a
 * session created for the test, and report the frame shapes that arrive.
 *
 * This is the end-to-end proof that the watch's core interaction works:
 * create a session, follow it, send a prompt, observe streaming text, tool
 * calls, and turn completion.
 *
 * Usage: node src/livetest.mjs [--prompt "…"] [--seconds 90]
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

const args = parseArgs(process.argv.slice(2));
const baseUrl = args.url ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080';
const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');
const promptText = args.prompt ?? 'Reply with exactly the text: bridge-ok. Nothing else.';
const budgetSeconds = Number(args.seconds ?? 90);

const client = new DshClient({ baseUrl, secret: loadBrowserSessionSecret(dshHome), descriptors: loadDescriptors(dshHome) });
const startedAt = Date.now();
const stamp = () => `${String(((Date.now() - startedAt) / 1000).toFixed(1)).padStart(6)}s`;

/** Compact one event for the log. */
function summarize(frame) {
  if (frame?.type === 'snapshot') {
    return `snapshot cursor=${String(frame.cursor)} records=${String(frame.records.length)} header.version=${String(frame.header?.version)}`;
  }
  if (frame?.type === 'assistant-stream') {
    const inner = frame.frame;
    if (inner?.type === 'chunk') {
      const chunk = inner.chunk;
      const text = chunk?.delta?.text ?? chunk?.text ?? chunk?.delta ?? '';
      return `assistant-stream.chunk idx=${String(inner.index)} chunkType=${String(chunk?.type)} ${JSON.stringify(text).slice(0, 80)}`;
    }
    return `assistant-stream.${String(inner?.type)} ${JSON.stringify(inner).slice(0, 160)}`;
  }
  if (frame?.type === 'event') {
    const event = frame.event;
    const type = event?.type ?? '?';
    if (type === 'assistant/message') {
      const blocks = (event.data?.message?.content ?? []).map((block) => block.type).join(',');
      return `event assistant/message turn=${String(event.data?.turn)} step=${String(event.data?.step)} blocks=[${blocks}] streamRecords=${String(event.data?.stream?.length ?? 0)} usage=${JSON.stringify(event.data?.usage ?? null)}`;
    }
    if (type === 'tool/call') {
      return `event tool/call name=${String(event.data?.name)} callId=${String(event.data?.callId)} args=${JSON.stringify(event.data?.arguments ?? '').slice(0, 100)}`;
    }
    if (type === 'tool/result') {
      return `event tool/result msgRole=${String(event.data?.message?.role)} err=${JSON.stringify(event.data?.error ?? null)}`;
    }
    if (type === 'request/context') return `event request/context keys=${Object.keys(event.data ?? {}).join(',')}`;
    return `event ${type} data=${JSON.stringify(event.data).slice(0, 140)}`;
  }
  return JSON.stringify(frame).slice(0, 160);
}

console.log(`${stamp()} creating session …`);
const created = await client.call('session/create', { cwd: process.cwd() });
if (created.ok !== true) {
  console.log('session/create failed:', JSON.stringify(created.error));
  process.exit(1);
}
const sessionId = created.value.sessionId;
console.log(`${stamp()} session ${sessionId}`);

const controller = new AbortController();
setTimeout(() => { controller.abort(); }, budgetSeconds * 1000);

// Follow first so no early frame is missed, then prompt.
const followPromise = (async () => {
  let assistantText = '';
  let sawCommitted = false;
  try {
    for await (const frame of client.stream('session/follow', {
      address: { kind: 'session', sessionId },
      maxMessages: 5,
      assistantStream: true,
    }, { signal: controller.signal })) {
      if (frame?.type === 'assistant-stream' && frame.frame?.type === 'chunk') {
        const chunk = frame.frame.chunk;
        const delta = chunk?.delta?.text ?? chunk?.text ?? '';
        if (typeof delta === 'string') assistantText += delta;
      }
      if (frame?.type === 'event' && frame.event?.type === 'assistant/message') {
        const blocks = frame.event.data?.message?.content ?? [];
        for (const block of blocks) {
          if (block.type === 'text') assistantText = block.text;
        }
        sawCommitted = true;
      }
      console.log(`${stamp()} ${summarize(frame)}`);
      if (sawCommitted && frame?.type === 'event' && frame.event?.type === 'assistant/message') {
        console.log(`\n${stamp()} committed assistant text:\n---\n${assistantText}\n---`);
        break;
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) console.log(`${stamp()} follow ended: ${error.message}`);
  }
})();

// Give the follow stream a moment to deliver its snapshot baseline.
await new Promise((resolve) => setTimeout(resolve, 800));

console.log(`${stamp()} sending prompt …`);
const prompted = await client.call('session/prompt', {
  requestId: `watch-dsh-test-${Date.now().toString(36)}`,
  sessionId,
  mode: 'queue',
  content: [{ type: 'text', text: promptText }],
});
console.log(`${stamp()} prompt -> ${JSON.stringify(prompted).slice(0, 200)}`);

await followPromise;
controller.abort();
client.close();
console.log(`\n${stamp()} done (session ${sessionId} left in place for inspection).`);
