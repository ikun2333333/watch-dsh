// Confirm the emitted stylesheet is well formed and cannot render a see-through
// sheet.
//
// The bug this guards against was not a syntax error: `background:var(--nope)`
// parses fine at build time and becomes an invalid declaration at use time, so the
// element simply has no background. String checks are the only thing that catches
// a reference to a custom property nobody defines.
import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'

const path = process.argv[2]
const text = readFileSync(path, 'utf8')

// Load the bundle's factory just far enough to read the stylesheet it builds, with
// the loader the shell provides and a React stub it never calls during load.
let captured = null
const sandbox = {
  window: {
    __ModuleLoader__: {
      load: ({ factory }) => {
        const module = { exports: {} }
        factory((name) => (name === 'react' ? { createElement: () => null, useState: () => [null, () => {}], useEffect: () => {}, useCallback: (fn) => fn, useRef: () => ({ current: null }) } : {}))
        captured = module.exports
      },
    },
  },
  document: { querySelector: () => null, createElement: () => ({ dataset: {}, style: {} }), head: { appendChild: () => {} }, addEventListener: () => {}, removeEventListener: () => {} },
  setInterval: () => 0,
  clearInterval: () => {},
  fetch: () => Promise.resolve({ ok: false }),
  console,
}
createContext(sandbox)
new Script(text).runInContext(createContext(sandbox))

// The stylesheet is appended by ensureCss into a tag, which the stub swallows, so
// it is read from the source instead - but only after the file has been parsed,
// which is what proves there is no syntax error.
const css = text.match(/const CSS = \[([\s\S]*?)\]\.join\(""\)/u)
if (css === null) {
  console.log('  FAIL could not locate the stylesheet literal')
  process.exit(1)
}

console.log('  ok   the bundle parses and its factory runs')

const source = css[0]

// Every custom property referenced must be defined in the same stylesheet, or be
// one of the shell's own that the shipping CSS is known to use.
const SHELL_KNOWN = new Set([
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-fill-l2',
  '--dsw-font-mono',
])

// `[a-z0-9-]+`, not `[a-z0-9]+`: the latter stops at the last hyphen and reports
// `--wd-accent-fg` as an undefined `--wd-accent`.
const defined = new Set([...text.matchAll(/(--wd-[a-z0-9-]+)\s*:/gu)].map((m) => m[1]))
const used = new Set([...source.matchAll(/var\((--[a-z0-9-]+)/gu)].map((m) => m[1]))

let bad = 0
for (const name of used) {
  if (defined.has(name) || SHELL_KNOWN.has(name)) continue
  console.log(`  FAIL ${name} is referenced but never defined, and is not a shell variable`)
  bad += 1
}
if (bad === 0) console.log(`  ok   all ${String(used.size)} referenced properties are defined`)

// The sheet must name an opaque background, not a variable that may not exist.
const opaque = /\.dshwd_sheet\{[^}]*background:var\(--wd-bg\)/u.test(source)
console.log(`  ${opaque ? 'ok  ' : 'FAIL'} the sheet background resolves through its own token`)
if (!opaque) bad += 1

// Three- and six-digit hex both count; `#fff` is as opaque as `#ffffff`.
const darkToken = /--wd-bg:#(?:[0-9a-f]{3}|[0-9a-f]{6})\b/iu.test(text)
console.log(`  ${darkToken ? 'ok  ' : 'FAIL'} the dark token is an opaque hex colour`)
if (!darkToken) bad += 1

const darkFollowsShell = text.includes('body[data-ds-dark-theme] .dshwd_sheet{--wd-bg:#16181d')
console.log(`  ${darkFollowsShell ? 'ok  ' : 'FAIL'} dark follows the shell's own attribute`)
if (!darkFollowsShell) bad += 1

const lightBase = /\.dshwd_sheet\{--wd-bg:#fff/iu.test(text)
console.log(`  ${lightBase ? 'ok  ' : 'FAIL'} light is the base, as the shell treats it`)
if (!lightBase) bad += 1

// A media query here would be wrong rather than merely redundant: the shell
// resolves the preference itself, so a reader whose choice differs from their
// operating system would be shown the wrong palette. Checked against the emitted
// CSS, not the file - the source explains at length why it is absent, and a
// whole-file search would match its own explanation.
const noMediaQuery = !source.includes('prefers-color-scheme')
console.log(`  ${noMediaQuery ? 'ok  ' : 'FAIL'} no prefers-color-scheme, which would disagree with the shell`)
if (!noMediaQuery) bad += 1

process.exitCode = bad === 0 ? 0 : 1
