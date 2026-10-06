// Build the DSH_HOME used to test the plugin without touching the real one.
//
// The profile it writes mirrors the real machine patch, with the watch-dsh entry
// enabled. Testing a different composition from the one that ships is how the
// desktop crash was missed the first time.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const [testHome, realHome, repo] = process.argv.slice(2)

const profileDir = join(testHome, 'profiles', 'web')
mkdirSync(profileDir, { recursive: true })

writeFileSync(
  join(profileDir, 'package.json'),
  `${JSON.stringify(
    {
      name: 'dsh-profile-web',
      private: true,
      dependencies: {},
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
          patchReload: 'live',
        },
      },
    },
    null,
    2,
  )}\n`,
  'utf8',
)

writeFileSync(join(profileDir, 'cordis.yml'), '# bundle layer; empty by design\n[]\n', 'utf8')

// The real machine patch, with the disabled flag removed from watch-dsh so the
// test exercises the plugin rather than its absence.
let patch = ''
const realPatch = join(realHome, 'cordis.patch.yml')
if (existsSync(realPatch)) {
  patch = readFileSync(realPatch, 'utf8')
  patch = patch.replace(/(\n\s*disabled:\s*true)(\s*\n\s*config:\s*\n\s*repo:\s*'[^']*watch-dsh')/, '$2')
  // Any leftover disabled line inside the watch-dsh block would hide the plugin.
  const lines = patch.split('\n')
  const out = []
  let inBlock = false
  for (const line of lines) {
    const idMatch = line.match(/^\s*- id:\s*(\S+)\s*$/)
    if (idMatch) inBlock = idMatch[1] === 'watch-dsh'
    if (inBlock && /^\s*disabled:\s*true\s*$/.test(line)) continue
    out.push(line)
  }
  patch = out.join('\n')
}

if (!patch.includes('id: watch-dsh')) {
  patch += `\n- insert:\n    - id: watch-dsh\n      name: dsh-watch-dsh\n      config:\n        repo: '${repo.replace(/\\/g, '\\\\')}'\n        relayPort: 8787\n`
}

// The test instance must not fight the real one over the ports the plugin opens.
patch = patch.replace(/relayPort:\s*\d+/, 'relayPort: 8788')

writeFileSync(join(profileDir, 'cordis.patch.yml'), patch, 'utf8')

console.log('test profile written')
console.log('watch-dsh disabled present:', /id: watch-dsh[\s\S]{0,200}?disabled:\s*true/.test(patch))
console.log('relayPort:', (patch.match(/relayPort:\s*\d+/) ?? ['(none)'])[0])
