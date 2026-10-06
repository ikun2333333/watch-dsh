/**
 * dsh-watch-dsh, host half.
 *
 * Brings the two pieces of the watch link up with the Harness itself - the relay
 * a watch dials and the bridge that talks to this Harness - so that starting DSH
 * is the only step.
 *
 * ## Why this does not use the web server
 *
 * It did, and that stopped the desktop app from starting. The desktop app serves
 * the UI over a custom `dsh-app://` protocol and has no `webServer` service at
 * all, so declaring `inject: ['webServer']` left this plugin permanently
 * *pending* - never activated. Because it had registered into
 * `conversation.composer.bar`, that left the conversation plugin waiting on a
 * slot occupant that would never arrive, and eight client plugins failed to
 * activate with it. The failure report named the conversation plugin, not this
 * one, which is why it took a while to find.
 *
 * So: no `inject` at all, nothing awaited, and every step guarded. This plugin
 * must run where the web server does not exist, and must never be something
 * another plugin waits on.
 *
 * ## How status reaches the UI
 *
 * It is written to a file - `state/dsh-status.json` - which the browser half
 * reads. A file rather than a route because a route needs the web server, and a
 * file behaves identically in both shells.
 */
import { join, dirname } from 'node:path'
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'

import { WatchLink } from './supervisor.js'
import { startStatusServer } from './status-server.js'
import { findHarnessUrl } from './find-harness.js'

/** Where the watch-dsh checkout lives, unless the config says otherwise. */
const DEFAULT_REPO = 'C:\\Users\\q1375\\Documents\\watch-dsh'

/** How often the status file is refreshed. */
const WRITE_INTERVAL_MS = 2000

export const name = 'watch-dsh'

/**
 * Deliberately empty.
 *
 * A declared service that never appears leaves the plugin *pending* rather than
 * failing it, and a slot cannot complete while one of its registered occupants is
 * pending. Injecting nothing is what makes this plugin unable to hold up the UI.
 */
export const inject = []

/**
 * No `Config` export either: Cordis validates against a schemastery schema, and a
 * plain object fails the whole tree with an error naming neither config nor this
 * plugin.
 */

export function apply(ctx, config) {
  const repo = String(config?.repo ?? DEFAULT_REPO).replace(/\\\\/g, '\\')

  // Logging first, and inside its own guard, so a failure anywhere below still
  // leaves a record. An earlier version took DSH down and left nothing to read
  // but the fact that it had happened.
  const log = makeLog(repo)

  try {
    const link = new WatchLink({
      repo,
      node: config?.node ?? process.execPath,
      relayPort: Number(config?.relayPort ?? 8787),
      stateDir: join(repo, '.state'),
      tokenFile: join(repo, '.state', 'relay-token'),
      mode: config?.mode,
      publicRelayUrl: config?.publicRelayUrl,
      // Filled in below by a probe; the bridge cannot start correctly without it.
      dshUrl: null,
    })

    // The Harness address is found before the bridge is started, because a bridge
    // started without it exits at once and reports a connection refused against a
    // port nothing is listening on - which reads as a broken plugin rather than as
    // a missing address. Detection is asynchronous, so the relay can come up while
    // it runs.
    findHarnessUrl(config?.dshUrl, log)
      .then((url) => {
        link.dshUrl = url ?? dshUrlFromEnv(undefined)
        link.start()
        log(`started: mode=${link.mode} relay=${link.bridgeRelayUrl()} harness=${link.dshUrl ?? '(unknown)'}`)
      })
      .catch((error) => {
        log(`could not start the link: ${error?.message ?? String(error)}`)
        // Started anyway: the status endpoint then reports a bridge that is not
        // running, which is a better answer than no status at all.
        link.start()
      })

    // Status goes three places, deliberately:
    //   - a loopback endpoint the browser half fetches (the only one that reaches
    //     the UI, and the only one this plugin owns end to end);
    //   - a file, so a failure can be read without a working UI;
    //   - the log, as a last resort.
    const status = () => {
      const snapshot = link.snapshot()
      return { ok: snapshot.blocked === null && snapshot.bridge.running, detail: describe(snapshot), ...snapshot, at: Date.now() }
    }

    const statusFile = join(repo, '.state', 'dsh-status.json')
    const tick = () => {
      try {
        writeStatus(statusFile, link)
      } catch (error) {
        log(`could not write status: ${error?.message ?? String(error)}`)
      }
    }
    tick()
    const timer = setInterval(tick, WRITE_INTERVAL_MS)
    timer.unref?.()

    // Started without being awaited into apply: the listener is asynchronous, and
    // a plugin that blocks its own activation on a socket is a plugin that can
    // hold up whatever waits for it.
    let statusServer = null
    startStatusServer(status, log)
      .then((server) => {
        statusServer = server
      })
      .catch((error) => {
        log(`status endpoint failed: ${error?.message ?? String(error)}`)
      })

    ctx.effect(
      () => () => {
        clearInterval(timer)
        link.stop()
        statusServer?.close?.()
        log('stopped')
      },
      'watch-dsh: stop the relay and bridge',
    )
  } catch (error) {
    log(`FAILED to start: ${error?.stack ?? error?.message ?? String(error)}`)
    ctx.logger?.error?.(`watch-dsh failed to start: ${error?.message ?? String(error)}`)
  }
}

