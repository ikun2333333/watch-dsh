/**
 * Pairing a watch over adb, driven from the Web GUI.
 *
 * ## What this replaces
 *
 * `tools/pair-watch.ps1` does the same job from a terminal: find the device, write
 * a config, push it, restart the app, read back the result. That works, and it is
 * the reference for what this must do - a pairing that reports success has to mean
 * the watch actually reached the harness, not that a `push` exited zero. What it
 * cannot do is be reached from a phone or a browser, which is where the person
 * doing the pairing usually is.
 *
 * ## Why it builds the config instead of asking the bridge to
 *
 * `main.mjs --write-config` writes one, and running it here was the obvious
 * approach. It was rejected because that command starts a whole second bridge, and
 * a relay keeps one bridge per pc id: the pair would take turns evicting each
 * other, which would disturb the very link being paired. The format lives in
 * `packages/dsh-bridge/src/config.mjs`, so this reads the same values from the same
 * state directory and writes the same shape.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Where the config format is defined; kept in step by hand, checked by test. */
const MAGIC = 'watch-dsh-config'
const CONFIG_VERSION = 1

/** The package the watch app installs as, and the activity to bring it back. */
const PACKAGE = 'dev.watchdsh'
const ACTIVITY = 'dev.watchdsh.MainActivity'

/** How long a single adb command may take before it is given up on. */
const ADB_TIMEOUT_MS = 30_000

/**
 * Run one adb command.
 *
 * @returns `{ code, out }` where `out` is stdout and stderr joined, because adb
 *   writes ordinary progress to stderr and callers match against both.
 */
function adbRun(adb, args, timeout = ADB_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    const child = spawn(adb, args, { windowsHide: true })
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, out })
    }
    const timer = setTimeout(() => {
      // A watch that has gone out of range leaves adb waiting rather than failing,
      // and a pairing that hangs is worse than one that says it could not reach it.
      child.kill()
      out += '\n(adb timed out)'
      finish(-1)
    }, timeout)
    child.stdout?.on('data', (chunk) => { out += chunk.toString() })
    child.stderr?.on('data', (chunk) => { out += chunk.toString() })
    child.on('error', (error) => {
      out += `\n${error.message}`
      finish(-1)
    })
    child.on('close', (code) => finish(code ?? -1))
  })
}

/**
 * The devices adb can see right now.
 *
 * Parsed the same way the PowerShell script does, and for the same reason: a
 * wireless-debugging serial contains dots and colons
 * (`adb-XXXX-YYYY._adb-tls-connect._tcp`), so it is everything before the trailing
 * state field and not the first whitespace-separated token.
 */
export async function listDevices(adb) {
  if (!existsSync(adb)) {
    return { ok: false, error: `adb not found at ${adb}`, devices: [] }
  }
  const { out } = await adbRun(adb, ['devices'])
  const devices = []
  for (const line of out.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('List of devices')) continue
    const match = trimmed.match(/^(\S+)\s+(\S+)$/u)
    if (match === null) continue
    devices.push({ serial: match[1], state: match[2] })
  }
  return {
    ok: true,
    // Only `device` can be paired against; `offline` and `unauthorized` are
    // reported so the GUI can say which it is instead of showing nothing.
    devices,
    usable: devices.filter((device) => device.state === 'device').map((device) => device.serial),
  }
}

/** Attach a watch by address, for a first pairing over wireless debugging. */
export async function connectDevice(adb, address) {
  if (!/^[\w.\-]+:\d{1,5}$/u.test(address)) {
    return { ok: false, error: 'that is not an address like 192.168.1.23:37000' }
  }
  const { code, out } = await adbRun(adb, ['connect', address], 20_000)
  if (code !== 0 || /failed|refused|unable|cannot/iu.test(out)) {
    return { ok: false, error: out.trim() || `adb connect exited ${String(code)}` }
  }
  return { ok: true, detail: out.trim() }
}

/**
 * Build the config a watch imports.
 *
 * @param options.mode - which address the watch should try.
 *   - `both` (the default) writes the LAN address as the first candidate and the
 *     public relay as the fallback, which is what the watch already does with two
 *     candidates: it tries them in order. This is the pairing that keeps working
 *     when the watch leaves the house, and it needs no re-pairing to do it.
 *   - `lan` and `public` write only one, for forcing a path - useful for telling
 *     the two apart when something is wrong, and for a setup with no public relay.
 */
export function buildWatchConfig({ mode, pcId, publicRelayUrl, lanRelayUrl, relayToken, pairingSecret }) {
  const lan = String(lanRelayUrl ?? '').trim()
  const pub = String(publicRelayUrl ?? '').trim()

  // The order in `relayUrl` / `lanRelayUrl` is what the watch uses, so the fields
  // are filled according to the chosen mode rather than by their names.
  let relayUrl
  let lanField
  if (mode === 'lan') {
    relayUrl = lan
    lanField = undefined
  } else if (mode === 'public') {
    relayUrl = pub
    lanField = undefined
  } else {
    // Both: the public relay is the general address, the LAN one the fast local
    // path the watch prefers.
    relayUrl = pub !== '' ? pub : lan
    lanField = lan !== '' && lan !== relayUrl ? lan : undefined
  }

  if (relayUrl === '') {
    return { ok: false, error: mode === 'public' ? 'no public relay is configured' : 'no local address was found' }
  }

  return {
    ok: true,
    config: {
      dsh: MAGIC,
      v: CONFIG_VERSION,
      pcId,
      relayUrl,
      ...(lanField === undefined ? {} : { lanRelayUrl: lanField }),
      relayToken,
      pairingSecret,
    },
  }
}

