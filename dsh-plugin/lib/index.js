/**
 * dsh-watch-dsh, host half.
 *
 * Brings the two pieces of the watch link up with the Harness itself - the relay
 * a watch dials and the bridge that talks to this Harness - so that starting DSH
 * is the only step. It also owns the pairing flow and reports state to the Web
 * GUI over plain HTTP.
 *
 * HTTP rather than the Typert RPC the shipped plugins use: that layer needs a
 * generated invocation contract, and this plugin has a handful of endpoints and a
 * status blob. Plain routes are inspectable with curl, which is also how this was
 * developed and tested without a browser.
 */
import { join } from 'node:path'
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs'

import { WatchLink } from './supervisor.js'

/**
 * Record what happened where a failed plugin cannot hide it.
 *
 * This plugin once stopped DSH from starting, and the only available evidence was
 * the fact that it did - the error went to a console nobody was reading, and the
 * app simply did not come up. A log file next to the rest of the plugin's state
 * is what makes the next failure diagnosable, whatever it turns out to be.
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

/** The relay token as stored, or an empty string when it is not there yet. */
function readToken(tokenFile) {
  try {
    return readFileSync(tokenFile, 'utf8').trim()
  } catch {
    return ''
  }
}

/** Where the watch-dsh checkout lives, unless the config says otherwise. */
const DEFAULT_REPO = 'C:\\Users\\q1375\\Documents\\watch-dsh'

/** Everything the browser sees lives under this prefix. */
const PREFIX = '/watch-dsh'

export const name = 'watch-dsh'

/**
 * A hard declaration, because Cordis refuses to read a service that was not
 * declared: `ctx.webServer` on an undeclared service throws "cannot get property
 * without inject" rather than returning undefined, so a soft check in the body
 * cannot work - the access itself is the error.
 *
 * Declaring it also means Cordis waits for the web server before starting this
 * plugin, which is what makes the port readable in the first place.
 */
export const inject = ['webServer']

/**
 * No `Config` export on purpose.
 *
 * Cordis validates a plugin's config against a schemastery schema, and exporting
 * a plain object instead fails the whole tree with "Cannot read properties of
 * undefined (reading 'validate')" - an error that names neither config nor this
 * plugin. With a few optional settings and defaults in the body, a schema would
 * only add a way to get that wrong.
 */

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * Read a JSON request body, with a size ceiling.
 *
 * The route is reachable from anything that can reach the GUI's port, so an
 * unbounded body is not acceptable even though the caller is usually this page.
 */
function readJson(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error(`body is not JSON: ${error.message}`))
      }
    })
  })
}

export function apply(ctx, config) {
  // Defaults live here rather than in a schema. The repo path arrives through
  // YAML, where a backslash may be written escaped, so it is normalised on the
  // way in - a doubled path silently resolves to nothing.
  const repo = String(config?.repo ?? DEFAULT_REPO).replace(/\\\\/g, '\\')
  const log = makeLog(repo)

  try {
    run(ctx, config, repo, log)
  } catch (error) {
    // A thrown error out of apply fails this plugin's fiber, and depending on how
    // the host composes, that can take the whole tree with it. Whatever went
    // wrong here, DSH starting matters more than this plugin running.
    log(`FAILED to start: ${error?.stack ?? error?.message ?? String(error)}`)
    ctx.logger?.error?.(`watch-dsh failed to start: ${error?.message ?? String(error)}`)
  }
}

function run(ctx, config, repo, log) {
  const relayPort = Number(config?.relayPort ?? 8787)

  const stateDir = join(repo, '.state')
  const tokenFile = join(stateDir, 'relay-token')

  // Declared in `inject`, so this is present by construction. Checked anyway for
  // the shape, not for absence: a host that provides something other than a
  // server is a reason to skip the routes, not to fail.
  const webServer = ctx.webServer
  if (typeof webServer?.register !== 'function') {
    log('the webServer service has no register(); the status panel will not be served')
    return
  }

  // The Harness this bridge should talk to is the one serving this page, so its
  // address is read from the web server rather than configured: a second place to
  // write the port is a second place to get it wrong.
  const dshUrl = `http://127.0.0.1:${webServer.port}`

  const node = config?.node ?? process.execPath

  const link = new WatchLink({
    repo,
    node,
    relayPort,
    dshUrl,
    stateDir,
    tokenFile,
    mode: config?.mode === 'public' ? 'public' : 'lan',
    publicRelayUrl: String(config?.publicRelayUrl ?? ''),
  })

  link.start()

  ctx.effect(
    () => () => link.stop(),
    'watch-dsh: stop the relay and bridge',
  )

  ctx.effect(
    () =>
      webServer.register({
        kind: 'prefix',
        path: PREFIX,
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const route = url.pathname.slice(PREFIX.length) || '/'

          try {
            if (route === '/' || route === '/status') {
              const snapshot = link.snapshot()
              json(res, 200, {
                ok: snapshot.blocked === null && snapshot.bridge.running,
                blocked: snapshot.blocked,
                detail: describe(snapshot),
                ...snapshot,
                at: Date.now(),
              })
              return
            }

            if (route === '/restart' && req.method === 'POST') {
              await link.restart()
              json(res, 200, { ok: true })
              return
            }

            if (route === '/mode' && req.method === 'POST') {
              const body = await readJson(req)
              const applied = link.setMode(body.mode, body.publicRelayUrl)
              if (body.mode === 'public' && applied !== 'public') {
                json(res, 400, {
                  ok: false,
                  error: 'public mode needs a relay URL; nothing was changed',
                  mode: applied,
                })
                return
              }
              // Awaited so the answer means the switch happened rather than that
              // it was requested. The restart takes a few seconds.
              await link.restart()
              json(res, 200, { ok: true, mode: applied, relayUrl: link.bridgeRelayUrl() })
              return
            }

            // The config a watch is configured from. Returned rather than written,
            // so the caller decides where it goes; the pairing flow is what pushes
            // it to a device.
            if (route === '/watch-config') {
              const snapshot = link.snapshot()
              const endpoints = snapshot.endpoints
              json(res, 200, {
                ok: true,
                mode: link.mode,
                config: {
                  dsh: 'watch-dsh-config',
                  v: 1,
                  pcId: snapshot.bridge.pcId,
                  relayUrl: endpoints.relayUrl,
                  lanRelayUrl: endpoints.lanRelayUrl,
                  relayToken: readToken(link.tokenFile),
                },
              })
              return
            }

            json(res, 404, { ok: false, error: `no route ${route}` })
          } catch (error) {
            json(res, 500, { ok: false, error: error?.message ?? String(error) })
          }
        },
      }),
    'watch-dsh: http routes',
  )

  ctx.logger?.info?.(`watch-dsh: ${describe(link.snapshot())}`)
}

/**
 * One sentence for the status line.
 *
 * Ordered by what the user would have to fix first, so the first thing wrong is
 * the thing shown - a relay that never started makes the bridge's state
 * meaningless.
 */
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