/**
 * Where the Harness is listening, as the bridge should be told.
 *
 * Config first, then the environment, because a configured value is a deliberate
 * statement and the environment is what happened to be inherited. Returns null
 * when neither is available, which the caller reports rather than silently
 * letting the bridge fall back to a default port that is probably not this
 * Harness - the failure that produced "connect ECONNREFUSED 127.0.0.1:3080" in an
 * earlier version while DSH was actually on 19500.
 */
function dshUrlFromEnv(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  const fromEnv = process.env.DSH_WEB_URL
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return null
}

/**
 * Record what happened where a failed plugin cannot hide it.
 *
 * The log has to be reachable without the plugin working, which is the only state
 * in which anyone needs it.
 */
function makeLog(repo) {
  let file = null
  try {
    mkdirSync(join(repo, '.state'), { recursive: true })
    file = join(repo, '.state', 'dsh-plugin.log')
  } catch {
    // Nothing to write to; the plugin still has to work.
  }
  return (message) => {
    if (file === null) return
    try {
      appendFileSync(file, `${new Date().toISOString()}  ${message}\n`)
    } catch {
      // Logging must never be the thing that breaks the plugin.
    }
  }
}

/**
 * Publish the status for the browser half to read.
 *
 * Written to a temporary file and renamed, so a reader never sees a half-written
 * document - the browser polls this file, and a partial read would surface as a
 * parse error rather than as slightly stale data.
 */
function writeStatus(file, link) {
  const snapshot = link.snapshot()
  const payload = {
    ok: snapshot.blocked === null && snapshot.bridge.running,
    detail: describe(snapshot),
    ...snapshot,
    at: Date.now(),
  }
  const temp = `${file}.tmp`
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  renameSync(temp, file)
}

/** One sentence a status line can show, ordered by what to fix first. */
function describe(snapshot) {
  if (snapshot.blocked !== null) return snapshot.blocked
  if (snapshot.restarting) return 'switching relay...'
  if (snapshot.relay.spawnFailed) return `relay failed to start: ${snapshot.relay.spawnFailed}`
  if (snapshot.bridge.spawnFailed) return `bridge failed to start: ${snapshot.bridge.spawnFailed}`
  if (!snapshot.relay.running) return 'relay is not running'
  if (!snapshot.bridge.running) return 'bridge is not running'
  if (snapshot.bridge.pcId === null) return 'bridge is starting'
  if (snapshot.bridge.watchId === null) return `${snapshot.bridge.pcId}, no watch yet`
  return `${snapshot.bridge.pcId}, watch ${snapshot.bridge.watchId} connected`
}
