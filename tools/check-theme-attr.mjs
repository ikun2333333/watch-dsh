// Does the shell actually set the theme attribute a plugin can follow?
//
// Reading the mechanism out of a doc comment is not the same as confirming the
// code path runs. This looks for the write, not the mention.
import { readFileSync } from 'node:fs'

const path = process.argv[2]
const text = readFileSync(path, 'utf8')

const ATTR = 'data-ds-dark-theme'

console.log(`  mentions of ${ATTR}: ${String(text.split(ATTR).length - 1)}`)

// The shapes that would mean "this is actually applied to the body".
const writes = [
  ['setAttribute on body-ish target', new RegExp(`setAttribute\\(\\s*["'\`]${ATTR}`, 'gu')],
  ['dataset assignment', new RegExp(`dataset\\.[A-Za-z]*[Dd]ark[A-Za-z]*\\s*=`, 'gu')],
  ['toggleAttribute', new RegExp(`toggleAttribute\\(\\s*["'\`]${ATTR}`, 'gu')],
  ['removeAttribute', new RegExp(`removeAttribute\\(\\s*["'\`]${ATTR}`, 'gu')],
]

for (const [label, pattern] of writes) {
  const found = text.match(pattern) ?? []
  console.log(`  ${found.length > 0 ? 'ok  ' : '--- '} ${label}: ${String(found.length)}`)
}

// Show the surrounding code for each mention, so the mechanism is visible rather
// than counted.
let index = 0
let shown = 0
while ((index = text.indexOf(ATTR, index)) >= 0 && shown < 6) {
  const context = text.slice(Math.max(0, index - 200), index + 200).replace(/\s+/gu, ' ')
  // Skip TypeScript and comment mentions; they are what misled the first attempt.
  const codeish = /setAttribute|dataset|toggleAttribute|removeAttribute|\[data-ds-dark-theme\]/u.test(context)
  shown += 1
  console.log(`\n  --- mention ${String(shown)}${codeish ? '' : ' (prose)'} ---`)
  console.log(`      ${context}`)
  index += ATTR.length
}
