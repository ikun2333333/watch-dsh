/**
 * protocol: the single source of truth for the watch ⇄ bridge wire format.
 *
 * Design constraints that shaped this
 * -----------------------------------
 * 1. The watch runs on a battery over mobile data, so frames are small, the
 *    bridge pushes only what changed, and the watch never polls.
 * 2. The transport may be a public relay nobody fully trusts, so the payload is
 *    encrypted end-to-end and the relay only ever routes opaque blobs.
 * 3. Two processes implement this (Node bridge, Kotlin app), so the format is
 *    plain JSON with no binary encoding, no schema inheritance, and no
 *    version-specific tricks.
 *
 * Channels
 * --------
 * - `cmd`   watch → bridge, always answered by exactly one `res` or `err`
 * - `evt`   bridge → watch, unsolicited state and stream pushes
 * - `hello` / `ready` / `ping` / `pong`  transport-level, handled by the relay
 *
 * Every non-transport frame is sealed (`sealFrame`) before it reaches the relay
 * and opened by the peer, so relay operators see only ciphertext.
 */

/** Bump when a change would break an older peer. */
export const PROTOCOL_VERSION = 1;

/**
 * The SHA-256 domain separators used to derive the two directional sealing keys.
 *
 * The Kotlin client hardcodes these same strings, so they are part of the wire
 * contract: changing one is a breaking protocol change.
 */
export const KEY_PURPOSE = Object.freeze({ watchToBridge: 'w2b', bridgeToWatch: 'b2w' });

/** Frame kinds that the relay routes but never reads. */
export const TRANSPORT_KINDS = Object.freeze(['hello', 'ready', 'ping', 'pong']);

/** Peer roles a relay connection may claim. */
export const ROLES = Object.freeze(['pc', 'watch']);

/** Watch → bridge commands. */
export const COMMANDS = Object.freeze({
  /** Handshake: report app version and protocol expectations. */
  HELLO: 'hello',
  /** List known sessions, most recent first. */
  SESSIONS: 'sessions',
  /** Read a page of an existing session's transcript. */
  TRANSCRIPT: 'transcript',
  /** Create a fresh session, or resume the most recent one when `resume`. */
  SESSION_OPEN: 'session.open',
  /** Send a prompt to the current session. */
  SEND: 'send',
  /** Interrupt the in-flight turn. */
  CANCEL: 'cancel',
  /** Answer a pending approval: `allowed-once` | `rejected`. */
  APPROVE: 'approve',
  /** Answer a pending `ask_user_question` prompt. */
  ANSWER: 'answer',
  /** Toggle which session updates this watch receives. */
  SUBSCRIBE: 'subscribe',
});

/** Bridge → watch events. */
export const EVENTS = Object.freeze({
  /** Session list changed; carries the full list, not a diff. */
  SESSIONS: 'sessions',
  /** One session's metadata or status changed. */
  SESSION: 'session',
  /** Ordered transcript entries for the followed session. */
  TRANSCRIPT: 'transcript',
  /** Streaming assistant text delta for the followed session. */
  DELTA: 'delta',
  /** A tool call started or finished (compact, watch-sized summary). */
  TOOL: 'tool',
  /** A turn started or ended, so the watch can show a spinner. */
  TURN: 'turn',
  /** An approval request awaits a decision. */
  APPROVAL: 'approval',
  /** An approval request is no longer pending (answered elsewhere or aborted). */
  APPROVAL_CLOSED: 'approval.closed',
  /** The bridge's own connection status toward the Harness. */
  STATUS: 'status',
  /** Non-fatal diagnostic the watch may show in a details screen. */
  NOTICE: 'notice',
});

/** Error codes the bridge may return; the watch localizes these. */
export const ERROR_CODES = Object.freeze({
  BAD_REQUEST: 'bad-request',
  NOT_CONNECTED: 'not-connected',
  NO_SESSION: 'no-session',
  UNSUPPORTED: 'unsupported',
  HARNESS: 'harness',
  INTERNAL: 'internal',
});

/** Current wire envelope version for sealed frames. */
const SEAL_VERSION = 'v1';

/*
 * End-to-end sealing
 * ------------------
 * AES-256-GCM from node:crypto / javax.crypto, which both runtimes implement
 * natively. The relay forwards `{ t: 'sealed', n: <nonce>, c: <ciphertext> }`
 * and holds no key.
 */

/** Derive the 32-byte sealing key from the pairing secret. */
async function deriveKey(secret, purpose) {
  const { createHash } = await import('node:crypto');
  // HKDF is not needed for a single-key protocol: a domain-separated SHA-256 of
  // the high-entropy pairing secret is a sound KDF, and it keeps the Kotlin side
  // to one MessageDigest call.
  return createHash('sha256').update(`${SEAL_VERSION}:${purpose}:${secret}`, 'utf8').digest();
}

