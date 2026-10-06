// Repair the watch-dsh entry in the machine patch after a bad toggle.
//
// The toggle script inserted `disabled: true` before `name:`, where the entry
// already had one after it, so the entry ended up with two and the file stopped
// parsing. This rewrites that entry's lines from scratch instead of patching them,
// which is what should have been done the first time.
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'

const patchFile = process.argv[2]
copyFileSync(patchFile, `${patchFile}.bak-repair`)

const lines = readFileSync(patchFile, 'utf8').split('\n')
const out = []
let inTarget = false
let sawName = false
let sawDisabled = false

for (const line of lines) {
  const idMatch = line.match(/^(\s*)- id:\s*(\S+)\s*$/)
  if (idMatch) {
    // Leaving the previous block, so flush what this entry still needs.
    if (inTarget && !sawDisabled) out.push('        disabled: true')
    inTarget = idMatch[2] === 'watch-dsh'
    sawName = false
    sawDisabled = false
    out.push(line)
    continue
  }

  if (inTarget && /^\s*name:/.test(line)) {
    out.push(line)
    sawName = true
    // Exactly one disabled, right after name, where it reads naturally.
    out.push('        disabled: true')
    sawDisabled = true
    continue
  }

  if (inTarget && /^\s*disabled:/.test(line)) {
    // Any other disabled line in this block is dropped; one was already emitted.
    if (!sawDisabled) {
      out.push(line)
      sawDisabled = true
    }
    continue
  }

  out.push(line)
}

if (inTarget && sawName && !sawDisabled) out.push('        disabled: true')

writeFileSync(patchFile, out.join('\n'), 'utf8')
console.log('repaired')
