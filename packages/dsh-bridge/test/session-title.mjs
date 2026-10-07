// A session title must come from where the Harness actually puts it.
//
// The bug this pins: the title is not a field of a `session/list` summary, it is
// inside the sequenced projection, so reading the summary alone found nothing and
// every session fell back to its working directory. That failure is silent - the
// fallback is a plausible-looking string - so it needs a test rather than care.
//
// The fixtures below are trimmed copies of real responses, one of each projection
// kind, kept verbatim where they matter rather than paraphrased.
import { strict as assert } from 'node:assert'

import { titleFromSummary, resolveTitle } from '../src/bridge.mjs'

let failures = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${name}: ${error.message}`)
  }
}

/** A live session, as `session/list` returned it. */
const sequenced = {
  sessionId: 'session-b8c70e6d-80bc-48a6-bf11-e47ae7eb1df7',
  updatedAt: 1791340995633,
  agentAvailable: true,
  running: true,
  blank: false,
  cwd: 'C:\\Users\\q1375\\Documents\\watch-dsh',
  projections: {
    kind: 'sequenced',
    asOfSeq: 14790,
    values: {
      title: '三星手表远程控制电脑DeepSeek',
      goal: null,
      tokenUsage: { uncachedInputTokens: 233, outputTokens: 180 },
    },
  },
}

/** A session read back from disk, which nests the values identically. */
const cached = {
  sessionId: 'session-4171bde9-2146-439f-8e70-887f1bf48a01',
  updatedAt: 1791289884291,
  agentAvailable: true,
  running: false,
  blank: false,
  cwd: 'C:\\Users\\q1375\\.dsh\\profiles\\desktop',
  projections: {
    kind: 'cached',
    values: {
      title: '你好',
      tokenUsage: { uncachedInputTokens: 233, outputTokens: 107 },
    },
  },
}

/** A session with no title at all, which is the case the fallback is for. */
const untitled = {
  sessionId: 'session-00000000-0000-0000-0000-000000000000',
  updatedAt: 1791289884291,
  running: false,
  blank: true,
  cwd: 'C:\\Users\\q1375\\.dsh\\profiles\\desktop',
  projections: { kind: 'cached', values: { goal: null } },
}

console.log('titleFromSummary')

check('reads the title out of a sequenced projection', () => {
  assert.equal(titleFromSummary(sequenced), '三星手表远程控制电脑DeepSeek')
})

check('reads the title out of a cached projection', () => {
  assert.equal(titleFromSummary(cached), '你好')
})

check('a summary with no title yields undefined rather than a stand-in', () => {
  assert.equal(titleFromSummary(untitled), undefined)
})

check('a summary with no projections at all is not an error', () => {
  assert.equal(titleFromSummary({ sessionId: 'x', cwd: '/tmp' }), undefined)
  assert.equal(titleFromSummary(undefined), undefined)
})

check('a blank or whitespace title is treated as absent', () => {
  assert.equal(titleFromSummary({ projections: { values: { title: '' } } }), undefined)
  assert.equal(titleFromSummary({ projections: { values: { title: '   ' } } }), undefined)
})

check('a non-string title is not used', () => {
  assert.equal(titleFromSummary({ projections: { values: { title: 42 } } }), undefined)
  assert.equal(titleFromSummary({ projections: { values: { title: null } } }), undefined)
})

console.log('resolveTitle')

check('the summary title beats the working directory', () => {
  // This is the bug, stated as an assertion: the cwd would have produced
  // "watch-dsh", and the title is what the user expects to see.
  assert.equal(resolveTitle({ summary: sequenced }), '三星手表远程控制电脑DeepSeek')
  assert.notEqual(resolveTitle({ summary: sequenced }), 'watch-dsh')
})

check('a live session/title event wins over the summary, being fresher', () => {
  assert.equal(resolveTitle({ summary: sequenced, title: 'renamed since' }), 'renamed since')
})

check('falls back to the working directory only when there is no title', () => {
  assert.equal(resolveTitle({ summary: untitled }), 'desktop')
})

check('falls back to the directory name, not the whole path', () => {
  assert.equal(resolveTitle({ summary: { cwd: 'C:\\Users\\q1375\\Documents\\watch-dsh' } }), 'watch-dsh')
})

check('a session with neither title nor cwd still has a name', () => {
  assert.equal(resolveTitle({ summary: {} }), 'New session')
  assert.equal(resolveTitle({}), 'New session')
})

// Reported through the exit code so a failing assertion cannot look like a pass.
if (failures > 0) {
  console.log(`\n${String(failures)} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
