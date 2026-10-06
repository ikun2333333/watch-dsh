// Does the running DSH actually have the code that is deployed right now?
//
// Twice now a working fix looked like it had failed, because the process had
// loaded the plugin minutes before the files were copied and host-side code is
// read once at activation. Comparing timestamps by eye is how that was missed, so
// this compares content hashes instead and says which files are stale.
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const [repo, deployed] = process.argv.slice(2)

const files = [
  'package.json',
  'lib/index.js',
  'lib/client.js',
  'lib/supervisor.js',
  'lib/status-server.js',
  'lib/find-harness.js',
]

const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

let stale = 0
for (const file of files) {
  const from = join(repo, 'dsh-plugin', file)
  const to = join(deployed, file)
  try {
    if (hash(from) !== hash(to)) {
      stale += 1
      console.log(`  STALE  ${file}`)
    }
  } catch (error) {
    stale += 1
    console.log(`  MISSING ${file}: ${error.message}`)
  }
}

if (stale === 0) console.log('  deployed copy matches the repository')

// The question the check is really for: is the plugin newer than the process that
// would have loaded it?
const newest = Math.max(...files.map((file) => statSync(join(deployed, file)).mtimeMs))
console.log(`  newest plugin file: ${new Date(newest).toLocaleString()}`)
console.log('  a DSH process started before that time is running older code')

process.exitCode = stale === 0 ? 0 : 1
