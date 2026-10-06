// Enable or disable a plugin entry in a DSH patch file.
//
// Removes or adds `disabled: true` under a matching `- id: <name>` entry, leaving
// everything else byte-for-byte alone. Written as a file because the alternative
// on Windows is a PowerShell read-modify-write, which decodes UTF-8 as ANSI and
// has already corrupted a package.json in this project once.
//
// Usage: node set-plugin-enabled.mjs <patch-file> <id> <on|off>
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'

const [patchFile, id, mode] = process.argv.slice(2)

if (!existsSync(patchFile)) {
  console.error('no patch file at', patchFile)
  process.exit(1)
}

if (mode !== 'on' && mode !== 'off') {
  console.error('mode must be "on" or "off"')
  process.exit(1)
}

copyFileSync(patchFile, `${patchFile}.bak-set-${mode}`)

const lines = readFileSync(patchFile, 'utf8').split('\n')
const out = []
let inTarget = false
let changed = false

for (const line of lines) {
  // Any `- id:` starts a new entry, so the target block ends at the next one.
  const idMatch = line.match(/^(\s*)- id:\s*(\S+)\s*$/)
  if (idMatch) {
    inTarget = idMatch[2] === id
    out.push(line)
    continue
  }

  if (inTarget && /^\s*disabled:\s*(true|false)\s*$/.test(line)) {
    if (mode === 'off') {
      // Drop the line entirely rather than writing `disabled: false`, which is
      // the same thing to the loader but leaves a claim in the file that the
      // reader has to interpret.
      changed = true
      continue
    }
    out.push(line.replace(/disabled:\s*(true|false)/, 'disabled: true'))
    continue
  }

  if (inTarget && mode === 'off' && /^\s*name:/.test(line)) {
    out.push(line)
    changed = true
    continue
  }

  out.push(line)
}

// Inserting `disabled: true` needs the entry's own indentation, which is only
// knowable after the target block is located.
if (mode === 'on') {
  const text = out.join('\n')
  if (new RegExp(`- id:\\s*${id}\\s*\\n(\\s*)name:`).test(text)) {
    writeFileSync(patchFile, text.replace(new RegExp(`(- id:\\s*${id}\\s*\\n)`), `$1${'      '}disabled: true\n`), 'utf8')
    console.log(`${id}: disabled`)
    process.exit(0)
  }
}

writeFileSync(patchFile, out.join('\n'), 'utf8')
console.log(`${id}: ${mode === 'off' ? 'enabled (disabled removed)' : 'disabled'}${changed ? '' : ' (no change)'}`)
