/**
 * Find the Harness's HTTP port.
 *
 * ## Why this is probed and not looked up
 *
 * The bridge has to be told where the Harness is, and the obvious sources are all
 * unavailable from inside a plugin in this shell:
 *
 *   - `ctx.webServer` cannot be read without declaring it, and declaring it is what
 *     left this plugin pending in the desktop app and took the conversation UI down
 *     with it. Reading it is not an option.
 *   - `DSH_WEB_URL` is set for a session's shell, not for the process that loads
 *     plugins: a probe run inside the desktop host reported it unset.
 *   - the address is not in any config file under `DSH_HOME`.
 *
 * What is true is that something answers `/api/client-modules` on the port the UI
 * is served from, and answers 401 rather than 404 when a token is required. So the
 * port is found by asking, which also survives the user moving it - it has moved
 * once in this project already, from 3080 to 19387.
 */
import { request } from 'node:http'

/** Ports tried in order. 19387 first because that is where this Harness runs. */
const DEFAULT_CANDIDATES = [19387, 3080, 3000, 8080, 8081, 5000]

/** A probe that finds nothing is not worth more than a second of startup. */
const PROBE_TIMEOUT_MS = 700

/**
 * Ask one port whether it serves the Harness API.
 *
 * @returns true when something answers the API path, whatever the status: 401 is
 *   a Harness requiring a token and 404 is a Harness with no such route, while no
 *   answer at all means nothing is there.
 */
function probe(port) {
  return new Promise((resolve) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/api/client-modules', method: 'GET', timeout: PROBE_TIMEOUT_MS },
      (res) => {
        res.resume()
        // 404 is included on purpose: the route only exists once the API gateway
        // has claimed it, and the port being served by DSH is what matters.
        resolve(res.statusCode !== undefined)
      },
    )
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.on('error', () => resolve(false))
    req.end()
  })
}

/**
 * The first candidate that looks like the Harness.
 *
 * @param configured - an explicit URL or port from config, tried first.
 * @param log - where to record the outcome, since a guess that fails produces a
 *   bridge that exits for a reason nothing else records.
 * @returns a URL, or null when nothing answered.
 */
export async function findHarnessUrl(configured, log) {
  const candidates = []

  if (typeof configured === 'string' && configured.trim() !== '') {
    candidates.push(configured.trim())
  }
  for (const port of DEFAULT_CANDIDATES) candidates.push(`http://127.0.0.1:${port}`)

  for (const candidate of candidates) {
    let port
    try {
      port = Number(new URL(candidate).port)
    } catch {
      continue
    }
    if (!Number.isFinite(port) || port <= 0) continue
    if (await probe(port)) {
      log(`harness found on ${candidate}`)
      return candidate
    }
  }

  log(`no harness answered on ${candidates.join(', ')}`)
  return null
}
