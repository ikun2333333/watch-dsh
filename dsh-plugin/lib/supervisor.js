/**
 * Supervises the relay and the bridge as children of the DSH process.
 *
 * Child processes rather than ported code on purpose. The relay and bridge are
 * already working and their edges - the WebSocket heartbeat, the sealed-frame
 * handshake, the session projection - were each found by debugging something
 * real. Reimplementing them here to avoid a spawn would trade a known-good
 * implementation for an unverified one.
 *
 * They are tied to this process: on shutdown they are killed, so a DSH restart
 * cannot leave an orphaned bridge holding the pc id. That matters because a relay
 * keeps one bridge per id, so an orphan silently replaces the live one.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * This machine's address on the local network.
 *
 * Read from the interfaces rather than configured, because the alternative is a
 * value that silently goes stale when DHCP moves it and then writes a LAN
 * address into a watch's config that nothing answers on. A watch falls back to
 * the public relay when the LAN one fails, so a stale value costs one failed
 * attempt rather than the connection.
 *
 * @returns the first non-internal IPv4 address, or null when there is none.
 */
export function findLanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address
    }
  }
  return null
}

/**
 * The relay token, generated once and then kept.
 *
 * The relay and the bridge must agree on it, and every configured watch is
 * carrying it, so it has to survive restarts: regenerating it would lock out
 * every watch already paired to this PC - the same failure the state directory
 * was anchored to avoid.
 */
export function ensureToken(tokenFile) {
  if (existsSync(tokenFile)) {
    const existing = readFileSync(tokenFile, 'utf8').trim()
    if (existing !== '') return existing
  }
  const token = randomBytes(32).toString('base64url')
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 })
  return token
}

/**
 * Plugin preferences that outlive one DSH run.
 *
 * The mode is a user decision, not a derived value, so it has to be remembered -
 * otherwise every restart silently drops the user back on the LAN relay while
 * they are away from home, which is exactly when they cannot fix it.
 *
 * Kept in the repository's own state directory rather than in the DSH profile,
 * so that the plugin's state and the bridge's state sit together and a profile
 * edit cannot lose one of them.
 */
export function readPrefs(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return {
      mode: parsed?.mode === 'public' ? 'public' : 'lan',
      publicRelayUrl: typeof parsed?.publicRelayUrl === 'string' ? parsed.publicRelayUrl : '',
    }
  } catch {
    return { mode: 'lan', publicRelayUrl: '' }
  }
}

export function writePrefs(file, prefs) {
  writeFileSync(
    file,
    `${JSON.stringify({ mode: prefs.mode, publicRelayUrl: prefs.publicRelayUrl }, null, 2)}\n`,
    'utf8',
  )
}

/** How much child output to keep per stream, for the status panel. */
const LOG_LINES = 40

/**
 * One supervised child.
 *
 * Output is kept in a ring rather than written anywhere: the bridge's own log
 * lines are how its state is read (it says when a watch attaches and when the
 * relay stops answering), so they are data, not diagnostics.
 */
class Child {
  constructor(label, command, args, options) {
    this.label = label
    this.command = command
    this.args = args
    this.options = options
    this.process = null
    this.lines = []
    this.startedAt = 0
    this.exitedAt = 0
    this.exitCode = null
    this.lastError = null
    /** Set when a spawn itself fails, which is different from the child exiting. */
    this.spawnFailed = null
  }

  get running() {
    return this.process !== null && this.exitCode === null
  }

  push(stream, chunk) {
    const text = chunk.toString('utf8')
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (line === '') continue
      this.lines.push(line)
      if (this.lines.length > LOG_LINES) this.lines.shift()
    }
  }

  /** The most recent line matching a pattern, for reading state out of output. */
  find(pattern) {
    for (let i = this.lines.length - 1; i >= 0; i -= 1) {
      const match = this.lines[i].match(pattern)
      if (match) return match
    }
    return null
  }

  start() {
    if (this.running) return
    this.exitCode = null
    this.exitedAt = 0
    this.lastError = null
    this.spawnFailed = null
    this.startedAt = Date.now()

    try {
      this.process = spawn(this.command, this.args, {
        ...this.options,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      this.spawnFailed = error.message
      this.process = null
      return
    }

    this.process.stdout?.on('data', (chunk) => this.push('out', chunk))
    this.process.stderr?.on('data', (chunk) => this.push('err', chunk))

    this.process.on('error', (error) => {
      // A failed spawn reports here rather than throwing, so it is recorded as a
      // first-class state: "never started" and "started then exited" need
      // different answers from the user.
      this.spawnFailed = error.message
      this.exitCode = -1
    })

    this.process.on('exit', (code, signal) => {
      this.exitCode = code ?? -1
      this.exitedAt = Date.now()
      if (signal) this.lastError = `killed by ${signal}`
    })
  }

  stop() {
    const child = this.process
    if (child === null) return Promise.resolve()
    this.process = null

    const exited = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve()
        return
      }
      child.once('exit', () => resolve())
      // A child that ignores SIGTERM would otherwise hang the restart forever.
      setTimeout(resolve, 3000)
    })

    try {
      child.kill()
    } catch {
      // Already gone.
    }
    return exited
  }
}

