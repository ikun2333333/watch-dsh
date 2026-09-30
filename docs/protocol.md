/**
 * watch-dsh wire protocol, version 1.
 *
 * This file is the normative specification. The PC bridge
 * (`packages/dsh-bridge/src/protocol.mjs`) and the watch app
 * (`Protocol.kt`) each implement it, so any change must land in all three.
 *
 * ============================================================================
 * Transport
 * ============================================================================
 *
 * A relay — or, on the same Wi-Fi, the bridge itself — carries WebSocket text
 * frames between the watch and the bridge. Two frame families share the socket:
 *
 *   transport frames   produced by the relay, never sealed, discriminated by a
 *                      string `t` field: `ready`, `watch-online`,
 *                      `watch-offline`, `peer-offline`, `sealed`, and the
 *                      relay's own `from` stamp.
 *   sealed frames      produced by the peers, opaque to the relay:
 *                      `{ "t": "sealed", "n": <base64 nonce>, "c": <base64
 *                      ciphertext||tag> }`
 *
 * A `sealed` frame carries no readable fields, so a receiver must try to open it
 * rather than inspect it.
 *
 * ============================================================================
 * End-to-end sealing
 * ============================================================================
 *
 * Both peers share a high-entropy pairing secret (32 random bytes, base64url).
 * Two independent keys are derived so the two directions can never be
 * confused or replayed against each other:
 *
 *   key(direction) = SHA-256( "v1:" + direction + ":" + secret )   // UTF-8
 *   direction      = "w2b" (watch → bridge) | "b2w" (bridge → watch)
 *
 * Sealing is AES-256-GCM with a fresh random 12-byte nonce per frame; the
 * 16-byte authentication tag is appended to the ciphertext. The base64 of
 * `nonce` is the standard alphabet with padding; the base64 of
 * `ciphertext||tag` likewise. Plaintext is the UTF-8 JSON of the inner frame.
 *
 * The relay therefore sees only opaque blobs and holds no key. It can drop or
 * delay traffic, but it cannot read a prompt or forge an approval.
 *
 * ============================================================================
 * Inner frames
 * ============================================================================
 *
 * Every inner frame has a channel discriminator `ch`.
 *
 * Command — watch → bridge — is always answered by exactly one `res`:
 *
 *   { "ch": "cmd", "id": <string>, "cmd": <string>, ...command arguments }
 *   { "ch": "res", "id": <string>, "ok": true,  ...response fields }
 *   { "ch": "res", "id": <string>, "ok": false, "error": { "code": …, "message": … } }
 *
 * Event — bridge → watch — is unsolicited:
 *
 *   { "ch": "evt", "evt": <string>, ...event fields }
 *
 * ---------------------------------------------------------------------------
 * Commands
 * ---------------------------------------------------------------------------
 *
 * "hello"          {} → { protocol, bridge, status }
 * "sessions"       {} → { sessions: SessionRow[] }
 * "session.open"   { sessionId?, cwd? } → { sessionId, title }
 *                     Creating a session when `sessionId` is absent.
 * "transcript"     { sessionId } → { sessionId, entries: Entry[], cursor }
 * "send"           { sessionId, text } → { requestId, accepted: true }
 * "cancel"         { sessionId } → {}
 * "approve"        { approvalId, outcome: "allowed-once"|"rejected" } → { approvalId, outcome }
 * "subscribe"      { sessionId } → { sessionId }
 *
 * ---------------------------------------------------------------------------
 * Events
 * ---------------------------------------------------------------------------
 *
 * "status"          { status: { harness, relay, detail, sessions, watches } }
 * "sessions"        { sessions: SessionRow[] }        — the whole list, not a diff
 * "session"         { session: { id, title, running, updatedAt } }
 * "transcript"      { sessionId, entries: Entry[] }   — full window or an append
 * "delta"           { sessionId, text }               — streamed assistant text
 * "delta"           { sessionId, reasoning: true }    — reasoning started; no text
 * "tool"            { sessionId, state: "call"|"result", name?, callId?, summary?, failed? }
 * "turn"            { sessionId, state: "start"|"end", turn?, reason? }
 * "approval"        { approval: { approvalId, sessionId, toolName, callId?, reason? } }
 * "approval.closed" { approvalId, outcome? , reason? }
 * "notice"          { level: "info"|"warn"|"error", message }
 *
 * ---------------------------------------------------------------------------
 * Data shapes
 * ---------------------------------------------------------------------------
 *
 * SessionRow { id, title, running, blank, updatedAt, cwd?, approvals }
 * Entry      { kind: "user"|"assistant", seq, text, usage? }
 * Usage      { input?, output?, cached? }
 *
 * Error codes the watch localizes: "bad-request", "not-connected",
 * "no-session", "unsupported", "harness", "internal".
 *
 * ============================================================================
 * Reconnection
 * ============================================================================
 *
 * The watch reconnects with capped exponential backoff and, on every
 * re-attach, re-sends "hello" and re-reads "sessions" plus the followed
 * "transcript", because the bridge treats each attach as a new subscription.
 * Streamed "delta" text is advisory: the authoritative text arrives in the
 * "transcript" entry emitted when the assistant message commits, so a dropped
 * connection can never leave a truncated message on screen.
 */

export const SCHEMA_VERSION = 1;
