// Rewrite the watch-dsh entry in the machine patch, by hand.
//
// The two previous attempts used scripts that inserted lines relative to a match,
// and both got the indentation or the position wrong - one produced two `disabled`
// keys and the other made the file unparseable. So this does not patch: it
// replaces the whole `- insert:` block for watch-dsh with exact text, and leaves
// every other line untouched.
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'

const patchFile = process.argv[2]

copyFileSync(patchFile, `${patchFile}.bak-handrewrite`)

const original = readFileSync(patchFile, 'utf8')

// Drop everything from the watch-dsh insert block to the end of the file, since
// that block is last and is the only one being managed here.
const start = original.indexOf('- insert:')
if (start === -1) {
  console.error('no insert block found; refusing to guess')
  process.exit(1)
}

const kept = original.slice(0, start).replace(/\s*$/, '')

const block = [
  '',
  '- insert:',
  '    - id: watch-dsh',
  '      name: dsh-watch-dsh',
  '      # Disabled while the browser half is still breaking the conversation UI.',
  '      # The host half is verified working; the client half is not, and a plugin',
  '      # that cannot start must not be able to stop DSH from starting.',
  '      disabled: true',
  '      config:',
  "        repo: 'C:\\\\Users\\\\q1375\\\\Documents\\\\watch-dsh'",
  '        relayPort: 8787',
  "        publicRelayUrl: 'wss://kangjunyu.dpdns.org'",
  '',
].join('\n')

writeFileSync(patchFile, `${kept}\n${block}`, 'utf8')
console.log('rewritten; the watch-dsh block now ends the file')
