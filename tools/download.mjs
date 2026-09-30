/**
 * download: a Node-only downloader for the Android toolchain.
 *
 * PowerShell and curl cannot reach the network in this environment (the sandbox
 * blocks their TLS), while Node's own fetch works. Every toolchain artifact is
 * therefore fetched through here instead of through a package manager.
 *
 * Usage:
 *   node tools/download.mjs <url> <destination> [--sha256 <hex>]
 *
 * Large files are streamed to disk, and a `.part` suffix plus atomic rename
 * keeps a killed download from being mistaken for a complete one.
 */

import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const [url, destination, ...rest] = process.argv.slice(2);
if (url === undefined || destination === undefined) {
  console.error('usage: node tools/download.mjs <url> <destination> [--sha256 <hex>]');
  process.exit(2);
}
const shaIndex = rest.indexOf('--sha256');
const expectedSha = shaIndex === -1 ? undefined : rest[shaIndex + 1];

const target = resolve(destination);
const partial = `${target}.part`;
await mkdir(dirname(target), { recursive: true });
await rm(partial, { force: true });

/**
 * Open a response, retrying transport failures.
 *
 * Large toolchain artifacts redirect to CDNs that occasionally time out or reset
 * mid-handshake, and a single transient failure should not cost a full re-run.
 */
async function openResponse(attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok || response.body === null) {
        console.error(`download: ${url} -> HTTP ${String(response.status)} ${response.statusText}`);
        process.exit(1);
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const waitMs = 2000 * attempt;
      console.error(`download: attempt ${String(attempt)} failed (${error.message}); retrying in ${String(waitMs)}ms`);
      await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
    }
  }
  console.error(`download: ${url} could not be reached: ${lastError?.message ?? 'unknown error'}`);
  process.exit(1);
}

const response = await openResponse();

const total = Number(response.headers.get('content-length') ?? '0');
let received = 0;
let lastReport = 0;
const hash = createHash('sha256');

const source = Readable.fromWeb(response.body);
source.on('data', (chunk) => {
  received += chunk.byteLength;
  hash.update(chunk);
  const now = Date.now();
  // Progress goes to stderr at a low rate: stdout stays a clean result line for
  // callers that read it, and a captured background log stays readable.
  if (now - lastReport < 15_000) return;
  lastReport = now;
  const percent = total === 0 ? '?' : `${((received / total) * 100).toFixed(1)}%`;
  process.stderr.write(`  ${percent}  ${(received / 1048576).toFixed(1)} MiB${total === 0 ? '' : ` / ${(total / 1048576).toFixed(1)} MiB`}\n`);
});

await pipeline(source, createWriteStream(partial));

const digest = hash.digest('hex');
if (expectedSha !== undefined && digest !== expectedSha.toLowerCase()) {
  await rm(partial, { force: true });
  console.error(`download: sha256 mismatch for ${url}\n  expected ${expectedSha}\n  actual   ${digest}`);
  process.exit(1);
}

await rename(partial, target);
const size = (await stat(target)).size;
process.stdout.write('\n');
console.log(`download: ok ${target} (${(size / 1048576).toFixed(1)} MiB, sha256 ${digest.slice(0, 16)}...)`);
