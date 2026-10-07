// Ask the Harness what a session summary actually contains.
//
// The bridge titles a session with `track.title ?? titleFromCwd(cwd)`, and the
// watch shows the workspace instead of a title for anything historical - which is
// what this is here to settle: whether the list carries a title the bridge is not
// reading, or whether the title genuinely only exists on the live event.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { DshClient, loadBrowserSessionSecret } from '../packages/dsh-bridge/src/dsh-client.mjs'
import { loadDescriptors } from '../packages/dsh-bridge/src/descriptors.mjs'

const root = process.argv[2]
const dshHome = process.argv[3]
const baseUrl = process.argv[4]

const client = new DshClient({
  baseUrl,
  secret: loadBrowserSessionSecret(dshHome),
  descriptors: loadDescriptors(dshHome),
})

const result = await client.call('session/list', {})
if (result.ok !== true) {
  console.log('  session/list failed:', JSON.stringify(result.error))
  process.exit(1)
}

const items = result.value?.items ?? []
console.log(`  ${String(items.length)} session(s)`)

if (items.length > 0) {
  const keys = new Set()
  for (const item of items) for (const key of Object.keys(item)) keys.add(key)
  console.log(`  summary keys: ${[...keys].sort().join(', ')}`)

  console.log('\n  first three, verbatim:')
  for (const item of items.slice(0, 3)) {
    console.log(`    ${JSON.stringify(item).slice(0, 400)}`)
  }

  // The question, answered directly. The title is not a top-level field: it lives
  // inside the sequenced projection, which is why reading the summary alone finds
  // nothing and falls back to the working directory.
  const withTitle = items.filter((item) => typeof item?.projections?.values?.title === 'string' && item.projections.values.title !== '')
  console.log(`\n  projections.values.title present: ${String(withTitle.length)}/${String(items.length)}`)

  const shapes = new Set(items.map((item) => item?.projections?.kind ?? '(none)'))
  console.log(`  projection kinds: ${[...shapes].join(', ')}`)

  // The two kinds may nest the values differently, which would matter to anything
  // reading them.
  console.log('\n  per kind:')
  for (const kind of shapes) {
    const ofKind = items.filter((item) => (item?.projections?.kind ?? '(none)') === kind)
    const withValues = ofKind.filter((item) => item?.projections?.values !== undefined)
    const withTitle = ofKind.filter((item) => typeof item?.projections?.values?.title === 'string' && item.projections.values.title !== '')
    console.log(`    ${kind}: ${String(ofKind.length)} session(s), values on ${String(withValues.length)}, title on ${String(withTitle.length)}`)
    const sample = ofKind.find((item) => item?.projections?.values?.title)
    if (sample) console.log(`      values keys: ${Object.keys(sample.projections.values).join(', ')}`)
  }

  console.log('\n  titles:')
  for (const item of items.slice(0, 8)) {
    const title = item?.projections?.values?.title
    console.log(`    ${typeof title === 'string' && title !== '' ? JSON.stringify(title) : '(none)'}  cwd=${String(item.cwd).slice(-30)}`)
  }
}
