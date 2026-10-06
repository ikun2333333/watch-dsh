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

/** First port tried; the range above it covers an unrelated listener. */
export const DEFAULT_STATUS_PORT = 8799

/** How many ports to try before giving up. */
const PORT_SCAN = 8

/**
 * Start the status endpoint.
 *
 * @param getStatus - called per request, so the document is never stale.
 * @param log - where to record a failure, since a silent listener is worse than
 *   none at all.
 * @returns the bound port, or null when nothing could be bound.
 */
export async function startStatusServer(getStatus, log, startPort = DEFAULT_STATUS_PORT) {
  for (let offset = 0; offset < PORT_SCAN; offset += 1) {
    const port = startPort + offset
    const server = createServer((req, res) => {
      // The page and this listener are different origins, and a status line is not
      // worth a credential, so it is open to the local machine. Anything on this
      // host could read it anyway; nothing off it can reach the socket.
      res.setHeader('access-control-allow-origin', '*')
      res.setHeader('cache-control', 'no-store')
      res.setHeader('content-type', 'application/json; charset=utf-8')

      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      try {
        res.writeHead(200)
        res.end(JSON.stringify(getStatus()))
      } catch (error) {
        res.writeHead(500)
        res.end(JSON.stringify({ error: error?.message ?? String(error) }))
      }
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
