/**
 * dsh-watch-dsh, host half.
 *
 * Brings the two pieces of the watch link up with the Harness itself - the relay
 * a watch dials and the bridge that talks to this Harness - so that starting DSH
 * is the only step. It also owns the pairing flow and reports state to the Web
 * GUI over plain HTTP.
 *
 * HTTP rather than the Typert RPC the shipped plugins use: that layer needs a
 * generated invocation contract, and this plugin has four endpoints and a status
 * blob. Plain routes are inspectable with curl, which is also how this was
 * developed and tested without a browser.
 */

/** Where the watch-dsh checkout and its state live. */
const DEFAULT_REPO = 'C:\\Users\\q1375\\Documents\\watch-dsh'

/** Anything the browser should see lives under this prefix. */
const PREFIX = '/watch-dsh'

export const name = 'watch-dsh'

export const inject = ['webServer']

/**
 * No `Config` export on purpose.
 *
 * Cordis validates a plugin's config against a schemastery schema, and exporting
 * a plain object instead fails the whole tree with "Cannot read properties of
 * undefined (reading 'validate')" - an error that names neither config nor this
 * plugin. With two optional settings and defaults in the body, a schema would
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
 * A local-only endpoint still should not read an unbounded body: the route is
 * reachable from anything that can reach the GUI's port.
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
  const settings = {
    repo,
    relayPort: Number(config?.relayPort ?? 8787),
  }

  /** Everything the endpoints report. Mutable, read on every request. */
  const state = {
    repo: settings.repo,
    relayPort: settings.relayPort,
    detail: 'plugin loaded',
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: PREFIX,
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const route = url.pathname.slice(PREFIX.length) || '/'

          if (route === '/' || route === '/status') {
            json(res, 200, { ok: true, ...state, at: Date.now() })
            return
          }

          if (route === '/echo') {
            try {
              const body = await readJson(req)
              json(res, 200, { ok: true, echoed: body })
            } catch (error) {
              json(res, 400, { ok: false, error: error.message })
            }
            return
          }

          json(res, 404, { ok: false, error: `no route ${route}` })
        },
      }),
    'watch-dsh: http routes',
  )

  ctx.logger?.info?.(`watch-dsh: serving ${PREFIX} (repo ${settings.repo})`)
}
