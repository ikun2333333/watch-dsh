// Rename `React.` to `react.` in the client bundle.
//
// The factory binds `let react = require("react")`, lowercase, and half the file
// had grown to use the conventional capitalised form. Written as a file because a
// PowerShell string replace is what corrupted a package.json in this project once.
import { readFileSync, writeFileSync } from 'node:fs'

const path = process.argv[2]
const before = readFileSync(path, 'utf8')
const after = before.replace(/\bReact\./gu, 'react.')

if (after === before) {
  console.log('nothing to rename')
} else {
  writeFileSync(path, after, 'utf8')
  const count = (before.match(/\bReact\./gu) ?? []).length
  console.log(`renamed ${String(count)} reference(s)`)
}
