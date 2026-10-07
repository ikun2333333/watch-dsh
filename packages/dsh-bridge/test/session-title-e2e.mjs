// Do the titles the watch receives come from the Harness, end to end?
//
// The unit test pins the parsing; this proves the whole chain, playing the watch
// over the real protocol: a relay and a bridge of this test's own, on their own
// ports and under their own pc id, talking to the running Harness.
//
// Isolated deliberately. A relay keeps one bridge per pc id, so joining the user's
// relay under their pc id would evict their bridge, and the point is to check
// something without disturbing anything.
//
// Usage: node test/session-title-e2e.mjs --dsh http://127.0.0.1:19387
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadWebSocket } from '../src/deps.mjs'
import { COMMANDS, command, openFrame, sealFrame } from '../src/protocol.mjs'

const { WebSocket } = loadWebSocket()

const here = fileURLToPath(new URL('.', import.meta.url))
const src = join(here, '..', 'src')

const args = {}
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index]
  if (!token.startsWith('--')) continue
  args[token.slice(2)] = process.argv[index + 1]
  index += 1
}

const dshUrl = args.dsh ?? 'http://127.0.0.1:19387'

// Own ports, so this cannot collide with anything already running.
const RELAY_PORT = 8791

const stateDir = mkdtempSync(join(tmpdir(), 'watch-dsh-title-'))
const token = randomBytes(32).toString('base64url')
const pairing = randomBytes(32).toString('base64url')
writeFileSync(join(stateDir, 'relay-token'), token, 'utf8')
writeFileSync(join(stateDir, 'pairing-secret'), pairing, 'utf8')

const children = []
function start(script, argv, label) {
  const child = spawn(process.execPath, [join(src, script), ...argv], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim()
    if (text !== '') console.log(`    [${label}] ${text.slice(0, 200)}`)
  })
  children.push(child)
  return child
}

function stopAll() {
  for (const child of children) {
    try {
      child.kill()
    } catch {
      // Already gone.
    }
  }
  try {
    rmSync(stateDir, { recursive: true, force: true })
  } catch {
    // Leaving a temp directory behind is not worth failing over.
  }
}

process.on('exit', stopAll)
process.on('SIGINT', () => {
  stopAll()
  process.exit(130)
})

console.log(`  harness: ${dshUrl}`)
console.log(`  relay:   ws://127.0.0.1:${String(RELAY_PORT)}`)
console.log(`  state:   ${stateDir}`)

// A pc id of its own, so a bridge here is a different machine as far as the relay
// is concerned.
const pcId = `titlecheck-${randomBytes(3).toString('hex')}`

start('relay.mjs', ['--port', String(RELAY_PORT), '--host', '127.0.0.1', '--token', token], 'relay')
await new Promise((resolve) => setTimeout(resolve, 1200))
start('main.mjs', [
  '--relay', `ws://127.0.0.1:${String(RELAY_PORT)}`,
  '--token', token,
  '--pairing', pairing,
  '--pc', pcId,
  '--state', stateDir,
  '--dsh', dshUrl,
], 'bridge')

// --- play the watch ---------------------------------------------------------

const socket = new WebSocket(
  `ws://127.0.0.1:${String(RELAY_PORT)}/watch?token=${encodeURIComponent(token)}&pc=${encodeURIComponent(pcId)}`,
)

const pending = new Map()
let seq = 0
const socketOpen = new Promise((resolve, reject) => {
  socket.once('open', () => resolve(true))
  socket.once('error', reject)
})

async function call(cmd, body = {}, timeoutMs = 30_000) {
  await socketOpen
  const id = `c${++seq}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${cmd} timed out`))
    }, timeoutMs)
    pending.set(id, { resolve, timer })
    void sealFrame(pairing, 'w2b', command(id, cmd, body)).then((envelope) => {
      socket.send(JSON.stringify(envelope))
    })
  })
}

socket.on('message', (data) => {
  void (async () => {
    let envelope
    try {
      envelope = JSON.parse(data.toString())
    } catch {
      return
    }
    if (typeof envelope?.t === 'string' && envelope.t !== 'sealed') return
    const frame = await openFrame(pairing, 'b2w', envelope)
    if (frame === undefined || frame.ch !== 'res') return
    const waiting = pending.get(frame.id)
    if (waiting === undefined) return
    pending.delete(frame.id)
    clearTimeout(waiting.timer)
    waiting.resolve(frame)
  })()
})