/**
 * Read the credentials a config has to carry, from the state directory.
 *
 * Both are required and neither is generated here: a relay token made up at this
 * point would not match the relay, and a pairing secret the bridge does not hold
 * would produce a watch that connects and then cannot open a single frame.
 */
function readCredentials(stateDir) {
  const tokenPath = join(stateDir, 'relay-token')
  const secretPath = join(stateDir, 'pairing-secret')
  if (!existsSync(tokenPath)) return { ok: false, error: 'the relay token is missing; start the relay first' }
  if (!existsSync(secretPath)) return { ok: false, error: 'the pairing secret is missing; start the bridge first' }
  const relayToken = readFileSync(tokenPath, 'utf8').trim()
  const pairingSecret = readFileSync(secretPath, 'utf8').trim()
  if (relayToken === '' || pairingSecret === '') {
    return { ok: false, error: 'the relay token or pairing secret is empty' }
  }
  return { ok: true, relayToken, pairingSecret }
}

/**
 * Whether the watch reports a completed handshake.
 *
 * The whole point of pairing is that the watch can reach the harness, and the only
 * evidence of that is on the watch. A `push` that exited zero says a file moved.
 */
async function readWatchVerdict(adb, serial, remoteDir) {
  const { out } = await adbRun(adb, ['-s', serial, 'shell', 'cat', `${remoteDir}/diagnostics.log`], 15_000)
  if (/handshake: sessions=(\d+)/u.test(out)) {
    return { connected: true, detail: `handshake completed (${RegExp.$1} sessions)` }
  }
  if (/link=Connected/u.test(out)) {
    return { connected: false, detail: 'connected, but the handshake did not finish' }
  }
  const lastLine = out.split(/\r?\n/u).filter((line) => line.trim() !== '').pop() ?? ''
  return { connected: false, detail: lastLine.trim() || 'the diagnostics log says nothing yet' }
}

/**
 * Pair one watch: write a config, push it, restart the app, and read back whether
 * it worked.
 *
 * @param options.log - where to record what happened, since a pairing that fails
 *   on a watch the user then walks away from leaves nothing else behind.
 */
export async function pairWatch(options) {
  const { adb, serial, stateDir, mode, pcId, publicRelayUrl, lanRelayUrl, log } = options

  const credentials = readCredentials(stateDir)
  if (!credentials.ok) return credentials

  const built = buildWatchConfig({
    mode,
    pcId,
    publicRelayUrl,
    lanRelayUrl,
    relayToken: credentials.relayToken,
    pairingSecret: credentials.pairingSecret,
  })
  if (!built.ok) return built

  const configPath = join(stateDir, 'watch-config.json')
  // Same permissions as the bridge's writer: this file holds two credentials.
  writeFileSync(configPath, `${JSON.stringify(built.config, null, 2)}\n`, { mode: 0o600 })

  // The app's external files directory: per-app, so `adb push` needs no storage
  // permission, and no other app can read the file it lands in.
  const remoteDir = `/sdcard/Android/data/${PACKAGE}/files`

  const steps = []
  const run = async (label, args, timeout) => {
    const result = await adbRun(adb, args, timeout)
    steps.push({ label, code: result.code, out: result.out.trim().slice(-400) })
    return result
  }

  await run('create the app directory', ['-s', serial, 'shell', 'mkdir', '-p', remoteDir])
  const pushed = await run('push the config', ['-s', serial, 'push', configPath, `${remoteDir}/watch-config.json`])
  if (pushed.code !== 0) {
    log(`pairing: push failed: ${pushed.out.trim()}`)
    return { ok: false, error: 'the config could not be pushed to the watch', steps }
  }

  // Restarted rather than left alone: the app imports the config on launch, so a
  // running one would keep using whatever it already had.
  await run('stop the app', ['-s', serial, 'shell', 'am', 'force-stop', PACKAGE], 15_000)
  await new Promise((resolve) => setTimeout(resolve, 2000))
  await run('wake the screen', ['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], 15_000)
  await run('start the app', ['-s', serial, 'shell', 'am', 'start', '-n', `${PACKAGE}/${ACTIVITY}`], 15_000)

  // The app needs a moment to import, connect and handshake before the log means
  // anything. Checked twice rather than once so a slow watch is not called failed.
  await new Promise((resolve) => setTimeout(resolve, 12_000))
  let verdict = await readWatchVerdict(adb, serial, remoteDir)
  if (!verdict.connected) {
    await new Promise((resolve) => setTimeout(resolve, 10_000))
    verdict = await readWatchVerdict(adb, serial, remoteDir)
  }

  const modeDescription = mode === 'lan' ? 'the local relay only' : mode === 'public' ? 'the public relay only' : 'the local relay first, then the public one'
  log(`pairing: ${verdict.connected ? 'paired' : 'not connected'} (${modeDescription}) - ${verdict.detail}`)

  return {
    ok: verdict.connected,
    connected: verdict.connected,
    detail: verdict.detail,
    mode,
    modeDescription,
    relayUrl: built.config.relayUrl,
    lanRelayUrl: built.config.lanRelayUrl ?? null,
    configPath,
    steps,
  }
}