export class WatchLink {
  constructor(options) {
    this.repo = options.repo
    this.node = options.node
    this.relayPort = options.relayPort
    /**
     * Where the Harness is, or null when nothing could tell us.
     *
     * Null is a distinct state rather than a default: the bridge's own fallback is
     * 3080, and silently using it produces a bridge that starts, reports itself
     * running, and cannot reach the Harness it exists to serve. That is what
     * happened while DSH was actually on 19500.
     */
    this.dshUrl = options.dshUrl ?? null
    this.stateDir = options.stateDir
    this.tokenFile = options.tokenFile

    /** Which relay the bridge is pointed at: the local one, or a public address. */
    this.mode = options.mode ?? 'lan'
    this.publicRelayUrl = options.publicRelayUrl ?? ''

    /** Where preferences are persisted, so a mode survives a restart. */
    this.prefsFile = join(this.stateDir, 'dsh-plugin.json')

    /** Non-null while a restart is in flight, so status can say so. */
    this.restarting = null

    // A stored preference wins over the plugin config: the mode is something the
    // user chose at a moment when they could see what they were doing, and a
    // config file edited later is not evidence that they changed their mind.
    const saved = readPrefs(this.prefsFile)
    if (options.mode === undefined) this.mode = saved.mode
    if (options.publicRelayUrl === undefined || options.publicRelayUrl === '') {
      this.publicRelayUrl = saved.publicRelayUrl
    }

    /** Detected once per start; see findLanAddress for why it is not configured. */
    this.lanIp = findLanAddress()

    const bridgeDir = join(this.repo, 'packages', 'dsh-bridge', 'src')
    this.relayEntry = join(bridgeDir, 'relay.mjs')
    this.bridgeEntry = join(bridgeDir, 'main.mjs')

    this.relay = new Child(
      'relay',
      this.node,
      [this.relayEntry, '--port', String(this.relayPort), '--host', '0.0.0.0', '--token-file', this.tokenFile],
      { cwd: this.repo },
    )

    this.bridge = new Child('bridge', this.node, [], { cwd: this.repo })

    /** Set when a precondition fails, so the panel can say what rather than guess. */
    this.blocked = null
  }

  /**
   * The relay URL the bridge should dial for the current mode.
   *
   * LAN dials the relay this process just started, on the loopback address:
   * both ends are on this machine, and the LAN address a watch uses is a
   * different fact from the address this bridge uses.
   */
  bridgeRelayUrl() {
    if (this.mode === 'public') return this.publicRelayUrl
    return `ws://127.0.0.1:${this.relayPort}`
  }

  /**
   * Which endpoints a watch should be told to try, in order.
   *
   * Both are always written into the watch's config, whatever the current mode:
   * the watch tries the LAN address first and falls back to the public one, so a
   * watch carries both and needs no reconfiguration when it leaves the house.
   * The mode decides only where *this bridge* attaches, which is a separate
   * question from where a watch can reach it.
   */
  watchEndpoints() {
    return {
      relayUrl: this.publicRelayUrl !== '' ? this.publicRelayUrl : `ws://127.0.0.1:${this.relayPort}`,
      lanRelayUrl: `ws://${this.lanAddress()}:${this.relayPort}`,
    }
  }

  /** This machine's LAN address, for the address a watch on the same Wi-Fi uses. */
  lanAddress() {
    return this.lanIp ?? '127.0.0.1'
  }

  /**
   * Whether everything needed to run is present.
   *
   * Checked before spawning so a missing file reads as a missing file instead of
   * as a bridge that starts and immediately exits.
   */
  precondition() {
    if (!existsSync(this.node)) return `node not found at ${this.node}`
    if (!existsSync(this.relayEntry)) return `relay entry not found at ${this.relayEntry}`
    if (!existsSync(this.bridgeEntry)) return `bridge entry not found at ${this.bridgeEntry}`
    if (!existsSync(this.tokenFile)) return `could not create a relay token at ${this.tokenFile}`
    if (this.mode === 'public' && this.publicRelayUrl === '') return 'public mode selected but no relay URL is configured'
    return null
  }

