// The relay's transport notices, which are what let a watch follow the PC's state.
//
// The bug this pins: `watch-online` is sent *to the PC*, telling it which watches
// are waiting. A watch was never told anything when the PC arrived, so a watch that
// had been told the PC left had no way to learn it came back - it sat on "PC not
// running" with a working link one handshake away. The frame added for that is
// `pc-online`, and the direction is the whole point, which is why the name is
// distinct rather than reused.
//
// RelayCore is pure, so this needs no sockets.
import { strict as assert } from 'node:assert'

import { PC_ROLE, WATCH_ROLE, RelayCore } from '../src/relay-core.mjs'

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

/** A peer stand-in that records nothing; only identity matters to the core. */
const peer = (name) => ({ name })

const parse = (notice) => JSON.parse(notice.text)

console.log('a watch joining an empty relay')

check('is told nothing, and knows the PC is absent', () => {
  const core = new RelayCore()
  const { pcOnline, notices, watchId } = core.join(peer('w1'), WATCH_ROLE, 'pc-a')
  assert.equal(pcOnline, false)
  assert.deepEqual(notices, [])
  assert.equal(typeof watchId, 'string')
})

console.log('a PC joining while a watch waits')

check('the PC learns about the waiting watch', () => {
  const core = new RelayCore()
  const watch = peer('w1')
  core.join(watch, WATCH_ROLE, 'pc-a', 'watch-1')

  const pc = peer('p1')
  const { notices } = core.join(pc, PC_ROLE, 'pc-a')
  const toPc = notices.filter((notice) => notice.peer === pc).map(parse)

  assert.deepEqual(toPc, [{ t: 'watch-online', from: 'watch-1' }])
})

check('the waiting watch is told the PC is back - the half that was missing', () => {
  const core = new RelayCore()
  const watch = peer('w1')
  core.join(watch, WATCH_ROLE, 'pc-a', 'watch-1')
  core.join(peer('p1'), PC_ROLE, 'pc-a')

  // Rebuilt rather than reused: the watch has to be reachable by the peer object
  // the core stored, which is the one passed to its own join.
  const core2 = new RelayCore()
  const waiting = peer('w1')
  core2.join(waiting, WATCH_ROLE, 'pc-a', 'watch-1')
  const { notices } = core2.join(peer('p1'), PC_ROLE, 'pc-a')

  const toWatch = notices.filter((notice) => notice.peer === waiting).map(parse)
  assert.deepEqual(toWatch, [{ t: 'pc-online' }])
})

check('the two notices carry different frame names', () => {
  // One name for two directions is what made the first handler dead code: it
  // waited for a frame the relay only ever sends to the PC.
  const core = new RelayCore()
  const waiting = peer('w1')
  core.join(waiting, WATCH_ROLE, 'pc-a', 'watch-1')
  const pc = peer('p1')
  const { notices } = core.join(pc, PC_ROLE, 'pc-a')

  const names = notices.map((notice) => parse(notice).t).sort()
  assert.deepEqual(names, ['pc-online', 'watch-online'])
})

console.log('a watch joining while the PC is present')

check('the PC is told about it and the watch is told the PC is online', () => {
  const core = new RelayCore()
  const pc = peer('p1')
  core.join(pc, PC_ROLE, 'pc-a')

  const watch = peer('w1')
  const { pcOnline, notices, watchId } = core.join(watch, WATCH_ROLE, 'pc-a')

  assert.equal(pcOnline, true)
  const toPc = notices.filter((notice) => notice.peer === pc).map(parse)
  assert.deepEqual(toPc, [{ t: 'watch-online', from: watchId }])
})

console.log('the PC going away')

check('every attached watch is told', () => {
  const core = new RelayCore()
  const one = peer('w1')
  const two = peer('w2')
  core.join(one, WATCH_ROLE, 'pc-a', 'watch-1')
  core.join(two, WATCH_ROLE, 'pc-a', 'watch-2')
  const pc = peer('p1')
  core.join(pc, PC_ROLE, 'pc-a')

  const notices = core.leave(pc, PC_ROLE, 'pc-a')
  const told = notices.map((notice) => [notice.peer.name, parse(notice).t])
  assert.deepEqual(told.sort(), [['w1', 'peer-offline'], ['w2', 'peer-offline']])
})

check('the pair is complete: a watch can follow both transitions', () => {
  // The property that matters: for each direction of change there is a frame the
  // watch actually receives.
  const core = new RelayCore()
  const watch = peer('w1')
  core.join(watch, WATCH_ROLE, 'pc-a', 'watch-1')

  const pc = peer('p1')
  const arrived = core.join(pc, PC_ROLE, 'pc-a').notices
    .filter((notice) => notice.peer === watch).map((notice) => parse(notice).t)
  assert.deepEqual(arrived, ['pc-online'], 'the watch is not told when the PC arrives')

  const left = core.leave(pc, PC_ROLE, 'pc-a')
    .filter((notice) => notice.peer === watch).map((notice) => parse(notice).t)
  assert.deepEqual(left, ['peer-offline'], 'the watch is not told when the PC leaves')
})

// Reported through the exit code so a failing assertion cannot look like a pass.
if (failures > 0) {
  console.log(`\n${String(failures)} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
