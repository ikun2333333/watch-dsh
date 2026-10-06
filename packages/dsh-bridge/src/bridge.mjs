/**
 * bridge: the PC side. It is the only component that talks to the Harness.
 *
 * Responsibilities
 * ----------------
 * 1. Own the loopback browser-session cookie and speak the Harness Remote
 *    protocol (`POST /api/<endpoint>`, `WS /api/remote.mux`).
 * 2. Follow every live session and reduce the Harness's verbose event journal
 *    into watch-sized, delta-oriented frames.
 * 3. Serve watches over a relay link, sealed end-to-end so the relay only sees
 *    ciphertext.
 * 4. Present approval requests to the watch and return the decision to the
 *    Harness waterfall, so a tool that needs permission can proceed while the
 *    user is away from the desk.
 *
 * The bridge is intentionally stateless about history: the Harness owns the
 * durable session log, and the bridge keeps only a bounded in-memory window of
 * live sessions plus the followed transcript.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DshClient, loadBrowserSessionSecret } from './dsh-client.mjs';
import { loadDescriptors } from './descriptors.mjs';
import { loadWebSocket } from './deps.mjs';
import {
  COMMANDS,
  ERROR_CODES,
  EVENTS,
  PROTOCOL_VERSION,
  event,
  failure,
  openFrame,
  response,
  sealFrame,
} from './protocol.mjs';

const { WebSocket } = loadWebSocket();

/** How many transcript entries the bridge keeps per followed session. */
const TRANSCRIPT_WINDOW = 240;
/** Event types too large or too internal to forward to a watch. */
const JUNK_EVENT_TYPES = new Set([
  'request/context',
  'request/header',
  'system/message',
  'session/title-llm-request',
  'session/end-seed',
]);
/** Never forward a single frame larger than this; watches have little memory. */
const MAX_FRAME_BYTES = 24_000;

/**
 * One connected watch, or the placeholder that queues events until a watch
 * attaches. Sealing is per-connection because the direction key is per peer.
 */
class WatchLink {
  #secret;
  #socket;
  #watchId;
  sessionId;

  /**
   * @param secret - pairing secret used to seal frames to this watch.
   * @param socket - the relay link the reply travels over.
   * @param watchId - relay-assigned identity, echoed so the relay can route back.
   */
  constructor(secret, socket, watchId) {
    this.#secret = secret;
    this.#socket = socket;
    this.#watchId = watchId;
  }

  get id() {
    return this.#watchId;
  }

  /** Whether the underlying socket can still carry frames. */
  get alive() {
    return this.#socket.readyState === WebSocket.OPEN;
  }

  /**
   * Handle one already-decoded watch frame.
   *
   * Every frame that reaches here is sealed with the pairing secret, so the
   * sender has already proven it holds the key. A frame in the clear is not a
   * request to be answered: the secret arrives in the watch's imported config, so
   * nothing legitimate travels unsealed.
   *
   * @param frame - the decoded frame.
   */
  async deliver(frame) {
    if (frame.ch === 'cmd' && typeof frame.id === 'string') {
      await this.onCommand?.(frame);
    }
  }

  /**
   * Send a raw (unsealed) transport frame; used by diagnostics only.
   * @param frame - frame to send.
   */
  sendRaw(frame) {
    if (this.alive) this.#socket.send(JSON.stringify(frame));
  }

  /**
   * Seal and send one bridge → watch frame, addressed back to this watch.
   * @param frame - frame to seal.
   */
  async send(frame) {
    if (!this.alive) return;
    const envelope = await sealFrame(this.#secret, 'b2w', frame);
    this.#socket.send(JSON.stringify({ ...envelope, from: this.#watchId }));
  }

  /** Convenience: send a failure response for a command. */
  async fail(id, code, message) {
    await this.send(failure(id, code, message));
  }

  /** Convenience: send a success response for a command. */
  async ok(id, body) {
    await this.send(response(id, body));
  }
}

/**
 * Tracks one Harness session: its summary, whether we follow it, and the
 * bounded transcript we have reduced so far.
 */
class SessionTrack {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.summary = undefined;
    this.running = false;
    this.title = undefined;
    this.transcript = [];
    this.cursor = 0;
    this.followController = undefined;
  }