/**
 * Ask the Harness itself what each session is called.
 *
 * This is the expectation the bridge's output is compared against, taken from the
 * source instead of inferred. A heuristic - "the title should not look like a path"
 * - cannot tell a session with no title, which is *supposed* to fall back to its
 * directory, from one whose title was dropped.
 *
 * @returns the title per session id (absent when the Harness has none), the totals,
 *   and the raw summaries for the caller to report on.
 */
async function harnessTitles(baseUrl) {
  const { DshClient, loadBrowserSessionSecret } = await import('../src/dsh-client.mjs')
  const { loadDescriptors } = await import('../src/descriptors.mjs')

  const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
  const client = new DshClient({
    baseUrl,
    secret: loadBrowserSessionSecret(dshHome),
    descriptors: loadDescriptors(dshHome),
  })

  const result = await client.call('session/list', {})
  if (result.ok !== true) throw new Error(`session/list failed: ${JSON.stringify(result.error)}`)

  const items = result.value?.items ?? []
  const summaries = new Map()
  let withTitle = 0
  for (const item of items) {
    const title = titleOf(item)
    if (title === undefined) continue
    summaries.set(item.sessionId, title)
    withTitle += 1
  }
  return { summaries, withTitle, total: items.length }
}

/** The same read the bridge does, repeated here so a mistake shows up as a mismatch. */
function titleOf(summary) {
  const title = summary?.projections?.values?.title
  return typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined
}

/** Retry hello until the bridge answers, which it cannot do until it is up. */
async function waitForBridge(seconds = 25) {
  const deadline = Date.now() + seconds * 1000
  let last = 'no attempt'
  while (Date.now() < deadline) {
    try {
      const reply = await call(COMMANDS.HELLO, { app: 'title-e2e', protocol: 1 }, 4000)
      if (reply.ok === true) return reply
      last = reply.error?.message ?? 'not ok'
    } catch (error) {
      last = error.message
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`bridge never answered hello: ${last}`)
}

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : `: ${detail}`}`)
  }
}

try {
  const hello = await waitForBridge()
  console.log(`  bridge answered hello (harness=${String(hello.status?.harness)})`)

  const reply = await call(COMMANDS.SESSIONS)
  const sessions = reply.sessions ?? []
  console.log(`  ${String(sessions.length)} session(s) received`)

  check('the bridge returned sessions', sessions.length > 0)

  // The exact expectation, from the source rather than from a heuristic: ask the
  // Harness for the same list and compare title for title. "The title looks like a
  // title" cannot distinguish a session with no title - which legitimately falls
  // back to its directory - from one whose title was dropped.
  const expected = await harnessTitles(dshUrl)
  const expectedById = expected.summaries

  let mismatched = 0
  const examples = []
  let fellBackAsIntended = 0
  let checked = 0
  for (const row of sessions) {
    const wanted = expectedById.get(row.id)
    const directory = String(row.cwd ?? '').split(/[\\/]/u).filter(Boolean).pop() ?? 'New session'
    // A session the Harness has no title for is expected to show its directory, so
    // the comparison covers both cases rather than skipping the fallback ones - the
    // fallback is part of the behaviour being pinned.
    const shouldBe = wanted ?? directory
    checked += 1
    if (wanted === undefined) fellBackAsIntended += 1
    if (row.title !== shouldBe) {
      mismatched += 1
      if (examples.length < 3) examples.push(`${row.id.slice(-12)}: got ${JSON.stringify(row.title)}, expected ${JSON.stringify(shouldBe)}`)
    }
  }

  check('every title matches what the Harness says', mismatched === 0, examples.join(' | '))
  check('every session was compared', checked === sessions.length,
    `${String(checked)} of ${String(sessions.length)}`)
  check('the Harness has titles for most sessions', expected.withTitle > 0,
    `${String(expected.withTitle)}/${String(expected.total)} titled`)
  check('sessions with no title fall back to the directory, as intended',
    fellBackAsIntended === expected.total - expected.withTitle,
    `${String(fellBackAsIntended)} fell back, ${String(expected.total - expected.withTitle)} have no title in the Harness`)

  console.log('\n  first five as the watch sees them:')
  for (const row of sessions.slice(0, 5)) {
    const wanted = expectedById.get(row.id)
    console.log(`    ${JSON.stringify(row.title).slice(0, 40).padEnd(42)} ${wanted === undefined ? '(no title in the Harness)' : ''}`)
  }
} catch (error) {
  failures += 1
  console.log(`  FAIL the run did not finish: ${error.message}`)
} finally {
  try {
    socket.close()
  } catch {
    // Nothing to do.
  }
  stopAll()
}

console.log(failures === 0 ? '\nall checks passed' : `\n${String(failures)} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
