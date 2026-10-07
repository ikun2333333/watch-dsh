// Exercise the pairing module's own logic, without touching a watch.
//
// The parts that can be wrong without any device involved are the config it
// builds - three modes, and the two fields that have to be filled in the order the
// watch reads them - and the device-list parsing, which has to cope with the
// dotted serial a wireless-debugging connection uses.
import { strict as assert } from 'node:assert'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildWatchConfig, listDevices, connectDevice } from '../dsh-plugin/lib/pairing.js'

let failures = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${name}: ${error.message}`)
  }
}

const base = {
  pcId: 'mcphonk',
  publicRelayUrl: 'wss://kangjunyu.dpdns.org',
  lanRelayUrl: 'ws://192.168.10.28:8787',
  relayToken: 'token-value',
  pairingSecret: 'secret-value',
}

console.log('config building')

check('both writes the LAN address as the preferred one and the public as fallback', () => {
  const { ok, config } = buildWatchConfig({ mode: 'both', ...base })
  assert.equal(ok, true)
  // The watch reads `lanRelayUrl` first, so the LAN address belongs there.
  assert.equal(config.lanRelayUrl, 'ws://192.168.10.28:8787')
  assert.equal(config.relayUrl, 'wss://kangjunyu.dpdns.org')
})

check('lan writes one address and no local field', () => {
  const { config } = buildWatchConfig({ mode: 'lan', ...base })
  assert.equal(config.relayUrl, 'ws://192.168.10.28:8787')
  assert.equal(config.lanRelayUrl, undefined)
})

check('public writes one address and no local field', () => {
  const { config } = buildWatchConfig({ mode: 'public', ...base })
  assert.equal(config.relayUrl, 'wss://kangjunyu.dpdns.org')
  assert.equal(config.lanRelayUrl, undefined)
})

check('the format marker and version match what the reader requires', () => {
  const { config } = buildWatchConfig({ mode: 'both', ...base })
  assert.equal(config.dsh, 'watch-dsh-config')
  assert.equal(config.v, 1)
})

check('credentials are carried, since the watch holds nothing else', () => {
  const { config } = buildWatchConfig({ mode: 'both', ...base })
  assert.equal(config.relayToken, 'token-value')
  assert.equal(config.pairingSecret, 'secret-value')
  assert.equal(config.pcId, 'mcphonk')
})

check('public mode without a public relay is refused, not written empty', () => {
  const result = buildWatchConfig({ mode: 'public', ...base, publicRelayUrl: '' })
  assert.equal(result.ok, false)
  assert.match(result.error, /public relay/u)
})

check('both with no public relay falls back to the LAN address alone', () => {
  const { ok, config } = buildWatchConfig({ mode: 'both', ...base, publicRelayUrl: '' })
  assert.equal(ok, true)
  assert.equal(config.relayUrl, 'ws://192.168.10.28:8787')
  assert.equal(config.lanRelayUrl, undefined)
})

check('both with no LAN address writes the public one alone', () => {
  const { ok, config } = buildWatchConfig({ mode: 'both', ...base, lanRelayUrl: '' })
  assert.equal(ok, true)
  assert.equal(config.relayUrl, 'wss://kangjunyu.dpdns.org')
  assert.equal(config.lanRelayUrl, undefined)
})

check('a config matches the shape the bridge itself writes', () => {
  // The bridge's own writer is the authority for this format. Reading its output
  // here is what stops the two drifting apart unnoticed.
  const { config } = buildWatchConfig({ mode: 'both', ...base })
  const sample = JSON.parse(
    readFileSync(new URL('../packages/dsh-bridge/test/config-sample.json', import.meta.url), 'utf8'),
  )
  assert.deepEqual(Object.keys(config).sort(), Object.keys(sample).sort())
})

console.log('device parsing')

check('a missing adb is reported rather than thrown', async () => {
  const result = await listDevices('C:/definitely/not/adb.exe')
  assert.equal(result.ok, false)
  assert.match(result.error, /adb not found/u)
})

check('an address that is not ip:port is refused before adb runs', async () => {
  const result = await connectDevice('C:/definitely/not/adb.exe', 'not-an-address')
  assert.equal(result.ok, false)
  assert.match(result.error, /address like/u)
})

// Reported through the exit code so a failing assertion cannot look like a pass.
if (failures > 0) {
  console.log(`\n${String(failures)} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
