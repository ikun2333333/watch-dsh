/**
 * A tiny status endpoint owned by this plugin.
 *
 * ## Why not the host's web server
 *
 * It was tried. Declaring `inject: ['webServer']` left this plugin *pending* in the
 * desktop app - the shell serves the UI over a custom `dsh-app://` protocol - and
 * because a status line had been registered into `conversation.composer.bar`, the
 * conversation plugin could not complete and eight client plugins fell over with
 * it. The desktop app's own crash log named the conversation plugin, which is why
 * that took a while to find.
 *
 * The lesson is not "try harder to find the right service"; it is that a status
 * light has no business depending on the host's UI plumbing. So this owns its
 * endpoint: one loopback listener, started by this plugin, serving one document.
 *
 * ## Binding and exposure
 *
 * Loopback only. The status names the PC id and the relay, which is not secret but
 * is also not something to publish on a LAN for the sake of a status line.
 *
 * A fixed port with a small scan, because the browser half has to know where to
 * look: a random port would need to be communicated, and the only channels for
 * that are the ones this exists to avoid.
 */
import { createServer } from 'node:http'

/**
 * A body ceiling for the mode request.
 *
 * The only body this accepts is `{"mode":"lan"}`. A limit costs nothing and means
 * a malformed or hostile request cannot make the plugin read unbounded input.
 */
const MAX_BODY_BYTES = 4 * 1024

/**
 * Read a request body as JSON.
 *
 * @returns the parsed object, or an empty object for an empty body, so a command
 *   with no arguments does not have to send one.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw === '') {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch (error) {
        reject(new Error(`body is not JSON: ${error.message}`))
      }
    })
  })
}

/** First port tried; the range above it covers an unrelated listener. */
export const DEFAULT_STATUS_PORT = 8799

/** How many ports to try before giving up. */
const PORT_SCAN = 8

/**
 * Start the status endpoint.
 *
 * @param getStatus - called per request, so the document is never stale.
 * @param commands - route name to handler. Each takes the parsed body and returns
 *   a result object; `ok: false` makes the response a 400, because a command that
 *   ran and answered "no" is not the same as a malformed request.
 * @param log - where to record a failure, since a silent listener is worse than
 *   none at all.
 * @param startPort - first port to try.
 * @returns the bound port, or null when nothing could be bound.
 */
export async function startStatusServer(getStatus, commands, log, startPort = DEFAULT_STATUS_PORT) {
  for (let offset = 0; offset < PORT_SCAN; offset += 1) {
    const port = startPort + offset
    const server = createServer((req, res) => {
      // The page and this listener are different origins, and a status line is not
      // worth a credential, so it is open to the local machine. Anything on this
      // host could read it anyway; nothing off it can reach the socket.
      res.setHeader('access-control-allow-origin', '*')
      res.setHeader('cache-control', 'no-store')
      res.setHeader('content-type', 'application/json; charset=utf-8')
      // The mode switch is a POST, which the browser preflights.
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
      res.setHeader('access-control-allow-headers', 'content-type')

      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      const route = new URL(req.url ?? '/', 'http://127.0.0.1').pathname

      // Everything beyond the status document is a command, and every command is a
      // POST: a GET is something a prefetch or a stray navigation can perform, and
      // none of these - moving the bridge to another relay, pairing a watch - is
      // safe to do by accident.
      if (req.method !== 'POST') {
        try {
          res.writeHead(200)
          res.end(JSON.stringify(getStatus()))
        } catch (error) {
          res.writeHead(500)
          res.end(JSON.stringify({ error: error?.message ?? String(error) }))
        }
        return
      }

      const handler = commands[route === '/' ? '/mode' : route]
      if (handler === undefined) {
        res.writeHead(404)
        res.end(JSON.stringify({ ok: false, error: `no such command: ${route}` }))
        return
      }

      readJsonBody(req)
        .then(handler)
        .then((result) => {
          // The handler decides its own status code: a pairing that could not reach
          // the watch is a completed request with a negative answer, not a
          // malformed one.
          res.writeHead(result?.ok === false ? 400 : 200)
          res.end(JSON.stringify({ ...result, status: getStatus() }))
        })
        .catch((error) => {
          res.writeHead(400)
          res.end(JSON.stringify({ ok: false, error: error?.message ?? String(error) }))
        })
    })

    const bound = await new Promise((resolve) => {
      server.once('error', (error) => {
        // A busy port is expected and is why the scan exists; anything else is
        // worth saying out loud.
        if (error?.code !== 'EADDRINUSE') log(`status port ${port}: ${error?.code ?? error?.message}`)
        resolve(false)
      })
      server.listen(port, '127.0.0.1', () => resolve(true))
    })

    if (bound) {
      log(`status endpoint on http://127.0.0.1:${port}/`)
      return { port, close: () => new Promise((resolve) => server.close(resolve)) }
    }
  }

  log('no free port for the status endpoint; the status line will stay absent')
  return null
}