  /**
   * Prepare the state, start the relay, and start the bridge when appropriate.
   *
   * @param options.bridge - whether to start the bridge now. False while the
   *   Harness address is still being looked for; see [startBridge].
   */
  start({ bridge = true } = {}) {
    // The token comes first: both children take it as an argument, so a missing
    // one makes each of them exit for a reason that reads as unrelated.
    try {
      mkdirSync(this.stateDir, { recursive: true })
      this.token = ensureToken(this.tokenFile)
    } catch (error) {
      this.blocked = `could not prepare the state directory: ${error.message}`
      return
    }

    this.blocked = this.precondition()
    if (this.blocked !== null) return

    // The bridge dials the relay, so the relay goes first. Both are given a
    // chance to fail on their own without taking the other down.
    this.relay.start()

    // The bridge can be held back when the Harness address is not known yet. It
    // exits immediately without one, and a process that keeps exiting and being
    // restarted is worse than one that has not been started: the status line would
    // flicker between "starting" and "not running" while the address is being
    // found.
    if (bridge) this.startBridge()
  }

  /** Start the bridge. Safe to call when it is already running. */
  startBridge() {
    if (this.blocked !== null || this.bridge.running) return
    if (this.dshUrl === null) return

    this.bridge.args = [
      this.bridgeEntry,
      '--relay', this.bridgeRelayUrl(),
      '--token-file', this.tokenFile,
      '--state', this.stateDir,
      '--dsh', this.dshUrl,
    ]
    this.bridge.start()
  }

  stop() {
    return Promise.all([this.bridge.stop(), this.relay.stop()])
  }

  /**
   * Restart everything.
   *
   * Asynchronous, and awaiting it matters: killing the relay and starting it
   * again in the same tick leaves it unable to bind, because the port is still
   * held by a process that has been signalled but has not exited. The symptom is
   * a switch that reports success and then a relay that is not running.
   */
  async restart() {
    if (this.restarting) return this.restarting
    this.restarting = (async () => {
      await this.stop()
      this.start()
    })().finally(() => {
      this.restarting = null
    })
    return this.restarting
  }

  /**
   * Switch which relay this bridge attaches to, and remember it.
   *
   * A restart is required because `--relay` is read once at process start, and
   * the argument wins over any config file - so there is no way to move a running
   * bridge to a different relay. That is the right shape anyway: the two modes
   * are two different connections, not one connection with a tunable.
   *
   * @returns the mode actually in effect, which is the old one if the change was
   *   rejected.
   */
  setMode(mode, publicRelayUrl) {
    if (mode !== 'lan' && mode !== 'public') return this.mode
    const nextUrl = typeof publicRelayUrl === 'string' ? publicRelayUrl.trim() : this.publicRelayUrl

    // Public mode without an address would attach to nothing and report a bridge
    // that is running but useless, so it is refused rather than half-applied.
    if (mode === 'public' && nextUrl === '') return this.mode

    this.mode = mode
    this.publicRelayUrl = nextUrl
    this.persistPrefs()
    return this.mode
  }

  persistPrefs() {
    try {
      mkdirSync(this.stateDir, { recursive: true })
      writePrefs(this.prefsFile, { mode: this.mode, publicRelayUrl: this.publicRelayUrl })
    } catch {
      // The mode is live either way; only its persistence is lost, and the
      // next start falls back to LAN.
    }
  }

  /**
   * The state a status light needs.
   *
   * The three pieces are reported separately because they fail independently and
   * are fixed in different places: a relay that is down, a bridge that cannot
   * reach its relay, and a bridge whose relay is fine but which no watch has
   * attached to are three different things to do about it.
   */
  snapshot() {
    const relayUrl = this.bridgeRelayUrl()
    const bridgeAttached = this.bridge.find(/attached to relay as pc "([^"]+)"/)
    const watchAttached = this.bridge.find(/watch ([\w-]+) attached/)
    const linkAlive = this.bridge.find(/relay link alive/)
    const deadLink = this.bridge.find(/relay stopped answering/)

    return {
      mode: this.mode,
      relayUrl,
      repo: this.repo,
      blocked: this.blocked,
      restarting: this.restarting !== null,
      /** Where a watch should be told to look, in the order it should try. */
      endpoints: this.watchEndpoints(),
      lanIp: this.lanIp,
      publicRelayUrl: this.publicRelayUrl,
      relay: {
        running: this.relay.running,
        port: this.relayPort,
        pid: this.relay.process?.pid ?? null,
        spawnFailed: this.relay.spawnFailed,
      },
      bridge: {
        running: this.bridge.running,
        pid: this.bridge.process?.pid ?? null,
        spawnFailed: this.bridge.spawnFailed,
        pcId: bridgeAttached?.[1] ?? null,
        watchId: watchAttached?.[1] ?? null,
        heartbeat: linkAlive ? 'alive' : deadLink ? 'dead' : 'unknown',
      },
      log: {
        relay: this.relay.lines.slice(-8),
        bridge: this.bridge.lines.slice(-12),
      },
    }
  }
}
