// Rewrite the probe plugin's files cleanly.
//
// Deliberately from Node and not PowerShell: `Set-Content -Encoding UTF8` adds a
// BOM, and a read-then-write round trip through PowerShell 5.1 decodes UTF-8 as
// ANSI and corrupts the result. Both have now broken this project once each.
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2]

mkdirSync(dir, { recursive: true })

const manifest = {
  name: 'dsh-watch-probe',
  version: '0.1.0',
  private: true,
  type: 'module',
  main: 'index.js',
  exports: {
    '.': { default: './index.js' },
    './package.json': './package.json',
  },
  files: ['index.js'],
  license: 'MIT',
}

writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

const probe = `/**
 * Answers one question: does this host context have the webServer service?
 *
 * It waits for nothing and registers nothing, so it cannot delay another plugin -
 * which is the only reason it is safe to enable in a host that is currently
 * working. Everything it learns is appended to a file, because the console of a
 * packaged desktop app is not readable.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'watch-probe'

/** Nothing awaited: a service that never appears would leave this pending. */
export const inject = []

const ROOT = ${JSON.stringify(process.argv[3] ?? '.')}
const LOG = join(ROOT, '.state', 'probe.log')

function say(line) {
  try {
    mkdirSync(join(ROOT, '.state'), { recursive: true })
    appendFileSync(LOG, new Date().toISOString() + '  ' + line + '\\n')
  } catch {
    // Nothing to do about it.
  }
}

export function apply(ctx) {
  say('--- apply called ---')
  say('DSH_WEB_URL = ' + (process.env.DSH_WEB_URL ?? '(unset)'))
  say('DSH_PROFILE = ' + (process.env.DSH_PROFILE ?? '(unset)'))
  say('DSH_PROFILE_DIR = ' + (process.env.DSH_PROFILE_DIR ?? '(unset)'))

  // Attempted, not declared. Reading an undeclared service throws by design, and
  // catching that throw is the safe way to ask whether the service is present: it
  // cannot leave this plugin pending the way a declared-but-absent one would.
  for (const key of ['webServer', 'sandbox', 'commands', 'jobs', 'skills']) {
    try {
      const value = ctx[key]
      if (value === undefined) {
        say('ctx.' + key + ' = undefined')
      } else if (value === null) {
        say('ctx.' + key + ' = null')
      } else {
        say('ctx.' + key + ' = ' + typeof value)
        if (key === 'webServer') {
          say('    port = ' + String(value.port))
          say('    register = ' + typeof value.register)
        }
      }
    } catch (error) {
      say('ctx.' + key + ' threw: ' + (error?.message ?? String(error)))
    }
  }

  say('--- done ---')
}
`

writeFileSync(join(dir, 'index.js'), probe, 'utf8')

console.log('rewrote', dir)
console.log('manifest parses as:', JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name)
