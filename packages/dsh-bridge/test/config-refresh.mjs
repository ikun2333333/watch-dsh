/**
 * Guard the config file against a stale LAN address.
 *
 * A LAN relay address is a fact about the current network, not a durable setting.
 * An earlier version read it back from the config file, which made
 * `--write-config` self-perpetuating: after DHCP moved the PC, every later run
 * copied the old address straight back into the file, and the watch kept dialling
 * a machine that no longer held it. The symptom was a watch that imported its
 * config correctly and then failed to connect, with nothing pointing at the file.
 *
 * The other three values are the opposite case and must survive:
 *
 *   relayUrl       refreshed, because it describes the network
 *   pcId           inherited, because it is the bridge's stable identity
 *   relayToken     inherited, so an already-paired watch keeps working
 *   pairingSecret  inherited, for the same reason
 *
 * So this test plants a stale address *and* a known identity, then asserts the
 * address was replaced while the identity was kept.
 *
 * Usage: node test/config-refresh.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition) });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}`);
}

/** This machine's current LAN address, which the bridge should report. */
function currentLanAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && entry.internal !== true) return entry.address;
    }
  }
  return undefined;
}

const lan = currentLanAddress();
if (lan === undefined) {
  console.log('no LAN address on this machine; nothing to test');
  process.exit(0);
}

// A scratch state directory, so the real one is never touched.
const stateDir = mkdtempSync(join(tmpdir(), 'watch-dsh-config-'));
const tokenFile = join(stateDir, 'relay-token');
const configPath = join(stateDir, 'watch-config.json');
writeFileSync(tokenFile, 'test-token-for-config-refresh-0123456789', 'utf8');

// A stale address on the same subnet, which is exactly what DHCP leaves behind.
const staleAddress = lan.replace(/\d+$/u, (last) => String((Number(last) + 7) % 250 + 1));
// The durable values, which must be carried forward unchanged.
const pinnedPcId = 'pinned-identity';
const pinnedSecret = 'a-secret-that-must-survive-a-config-refresh';
writeFileSync(configPath, JSON.stringify({
  dsh: 'watch-dsh-config',
  v: 1,
  pcId: pinnedPcId,
  relayUrl: `ws://${staleAddress}:8787`,
  relayToken: 'test-token-for-config-refresh-0123456789',
  pairingSecret: pinnedSecret,
}, null, 2), 'utf8');
console.log(`stale address planted: ws://${staleAddress}:8787   (real address is ${lan})`);
console.log(`pinned identity planted: pcId=${pinnedPcId}`);

const run = spawnSync(process.execPath, [
  join(import.meta.dirname, '..', 'src', 'main.mjs'),
  '--relay', 'ws://127.0.0.1:8787',
  '--token-file', tokenFile,
  '--state', stateDir,
  '--write-config',
], { encoding: 'utf8', stdio: 'pipe' });

check('the bridge wrote a config', run.status === 0, `exit ${String(run.status)} ${run.stderr.slice(0, 200)}`);

let written;
try {
  written = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (error) {
  check('the written config is readable', false, error.message);
  rmSync(stateDir, { recursive: true, force: true });
  process.exit(1);
}

const writtenHost = new URL(written.relayUrl).hostname;
check('the stale LAN address was not carried forward', writtenHost !== staleAddress, `wrote ${written.relayUrl}`);
check('the written address is this machine', writtenHost === lan, `expected ${lan}, wrote ${writtenHost}`);
check('the pinned identity survived, so the watch keeps its pairing', written.pcId === pinnedPcId, String(written.pcId));
check(
  'the pairing secret survived, so an existing watch is not locked out',
  written.pairingSecret === pinnedSecret,
  `${String(written.pairingSecret?.length ?? 0)} chars`,
);

rmSync(stateDir, { recursive: true, force: true });

const failures = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
process.exit(failures.length === 0 ? 0 : 1);
