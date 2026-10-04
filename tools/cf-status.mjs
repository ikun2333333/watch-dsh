/**
 * Report the Cloudflare zones and Worker custom-domain bindings for this account.
 *
 * This exists to answer one question before any DNS work happens: has the domain
 * been added to Cloudflare yet? Binding a Worker to a custom domain requires the
 * zone to exist on the account, so knowing whether that step is done turns
 * "configure the domain" into a decidable next action.
 *
 * Usage: node --import file:///.../tools/resolve-public.mjs tools/cf-status.mjs <account-id>
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const accountId = process.argv[2];
if (!accountId) {
  console.log('usage: cf-status.mjs <account-id>');
  process.exit(1);
}

const configPath = join(process.env.APPDATA ?? '', 'xdg.config', '.wrangler', 'config', 'default.toml');
let token;
try {
  const toml = readFileSync(configPath, 'utf8');
  token = /oauth_token\s*=\s*"([^"]+)"/u.exec(toml)?.[1];
} catch (error) {
  console.log(`could not read the wrangler credential: ${error.message}`);
  process.exit(1);
}
if (!token) {
  console.log('no oauth_token in the wrangler credential');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 'watch-dsh' };

/** Print one API result, truncated so a stale token does not dump a wall of text. */
async function show(label, url) {
  try {
    const response = await fetch(url, { headers });
    const body = await response.json().catch(() => ({}));
    console.log(`  ${label}: HTTP ${response.status}`);
    if (Array.isArray(body.result)) {
      for (const entry of body.result.slice(0, 10)) {
        const bits = [entry.name, entry.status, entry.id].filter(Boolean);
        console.log(`      ${bits.join('  |  ')}`);
      }
      if (body.result.length === 0) console.log('      (none)');
    } else if (body.result) {
      console.log(`      ${JSON.stringify(body.result).slice(0, 200)}`);
    } else if (body.errors) {
      console.log(`      ${JSON.stringify(body.errors).slice(0, 200)}`);
    }
    return body.result;
  } catch (error) {
    console.log(`  ${label}: FAILED - ${error.cause?.code ?? error.message}`);
    return undefined;
  }
}

console.log('Zones on this account:');
const zones = await show('GET /zones', 'https://api.cloudflare.com/client/v4/zones?per_page=50');

console.log('');
console.log('Worker custom-domain bindings:');
await show(
  'GET /accounts/<id>/workers/domains',
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/domains`,
);

if (Array.isArray(zones)) {
  const target = zones.find((zone) => String(zone.name).includes('dpdns'));
  console.log('');
  if (target) {
    console.log(`The dpdns zone is present: ${target.name} (status ${target.status})`);
    console.log(`  zone id: ${target.id}`);
    console.log(`  nameservers Cloudflare wants: ${(target.name_servers ?? []).join(', ')}`);
  } else {
    console.log('No dpdns zone on this account yet: the domain has not been added to Cloudflare.');
  }
}