/**
 * Seal one frame for the peer.
 * @param secret - the pairing secret shared by watch and bridge.
 * @param direction - `w2b` (watch to bridge) or `b2w`; keeps the two directions' keys distinct.
 * @param frame - the JSON-serializable frame.
 * @returns the opaque envelope the relay routes.
 */
export async function sealFrame(secret, direction, frame) {
  const { createCipheriv, randomBytes } = await import('node:crypto');
  const key = await deriveKey(secret, direction);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const plaintext = Buffer.from(JSON.stringify(frame), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { t: 'sealed', n: nonce.toString('base64'), c: ciphertext.toString('base64') };
}

/**
 * Open one sealed frame from the peer.
 * @param secret - the pairing secret shared by watch and bridge.
 * @param direction - the direction the frame was sealed in.
 * @param envelope - the opaque envelope received from the relay.
 * @returns the decoded frame, or undefined when authentication fails.
 */
export async function openFrame(secret, direction, envelope) {
  if (envelope?.t !== 'sealed' || typeof envelope.n !== 'string' || typeof envelope.c !== 'string') return undefined;
  const { createDecipheriv } = await import('node:crypto');
  const key = await deriveKey(secret, direction);
  const blob = Buffer.from(envelope.c, 'base64');
  if (blob.byteLength < 16) return undefined;
  const ciphertext = blob.subarray(0, blob.byteLength - 16);
  const authTag = blob.subarray(blob.byteLength - 16);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.n, 'base64'));
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Open one sealed frame, reporting why it failed.
 *
 * `openFrame` collapses every failure into `undefined`, which is right for the
 * hot path but useless for diagnosis: a short nonce, a truncated tag, and a
 * genuinely wrong key are indistinguishable at the call site. This variant names
 * the reason and is used only where a failure is already unexpected.
 *
 * @param secret - the pairing secret shared by watch and bridge.
 * @param direction - the direction the frame was sealed in.
 * @param envelope - the opaque envelope received from the relay.
 * @returns the decoded frame, or a description of the failure.
 */
export async function openFrameDiagnostic(secret, direction, envelope) {
  if (envelope?.t !== 'sealed') return { error: 'not a sealed envelope' };
  if (typeof envelope.n !== 'string' || typeof envelope.c !== 'string') {
    return { error: `missing fields: n=${typeof envelope.n} c=${typeof envelope.c}` };
  }
  const { createDecipheriv } = await import('node:crypto');
  const nonce = Buffer.from(envelope.n, 'base64');
  const blob = Buffer.from(envelope.c, 'base64');
  if (nonce.byteLength !== 12) return { error: `nonce is ${String(nonce.byteLength)} bytes, expected 12` };
  if (blob.byteLength < 16) return { error: `ciphertext is ${String(blob.byteLength)} bytes, too short for a tag` };
  const key = await deriveKey(secret, direction);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(blob.subarray(blob.byteLength - 16));
    const plaintext = Buffer.concat([
      decipher.update(blob.subarray(0, blob.byteLength - 16)),
      decipher.final(),
    ]);
    return { frame: JSON.parse(plaintext.toString('utf8')) };
  } catch (error) {
    // A bad tag means the key differs or the bytes were altered in transit.
    return { error: `${error.constructor.name}: ${error.message} (secret ${String(secret.length)} chars, nonce ${String(nonce.byteLength)}B, blob ${String(blob.byteLength)}B)` };
  }
}

/**
 * Build a command frame.
 * @param id - correlation id echoed by the response.
 * @param command - one of {@link COMMANDS}.
 * @param body - command arguments.
 * @returns the frame.
 */
export function command(id, name, body = {}) {
  return { ch: 'cmd', id, cmd: name, ...body };
}

/**
 * Build a successful response frame.
 * @param id - the command's correlation id.
 * @param body - response payload.
 * @returns the frame.
 */
export function response(id, body = {}) {
  return { ch: 'res', id, ok: true, ...body };
}

/**
 * Build a failed response frame.
 * @param id - the command's correlation id.
 * @param code - one of {@link ERROR_CODES}.
 * @param message - human-readable detail for the watch's log.
 * @returns the frame.
 */
export function failure(id, code, message) {
  return { ch: 'res', id, ok: false, error: { code, message } };
}

/**
 * Build an unsolicited event frame.
 * @param event - one of {@link EVENTS}.
 * @param body - event payload.
 * @returns the frame.
 */
export function event(name, body = {}) {
  return { ch: 'evt', evt: name, ...body };
}

/**
 * Validate a decoded frame's channel.
 * @param frame - decoded frame.
 * @returns the channel, or undefined when the frame is not addressable.
 */
export function channelOf(frame) {
  const channel = frame?.ch;
  return channel === 'cmd' || channel === 'res' || channel === 'evt' ? channel : undefined;
}
