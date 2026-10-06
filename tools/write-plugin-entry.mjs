// Rewrite the watch-dsh entry in a DSH patch file, enabled or disabled.
//
// Replaces the whole block with exact text rather than inserting lines relative to
// a match. Two earlier attempts did the latter: one produced duplicate `disabled`
// keys and the other broke the file's indentation, and DSH refused to start on it.
//
// Usage: node write-plugin-entry.mjs <patch-file> <on|off>
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'

const [patchFile, mode] = process.argv.slice(2)

if (mode !== 'on' && mode !== 'off') {
  console.error('mode must be "on" or "off"')
  process.exit(1)
}

copyFileSync(patchFile, `${patchFile}.bak-entry-${mode}`)

const original = readFileSync(patchFile, 'utf8')

// The watch-dsh block is last, so everything from its `- insert:` onward is
// replaced. A different block appearing after it would be dropped, so this
// refuses rather than guessing if the file does not end with it.
const start = original.indexOf('- insert:')
if (start === -1) {
  console.error('no insert block found; refusing to guess')
  process.exit(1)
}
const tail = original.slice(start)
if (!tail.includes('id: watch-dsh')) {
  console.error('the last insert block is not watch-dsh; refusing to guess')
  process.exit(1)
}

const kept = original.slice(0, start).replace(/\s*$/, '')

const lines = [
  '',
  '- insert:',
  '    - id: watch-dsh',
  '      name: dsh-watch-dsh',
]

if (mode === 'on') {
  lines.push(
    '      # Stopped DSH from starting three times. This version follows the working',
    '      # third-party plugin dsh-api-dashboard on the three points where it differed:',
    '      # it registers into conversation.composer.dock, its client inject names client',
    '      # plugins rather than host services, and it is installed with a node_modules',
    '      # symlink for the host to resolve peers through.',
    '      disabled: true',
  )
}

lines.push(
  '      config:',
  "        repo: 'C:\\\\Users\\\\q1375\\\\Documents\\\\watch-dsh'",
  '        relayPort: 8787',
  "        publicRelayUrl: 'wss://kangjunyu.dpdns.org'",
  '',
)

writeFileSync(patchFile, `${kept}\n${lines.join('\n')}`, 'utf8')
console.log(`watch-dsh: ${mode === 'on' ? 'disabled' : 'enabled'}`)
