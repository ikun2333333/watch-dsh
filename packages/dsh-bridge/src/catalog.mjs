/**
 * catalog: extract every Remote endpoint a Harness composition mounts, straight
 * from the generated Typert host artifacts shipped in the installed packages.
 *
 * The generated files carry one descriptor object per endpoint with stable
 * fields (`id`, `service`, `namespace`, `method`, `invocation`), so a focused
 * scan produces an accurate catalog without a running server.
 *
 * Usage: node src/catalog.mjs [--json]
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const profilesRoot = join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh'), 'profiles', 'node_modules', '@deepseek-ai');

/** Every `typert.host.js` artifact under the installed @deepseek-ai packages. */
function findGeneratedHosts() {
  const found = [];
  for (const entry of readdirSync(profilesRoot)) {
    const lib = join(profilesRoot, entry, 'lib');
    let stat;
    try { stat = statSync(lib); } catch { continue; }
    if (!stat.isDirectory()) continue;
    for (const file of readdirSync(lib)) {
      if (file === 'typert.host.js') found.push({ pkg: entry, path: join(lib, file) });
    }
  }
  return found;
}

/**
 * Pull descriptor objects out of a generated artifact.
 * @param text - generated host artifact source.
 * @returns one record per endpoint.
 */
function extractEndpoints(text) {
  const endpoints = [];
  const idPattern = /\bid:\s*'([^']+#[^']+)'/g;
  let match;
  while ((match = idPattern.exec(text)) !== null) {
    const window = text.slice(match.index, match.index + 1400);
    const namespace = /namespace:\s*'([^']+)'/.exec(window)?.[1];
    const method = /method:\s*'([^']+)'/.exec(window)?.[1];
    const service = /service:\s*'([^']+)'/.exec(window)?.[1];
    const kind = /kind:\s*'([^']+)'/.exec(window)?.[1] ?? 'direct';
    const cancellation = /cancellation:\s*\{/.test(window);
    if (namespace === undefined || method === undefined) continue;
    endpoints.push({ endpoint: `${namespace}/${method}`, service, kind, cancellable: cancellation, id: match[1] });
  }
  return endpoints;
}

const all = [];
for (const { pkg, path } of findGeneratedHosts()) {
  const endpoints = extractEndpoints(readFileSync(path, 'utf8'));
  for (const endpoint of endpoints) all.push({ ...endpoint, pkg });
}

const unique = [...new Map(all.map((e) => [`${e.endpoint}|${e.kind}`, e])).values()]
  .sort((a, b) => a.endpoint.localeCompare(b.endpoint));

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(unique, null, 2));
} else {
  console.log(`${String(unique.length)} endpoints across ${new Set(unique.map((e) => e.service)).size} services\n`);
  let currentPackage = '';
  for (const entry of unique) {
    if (entry.pkg !== currentPackage) {
      currentPackage = entry.pkg;
      console.log(`\n== ${currentPackage} ==`);
    }
    const flags = [entry.kind === 'stream' ? 'STREAM' : '', entry.cancellable ? 'cancel' : ''].filter(Boolean).join(',');
    console.log(`  ${entry.endpoint.padEnd(30)} ${(entry.service ?? '?').padEnd(26)} ${flags}`);
  }
}
