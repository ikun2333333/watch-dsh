// Confirm the pairing sheet follows the structure dsh-api-dashboard's drawer uses.
//
// Written as a file: the needle list needs quotes, and PowerShell's escaping of
// them inside `node -e` has broken several commands in this project.
import { readFileSync } from 'node:fs'

const text = readFileSync(process.argv[2], 'utf8')

const checks = [
  ['detached with position:fixed', 'dshwd_sheet{position:fixed'],
  ['above the shell overlays (99999)', 'z-index:99999'],
  ['a scrim behind it', 'dshwd_scrim{position:fixed'],
  ['scrim below the sheet (99998)', 'z-index:99998'],
  ['rounded top corners', 'border-radius:18px 18px 0 0'],
  ['rises into view', '@keyframes dshwd-rise'],
  ['scrim fades in', '@keyframes dshwd-fade'],
  ['scrim gives way to the sidebar gesture', 'overflow-x:auto'],
  ['centred on a wide screen', '@media (min-width:561px)'],
  ['announced as a dialog', 'role: "dialog"'],
  ['closed with Escape', 'Escape'],
  ['the bar itself has no Pair button', 'Pair a watch over adb'],
]

let bad = 0
for (const [name, needle] of checks) {
  const found = text.includes(needle)
  if (!found) bad += 1
  console.log(`  ${found ? 'ok  ' : 'MISS'} ${name}`)
}

// The bar must not carry a pairing control of its own: the entry point is the
// status text, which is what the user asked for.
const barOpens = text.includes('className: "dshwd_open"')
console.log(`  ${barOpens ? 'ok  ' : 'MISS'} the status text opens the sheet`)

process.exitCode = bad === 0 && barOpens ? 0 : 1
