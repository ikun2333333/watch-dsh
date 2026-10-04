package dev.watchdsh.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/**
 * Wire shapes for the watch ⇄ bridge protocol, version 1.
 *
 * `docs/protocol.md` is the normative specification; this file is its Kotlin
 * binding. The PC counterpart is `packages/dsh-bridge/src/protocol.mjs`.
 */

/** Protocol version this build speaks. */
const val PROTOCOL_VERSION = 1

/**
 * The single JSON configuration used for every frame.
 *
 * `ignoreUnknownKeys` lets a newer bridge add fields without breaking this app,
 * and explicit nulls are omitted so a frame stays small on a metered link.
 */
/**
 * The one JSON configuration used for every frame.
 *
 * `encodeDefaults` must stay true. A `SealedFrame`'s discriminant `t` has the
 * default `"sealed"`, and omitting defaults would drop it from the wire — the
 * bridge then receives `{n, c}`, has no way to recognise a sealed payload, and
 * rejects every frame. The protocol's discriminants are contract, not defaults
 * to be elided.
 */
val ProtocolJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
    isLenient = false
}

/**
 * An opaque sealed envelope. The relay routes this without reading it.
 *
 * `t` deliberately has no default, so it cannot be omitted by any encoder
 * configuration; the relay and bridge both key off it.
 */
@Serializable
data class SealedFrame(
    val t: String,
    val n: String,
    val c: String,
) {
    companion object {
        /** The only value `t` may hold on the wire. */
        const val TYPE = "sealed"
    }
}

/**
 * A relay transport notice, or a sealed frame.
 *
 * The relay's own frames are distinguished by a string `t` that is never
 * `"sealed"`; callers must try to open anything flagged `sealed` rather than
 * inspecting further, because a sealed frame carries no readable fields.
 */
@Serializable
data class Envelope(
    val t: String? = null,
    val n: String? = null,
    val c: String? = null,
    /** Relay-assigned sender identity, present on every routed frame. */
    val from: String? = null,
    // Fields present on the relay's own transport frames.
    val role: String? = null,
    val pcId: String? = null,
    val pcOnline: Boolean? = null,
) {
    /** Whether this envelope should be treated as a sealed payload. */
    val isSealed: Boolean get() = t == SealedFrame.TYPE && n != null && c != null

    /** Convert to a [SealedFrame] when this envelope carries one. */
    fun asSealed(): SealedFrame? =
        if (isSealed) SealedFrame(t = SealedFrame.TYPE, n = n!!, c = c!!) else null
}

/** Command names. The strings are wire contract. */
object Commands {
    const val HELLO = "hello"
    const val SESSIONS = "sessions"
    const val TRANSCRIPT = "transcript"
    const val SESSION_OPEN = "session.open"
    const val SEND = "send"
    const val CANCEL = "cancel"
    const val APPROVE = "approve"
    const val ANSWER = "answer"
    const val SUBSCRIBE = "subscribe"
}

/** Event names. The strings are wire contract. */
object Events {
    const val SESSIONS = "sessions"
    const val SESSION = "session"
    const val TRANSCRIPT = "transcript"
    const val DELTA = "delta"
    const val TOOL = "tool"
    const val TURN = "turn"
    const val APPROVAL = "approval"
    const val APPROVAL_CLOSED = "approval.closed"
    const val STATUS = "status"
    const val NOTICE = "notice"
}

/**
 * One entry in a session transcript.
 *
 * `usage` is only present on committed assistant messages, and its fields are
 * optional because a provider may not report every counter.
 */
@Serializable
data class TranscriptEntry(
    val kind: String,
    val seq: Long = 0,
    val text: String = "",
    val usage: Usage? = null,
)

/** Token accounting for one committed assistant message. */
@Serializable
data class Usage(
    val input: Long? = null,
    val output: Long? = null,
    val cached: Long? = null,
)

/** One row in the session list. */
@Serializable
data class SessionRow(
    val id: String,
    val title: String = "",
    val running: Boolean = false,
    val blank: Boolean = false,
    val updatedAt: Long = 0,
    val cwd: String? = null,
    /** How many approvals are pending for this session. */
    val approvals: Int = 0,
)

/** One session's metadata, as pushed by the "session" event. */
@Serializable
data class SessionInfo(
    val id: String,
    val title: String = "",
    val running: Boolean = false,
    val updatedAt: Long = 0,
)

/** Bridge and Harness connection status. */
@Serializable
data class BridgeStatus(
    val harness: String = "unknown",
    val relay: String = "unknown",
    val detail: String = "",
    val sessions: Int = 0,
    val watches: Int = 0,
)

/** A pending approval the user must decide. */
@Serializable
data class Approval(
    val approvalId: String,
    val sessionId: String? = null,
    val toolName: String = "tool",
    val callId: String? = null,
    val reason: String? = null,
)

/** A tool call summary for the activity line. */
@Serializable
data class ToolActivity(
    val sessionId: String? = null,
    val state: String = "call",
    val name: String? = null,
    val callId: String? = null,
    val summary: String? = null,
    val failed: Boolean = false,
)

/** A successful command response, decoded on demand. */
@Serializable
data class CommandResponse(
    val id: String = "",
    val ok: Boolean = true,
    val error: CommandError? = null,
    // "hello"
    val protocol: Int? = null,
    val bridge: String? = null,
    val status: BridgeStatus? = null,
    // "sessions"
    val sessions: List<SessionRow>? = null,
    // "session.open" / "transcript"
    val sessionId: String? = null,
    val title: String? = null,
    val entries: List<TranscriptEntry>? = null,
    val cursor: Long? = null,
    // "send"
    val requestId: String? = null,
    val accepted: Boolean? = null,
    // "approve"
    val approvalId: String? = null,
    val outcome: String? = null,
)

/** The failure branch of a command response. */
@Serializable
data class CommandError(
    val code: String = "internal",
    val message: String = "",
)

/** Outcome vocabulary the bridge accepts for an approval. */
object ApprovalOutcome {
    const val ALLOW_ONCE = "allowed-once"
    const val REJECTED = "rejected"
}

/**
 * Build a command frame.
 *
 * Commands are built as [JsonObject] rather than data classes because each one
 * carries a different small set of fields, and a sealed hierarchy per command
 * would add types without adding safety at this boundary.
 */
fun command(id: String, name: String, body: JsonObject = JsonObject(emptyMap())): JsonObject =
    JsonObject(
        buildMap {
            put("ch", kotlinx.serialization.json.JsonPrimitive("cmd"))
            put("id", kotlinx.serialization.json.JsonPrimitive(id))
            put("cmd", kotlinx.serialization.json.JsonPrimitive(name))
            putAll(body)
        },
    )