  /** Append one reduced transcript entry, evicting the oldest beyond the window. */
  push(entry) {
    this.transcript.push(entry);
    if (this.transcript.length > TRANSCRIPT_WINDOW) this.transcript.splice(0, this.transcript.length - TRANSCRIPT_WINDOW);
  }
}

export class Bridge {
  #client;
  #descriptors;
  #sessions = new Map();
  #watches = new Set();
  #secret;
  #pcId;
  #socket;
  #eventsController;
  #pendingApprovals = new Map();
  #eventsClientId;
  #status = { harness: 'connecting', relay: 'disconnected', detail: '' };
  #closed = false;
  /** Where to publish live status, or null to publish nothing. */
  #stateDir;

  /**
   * @param options - Harness base URL, the pairing secret shared with watches, the pc id this bridge answers to, and optionally the directory to publish live status into.
   */
  constructor({ dshHome, baseUrl, pairingSecret, pcId, descriptors, stateDir }) {
    this.#descriptors = descriptors ?? loadDescriptors(dshHome);
    this.#secret = pairingSecret;
    this.#pcId = pcId;
    this.#stateDir = stateDir ?? null;
    this.#client = new DshClient({
      baseUrl,
      secret: loadBrowserSessionSecret(dshHome),
      descriptors: this.#descriptors,
    });
  }

  /** Current bridge status for diagnostics and the watch's status line. */
  get status() {
    return { ...this.#status, sessions: this.#sessions.size, watches: this.#watches.size };
  }

  /**
   * Publish the live status where the PC end can read it.
   *
   * The relay and bridge logs were the only record of whether a watch was attached,
   * and a log is append-only: "watch x attached" stays in the ring buffer after the
   * watch is gone, so anything reading it reports a connection that no longer
   * exists. This is the same numbers the watch is sent, written out at the moment
   * they change, so a status light has a live answer instead of a historical one.
   *
   * Failures are ignored on purpose: a status file is a convenience, and a bridge
   * that refused to run because it could not write one would be worse than a status
   * light that says "unknown".
   */
  #publishStatus() {
    if (this.#stateDir === null) return;
    try {
      mkdirSync(this.#stateDir, { recursive: true });
      const body = JSON.stringify({
        ...this.status,
        pcId: this.#pcId,
        at: Date.now(),
      });
      // Written via a temporary file and renamed, so a reader never sees a partial
      // document - the poller runs every couple of seconds and would otherwise
      // eventually read a half-written one.
      const target = join(this.#stateDir, 'watch-status.json');
      const temporary = `${target}.tmp`;
      writeFileSync(temporary, body, 'utf8');
      renameSync(temporary, target);
    } catch {
      // See above: not worth failing over.
    }
  }

  /** Set the status and tell every watch. */
  async #setStatus(patch) {
    this.#status = { ...this.#status, ...patch };
    this.#publishStatus();
    await this.broadcast(event(EVENTS.STATUS, { status: this.status }));
  }

  /** Send one frame to every attached watch. */
  async broadcast(frame) {
    const payload = JSON.stringify(frame);
    if (Buffer.byteLength(payload, 'utf8') > MAX_FRAME_BYTES) return;
    await Promise.all([...this.#watches].map((watch) => watch.send(frame)));
  }

  /** Start following the Harness event journal and the session list. */
  async start() {
    await this.refreshSessions();
    void this.#pumpEvents();
    await this.#setStatus({ harness: 'ready' });
  }

  /** Ask the Harness for the current session list. */
  async refreshSessions() {
    const result = await this.#client.call('session/list', {});
    if (result.ok !== true) {
      await this.#setStatus({ harness: 'error', detail: result.error?.message ?? 'session/list failed' });
      return;
    }
    const seen = new Set();
    for (const summary of result.value.items) {
      seen.add(summary.sessionId);
      const track = this.#sessions.get(summary.sessionId) ?? new SessionTrack(summary.sessionId);
      track.summary = summary;
      track.running = summary.running === true;
      this.#sessions.set(summary.sessionId, track);
    }
    for (const sessionId of [...this.#sessions.keys()]) {
      if (!seen.has(sessionId)) this.#sessions.delete(sessionId);
    }
    await this.#broadcastSessions();
  }

  /** The watch-facing session list, newest first. */
  #sessionList() {
    return [...this.#sessions.values()]
      .filter((track) => track.summary !== undefined)
      .map((track) => ({
        id: track.sessionId,
        title: track.title ?? titleFromCwd(track.summary.cwd),
        running: track.running,
        blank: track.summary.blank === true,
        updatedAt: track.summary.updatedAt,
        cwd: track.summary.cwd,
        approvals: [...this.#pendingApprovals.values()].filter((entry) => entry.sessionId === track.sessionId).length,
      }))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async #broadcastSessions() {
    await this.broadcast(event(EVENTS.SESSIONS, { sessions: this.#sessionList() }));
  }

  async #broadcastSession(track) {
    // A subagent session is noise on a watch; the parent already shows the work.
    if (track.summary?.origin === 'subagent') return;
    await this.broadcast(event(EVENTS.SESSION, {
      session: {
        id: track.sessionId,
        title: track.title ?? titleFromCwd(track.summary?.cwd),
        running: track.running,
        updatedAt: track.summary?.updatedAt ?? Date.now(),
      },
    }));
  }

  /**
   * Consume the Harness's forwarded Host events (`$events`).
   *
   * This one stream carries both notifications (session list and status
   * changes) and the approval waterfall, which is why approvals work without a
   * second connection.
   */
  async #pumpEvents() {
    this.#eventsController = new AbortController();
    for (;;) {
      if (this.#closed) return;
      try {
        for await (const frame of this.#client.stream('$events', {}, { signal: this.#eventsController.signal })) {
          if (frame?.type === 'ready') {
            // The ready frame's clientId is required on every waterfall answer, so
            // capture it here rather than per approval.
            this.#eventsClientId = String(frame.clientId);
            await this.#setStatus({ harness: 'ready', detail: '' });
            continue;
          }
          if (frame?.type === 'emit') await this.#onEmit(frame);
          else if (frame?.type === 'waterfall') await this.#onWaterfall(frame);
          else if (frame?.type === 'cancel') await this.#onWaterfallCancel(frame);
        }
        // A clean end still means the generation is gone; fall through to retry.
        throw new Error('event stream ended');
      } catch (error) {
        if (this.#closed) return;
        await this.#setStatus({ harness: 'reconnecting', detail: error.message });
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  /** Handle one forwarded notification. */
  async #onEmit(frame) {
    const [first, second] = frame.args ?? [];
    switch (frame.event) {
      case 'api-session/added':
      case 'api-session/removed':
        await this.refreshSessions();
        return;
      case 'api-session/status': {
        const track = this.#sessions.get(String(first));
        if (track === undefined) { await this.refreshSessions(); return; }
        track.running = second === true;
        await this.#broadcastSession(track);
        return;
      }
      case 'api-session/activity': {
        const track = this.#sessions.get(String(first));
        if (track === undefined) { await this.refreshSessions(); return; }
        if (track.summary !== undefined) track.summary.updatedAt = Number(second);
        await this.#broadcastSession(track);
        return;
      }
      case 'api-session/error':
        await this.broadcast(event(EVENTS.NOTICE, { level: 'error', message: String(second).slice(0, 300) }));
        return;
      default:
        // Every unhandled event is intentional: the watch wants a reduced view,
        // not a mirror of the Host's internal event bus.
        return;
    }
  }

  /** Handle one approval waterfall from the Harness. */
  async #onWaterfall(frame) {
    const request = frame.request ?? {};
    const approvalId = String(frame.eventId);
    const sessionId = sessionIdOfFrame(frame);
    const entry = {
      approvalId,
      sessionId,
      agentId: frame.agentId,
      toolName: String(request.toolName ?? 'unknown'),
      callId: request.callId === undefined ? undefined : String(request.callId),
      reason: request.reason === undefined ? undefined : String(request.reason).slice(0, 300),
    };
    this.#pendingApprovals.set(approvalId, entry);
    await this.broadcast(event(EVENTS.APPROVAL, { approval: entry }));
    await this.#broadcastSessions();
  }

  /** Withdraw an approval the Harness no longer waits for. */
  async #onWaterfallCancel(frame) {
    const approvalId = String(frame.eventId);
    if (!this.#pendingApprovals.delete(approvalId)) return;
    await this.broadcast(event(EVENTS.APPROVAL_CLOSED, { approvalId, reason: 'cancelled' }));
    await this.#broadcastSessions();
  }

  /**
   * Return one decision to the Harness, dismissing it on every watch.
   * @param approvalId - the waterfall event id.
   * @param outcome - `allowed-once` or `rejected`.
   * @returns true when a pending approval was claimed.
   */
  async decide(approvalId, outcome) {
    const entry = this.#pendingApprovals.get(approvalId);
    if (entry === undefined) return false;
    this.#pendingApprovals.delete(approvalId);
    const result = await this.#client.call('$events/result', {
      _result: {
        clientId: this.#eventsClientId,
        eventId: approvalId,
        outcome: { kind: 'result', value: outcome },
      },
    });
    await this.broadcast(event(EVENTS.APPROVAL_CLOSED, { approvalId, outcome }));
    await this.#broadcastSessions();
    return result.ok === true;
  }

  /**
   * Attach one watch that the relay announced, and push it the current state.
   * @param socket - the relay link the reply travels over.
   * @param watchId - relay-assigned identity for the watch.
   * @returns the created link.
   */
  attachWatch(socket, watchId) {
    const watch = new WatchLink(this.#secret, socket, watchId);
    watch.onCommand = (frame) => this.#onCommand(watch, frame);
    this.#watches.add(watch);
    // Republished before the async sends below, because the attach is the change
    // the status file is for.
    this.#publishStatus();
    void (async () => {
      await watch.send(event(EVENTS.STATUS, { status: this.status }));
      await watch.send(event(EVENTS.SESSIONS, { sessions: this.#sessionList() }));
      for (const approval of this.#pendingApprovals.values()) {
        await watch.send(event(EVENTS.APPROVAL, { approval }));
      }
    })();
    return watch;
  }

  /**
   * Detach a watch the relay reported as gone.
   * @param watchId - relay-assigned identity for the watch.
   */
  detachWatch(watchId) {
    let removed = false;
    for (const watch of this.#watches) {
      if (watch.id === watchId) {
        this.#watches.delete(watch);
        removed = true;
      }
    }
    // This is the case the log could not express: the watch is gone, so the status
    // file must stop saying it is here.
    if (removed) this.#publishStatus();
  }

  /** Resolve one watch command. */
  async #onCommand(watch, frame) {
    const id = frame.id;
    try {
      switch (frame.cmd) {
        case COMMANDS.HELLO:
          // Sealed from here on: the watch holds the pairing secret from its
          // imported config, so anything that reaches this point has proven it
          // holds that secret and is genuinely this user's watch.
          await watch.ok(id, {
            protocol: PROTOCOL_VERSION,
            bridge: 'watch-dsh/1',
            status: this.status,
          });
          return;
        case COMMANDS.SESSIONS:
          await watch.ok(id, { sessions: this.#sessionList() });
          return;
        case COMMANDS.SESSION_OPEN:
          await this.#openSession(watch, id, frame);
          return;
        case COMMANDS.TRANSCRIPT:
          await this.#sendTranscript(watch, id, frame);
          return;
        case COMMANDS.SEND:
          await this.#send(watch, id, frame);
          return;
        case COMMANDS.CANCEL:
          await this.#cancel(watch, id, frame);
          return;
        case COMMANDS.APPROVE:
          await this.#approve(watch, id, frame);
          return;
        case COMMANDS.SUBSCRIBE:
          await this.#subscribe(watch, id, frame);
          return;
        default:
          await watch.fail(id, ERROR_CODES.UNSUPPORTED, `unknown command ${String(frame.cmd)}`);
      }
    } catch (error) {
      await watch.fail(id, ERROR_CODES.INTERNAL, error instanceof Error ? error.message : String(error));
    }
  }

  /** Open an existing session, or create one when no id is given. */
  async #openSession(watch, id, frame) {
    let sessionId = frame.sessionId === undefined ? undefined : String(frame.sessionId);
    if (sessionId === undefined) {
      const created = await this.#client.call('session/create', { cwd: frame.cwd });
      if (created.ok !== true) {
        await watch.fail(id, ERROR_CODES.HARNESS, created.error?.message ?? 'session/create failed');
        return;
      }
      sessionId = created.value.sessionId;
      await this.refreshSessions();
    }
    const track = this.#sessions.get(sessionId) ?? new SessionTrack(sessionId);
    this.#sessions.set(sessionId, track);
    watch.sessionId = sessionId;
    await watch.ok(id, { sessionId, title: track.title ?? titleFromCwd(track.summary?.cwd) });
    await this.#follow(track);
    await this.#sendTranscript(watch, undefined, { sessionId });
  }

  /** Start (or restart) the follow stream for one session. */
  async #follow(track) {
    if (track.followController !== undefined) return;
    track.followController = new AbortController();
    void (async () => {
      const signal = track.followController.signal;
      let attempt = 0;
      for (;;) {
        if (this.#closed) return;
        try {
          for await (const frame of this.#client.stream('session/follow', {
            address: { kind: 'session', sessionId: track.sessionId },
            maxMessages: 30,
            assistantStream: true,
          }, { signal })) {
            await this.#onFollowFrame(track, frame);
          }
          throw new Error('follow stream ended');
        } catch (error) {
          if (this.#closed || signal.aborted) return;
          attempt += 1;
          await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * attempt, 8000)));
        }
      }
    })();
  }

  /** Reduce one follow frame into watch events. */
  async #onFollowFrame(track, frame) {
    if (frame?.type === 'assistant-stream') {
      const inner = frame.frame;
      if (inner?.type === 'chunk') {
        const chunk = inner.chunk;
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
          await this.broadcast(event(EVENTS.DELTA, { sessionId: track.sessionId, text: chunk.text }));
        } else if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') {
          // Reasoning is summarized, never streamed: it is long and rarely what
          // someone reads on a watch face.
          await this.broadcast(event(EVENTS.DELTA, { sessionId: track.sessionId, reasoning: true }));
        }
      }
      return;
    }
    if (frame?.type !== 'event') return;
    const wire = frame.event ?? {};
    track.cursor = Math.max(track.cursor, Number(wire.seq ?? 0));
    if (JUNK_EVENT_TYPES.has(String(wire.type))) return;

    switch (wire.type) {
      case 'user/message': {
        const text = textOfMessage(wire.data);
        if (text !== '') track.push({ kind: 'user', seq: wire.seq, text });
        await this.broadcast(event(EVENTS.TRANSCRIPT, {
          sessionId: track.sessionId,
          entries: [{ kind: 'user', seq: wire.seq, text }],
        }));
        return;
      }
      case 'assistant/message': {
        const text = textOfMessage(wire.data?.message);
        const usage = wire.data?.usage;
        track.push({ kind: 'assistant', seq: wire.seq, text, usage });
        await this.broadcast(event(EVENTS.TRANSCRIPT, {
          sessionId: track.sessionId,
          entries: [{ kind: 'assistant', seq: wire.seq, text, usage: usageSummary(usage) }],
        }));
        return;
      }
      case 'session/title': {
        const title = wire.data?.title;
        if (typeof title === 'string' && title !== '') {
          track.title = title;
          await this.#broadcastSession(track);
          await this.broadcast(event(EVENTS.SESSION, { session: { id: track.sessionId, title, running: track.running } }));
        }
        return;
      }
      case 'turn/start':
        track.running = true;
        await this.broadcast(event(EVENTS.TURN, { sessionId: track.sessionId, state: 'start', turn: wire.data?.turn }));
        await this.#broadcastSession(track);
        return;
      case 'turn/end': {
        track.running = false;
        // The Harness reports the end reason as a structured object; the watch
        // only needs the discriminator.
        const reason = wire.data?.reason;
        const reasonKind = typeof reason === 'string' ? reason : reason?.kind;
        await this.broadcast(event(EVENTS.TURN, { sessionId: track.sessionId, state: 'end', reason: reasonKind }));
        await this.#broadcastSession(track);
        return;
      }
      case 'tool/call':
        await this.broadcast(event(EVENTS.TOOL, {
          sessionId: track.sessionId,
          state: 'call',
          name: String(wire.data?.name ?? 'tool'),
          callId: wire.data?.callId === undefined ? undefined : String(wire.data.callId),
          summary: summarizeToolArguments(wire.data?.arguments),
        }));
        return;
      case 'tool/result':
        await this.broadcast(event(EVENTS.TOOL, {
          sessionId: track.sessionId,
          state: 'result',
          callId: wire.data?.message?.toolCallId === undefined ? undefined : String(wire.data.message.toolCallId),
          failed: wire.data?.error !== undefined,
        }));
        return;
      default:
        return;
    }
  }

  /** Send the transcript window for one session. */
  async #sendTranscript(watch, id, frame) {
    const sessionId = String(frame.sessionId ?? watch.sessionId ?? '');
    const track = this.#sessions.get(sessionId);
    if (track === undefined) {
      if (id !== undefined) await watch.fail(id, ERROR_CODES.NO_SESSION, `unknown session ${sessionId}`);
      return;
    }
    const body = { sessionId, entries: track.transcript, cursor: track.cursor };
    if (id === undefined) await watch.send(event(EVENTS.TRANSCRIPT, body));
    else await watch.ok(id, body);
  }

  /** Send a prompt into a session. */
  async #send(watch, id, frame) {
    const sessionId = String(frame.sessionId ?? watch.sessionId ?? '');
    if (sessionId === '') {
      await watch.fail(id, ERROR_CODES.NO_SESSION, 'no session selected');
      return;
    }
    const text = typeof frame.text === 'string' ? frame.text : '';
    if (text.trim() === '') {
      await watch.fail(id, ERROR_CODES.BAD_REQUEST, 'empty prompt');
      return;
    }
    const track = this.#sessions.get(sessionId);
    if (track !== undefined) await this.#follow(track);
    const requestId = `watch-${randomBytes(8).toString('hex')}`;
    const result = await this.#client.call('session/prompt', {
      requestId,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    });
    if (result.ok !== true) {
      await watch.fail(id, ERROR_CODES.HARNESS, result.error?.message ?? 'session/prompt failed');
      return;
    }
    await watch.ok(id, { requestId, accepted: true });
  }

  /** Interrupt the current turn. */
  async #cancel(watch, id, frame) {
    const sessionId = String(frame.sessionId ?? watch.sessionId ?? '');
    const result = await this.#client.call('session/cancel', { sessionId });
    if (result.ok !== true) {
      await watch.fail(id, ERROR_CODES.HARNESS, result.error?.message ?? 'session/cancel failed');
      return;
    }
    await watch.ok(id, {});
  }

  /** Answer a pending approval. */
  async #approve(watch, id, frame) {
    const approvalId = String(frame.approvalId ?? '');
    const outcome = frame.outcome === 'rejected' ? 'rejected' : 'allowed-once';
    if (approvalId === '') {
      await watch.fail(id, ERROR_CODES.BAD_REQUEST, 'approvalId is required');
      return;
    }
    const claimed = await this.decide(approvalId, outcome);
    if (!claimed) {
      await watch.fail(id, ERROR_CODES.NOT_CONNECTED, 'that approval is no longer pending');
      return;
    }
    await watch.ok(id, { approvalId, outcome });
  }

  /** Change which session this watch follows without re-sending history. */
  async #subscribe(watch, id, frame) {
    const sessionId = String(frame.sessionId ?? '');
    const track = this.#sessions.get(sessionId);
    if (track === undefined) {
      await watch.fail(id, ERROR_CODES.NO_SESSION, `unknown session ${sessionId}`);
      return;
    }
    watch.sessionId = sessionId;
    await this.#follow(track);
    await watch.ok(id, { sessionId });
  }

  /** Close every connection this bridge owns. */
  close() {
    this.#closed = true;
    this.#eventsController?.abort();
    for (const track of this.#sessions.values()) track.followController?.abort();
    this.#client.close();
  }
}

/** Derive a readable title when the Harness has not produced one yet. */
function titleFromCwd(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return 'New session';
  const parts = cwd.split(/[\\/]/u).filter(Boolean);
  return parts[parts.length - 1] ?? 'Session';
}

/** Extract plain text from a message-shaped payload. */
function textOfMessage(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim();
}

/** Reduce token usage to the two numbers a watch might show. */
function usageSummary(usage) {
  if (usage === undefined || usage === null) return undefined;
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cached: usage.cacheReadTokens,
  };
}

/** Keep a tool call's argument preview short enough for a watch face. */
function summarizeToolArguments(raw) {
  if (typeof raw !== 'string' || raw === '') return undefined;
  const oneLine = raw.replace(/\s+/gu, ' ').trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine;
}

/** The session a scoped waterfall frame belongs to, when the Host projected it. */
function sessionIdOfFrame(frame) {
  const request = frame.request ?? {};
  const candidate = request.sessionId ?? request.agent?.sessionId;
  return candidate === undefined ? undefined : String(candidate);
}
