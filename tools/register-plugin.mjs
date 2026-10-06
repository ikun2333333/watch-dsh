// Register dsh-watch-dsh in the machine-level DSH patch layer.
//
// Written from Node rather than PowerShell because `Set-Content -Encoding UTF8`
// prepends a BOM, and DSH's YAML/JSON readers treat that as a parse error - which
// fails the whole plugin tree, not just this entry.
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

const dshHome = process.argv[2]
const repo = process.argv[3]

const patchFile = join(dshHome, 'cordis.patch.yml')
const entryId = 'watch-dsh'

const current = readFileSync(patchFile, 'utf8')

if (current.includes(`id: ${entryId}`)) {
  console.log('already registered; nothing written')
  process.exit(0)
}

copyFileSync(patchFile, `${patchFile}.pre-watchdsh`)

const block = [
  '',
  '# ---------------------------------------------------------------------------',
  '# watch-dsh - control the DeepSeek Harness from a Galaxy Watch.',
  '#',
  '# The plugin runs the relay and the bridge as children of DSH, so starting DSH',
  '# is the only step, and it adds a status line with a LAN/Public switch to the',
  '# composer bar. The switch is manual because the mode cannot be inferred:',
  '# broadcast only reaches the local network, and routers that drop traffic',
  '# between wireless clients are common enough that one was measured on this',
  '# network.',
  '#',
  '# To unload it, delete this block or add `disabled: true` under the entry.',
  '# The relay and bridge are stopped with it - they are children of DSH, not',
  '# orphans, because a relay keeps one bridge per pc id and an orphan would',
  '# silently replace the live one.',
  '# ---------------------------------------------------------------------------',
  '- insert:',
  `    - id: ${entryId}`,
  '      name: dsh-watch-dsh',
  '      config:',
  `        repo: '${repo.replace(/\\/g, '\\\\')}'`,
  '        relayPort: 8787',
  '        publicRelayUrl: \'wss://kangjunyu.dpdns.org\'',
  '',
].join('\n')

writeFileSync(patchFile, current.replace(/\s*$/, '') + '\n' + block, 'utf8')
console.log('registered in', patchFile)
