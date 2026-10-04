package dev.watchdsh.net

import dev.watchdsh.protocol.ApprovalOutcome
import dev.watchdsh.protocol.BridgeStatus
import dev.watchdsh.protocol.CommandResponse
import dev.watchdsh.protocol.Commands
import dev.watchdsh.protocol.Envelope
import dev.watchdsh.protocol.Events
import dev.watchdsh.protocol.ProtocolJson
import dev.watchdsh.protocol.PROTOCOL_VERSION
import dev.watchdsh.protocol.Sealing
import dev.watchdsh.protocol.SessionRow
import dev.watchdsh.protocol.TranscriptEntry
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume

/** Where the watch is pointed, and with which secret. */
data class ConnectionConfig(
    /** Relay or bridge WebSocket URL, e.g. `wss://relay.example.workers.dev`. */
    val url: String,
    /** Relay authentication token. */
    val token: String,
    /** End-to-end pairing secret shared with the bridge. */
    val pairingSecret: String,
    /** The PC identity to reach through the relay. */
    val pcId: String,
) {
    /** The base connection string, with any role path removed. */
    val baseUrl: String
        get() {
            val trimmed = url.trim().trimEnd('/')
            return when {
                trimmed.endsWith("/pc") -> trimmed.removeSuffix("/pc")
                trimmed.endsWith("/watch") -> trimmed.removeSuffix("/watch")
                else -> trimmed
            }
        }

    /**
     * The URL a watch dials.
     *
     * A relay serves two distinct paths — `/pc` for the bridge and `/watch` for
     * watches — and it answers only those. The relay address is therefore a host,
     * not a full endpoint, so the role path is appended here rather than expected
     * in the stored value. Getting this wrong produces an upgrade request to `/`,
     * which the relay refuses, and the client sees only "unexpected end of stream".
     */
    fun watchUrl(): String {
        val base = baseUrl
        val separator = if (base.contains('?')) '&' else '?'
        return "$base/watch$separator" + listOf(
            "token" to token,
            "pc" to pcId,
        ).joinToString("&") { (key, value) -> "$key=${java.net.URLEncoder.encode(value, "UTF-8")}" }
    }

    /** The URL with credentials removed, for diagnostics. */
    fun redactedWatchUrl(): String {
        val separator = if (baseUrl.contains('?')) '&' else '?'
        return "$baseUrl/watch$separator" + "token=...&pc=${java.net.URLEncoder.encode(pcId, "UTF-8")}"
    }
}

/** Connection lifecycle as the UI shows it. */
enum class LinkState { Disconnected, Connecting, Connected, Unauthorized, Failed }

/** One decoded event from the bridge. */
sealed interface BridgeEvent {
    data class Status(val status: BridgeStatus) : BridgeEvent
    data class Sessions(val rows: List<SessionRow>) : BridgeEvent
    data class Session(val id: String, val title: String, val running: Boolean, val updatedAt: Long) : BridgeEvent
    data class Transcript(val sessionId: String, val entries: List<TranscriptEntry>, val cursor: Long) : BridgeEvent
    data class Delta(val sessionId: String, val text: String, val reasoning: Boolean) : BridgeEvent
    data class Tool(
        val sessionId: String?,
        val state: String,
        val name: String?,
        val callId: String?,
        val summary: String?,
        val failed: Boolean,
    ) : BridgeEvent
    data class Turn(val sessionId: String, val state: String, val reason: String?) : BridgeEvent
    data class Approval(
        val approvalId: String,
        val sessionId: String?,
        val toolName: String,
        val callId: String?,
        val reason: String?,
    ) : BridgeEvent
    data class ApprovalClosed(val approvalId: String, val outcome: String?, val reason: String?) : BridgeEvent
    data class Notice(val level: String, val message: String) : BridgeEvent
}

/** A command that failed, carrying the bridge's stable error code. */
class BridgeException(val code: String, override val message: String) : Exception(message)

/**
 * The watch's link to the PC bridge.
 *
 * Responsibilities: keep one WebSocket alive with capped exponential backoff,
 * seal and open every application frame, correlate commands with their
 * responses, and decode events into [BridgeEvent]s.
 *
 * Reconnection detail worth knowing: every successful re-attach re-sends the
 * handshake and re-reads the session list and followed transcript, because the
 * bridge treats each attach as a fresh subscription. The UI therefore never has
 * to reason about what it missed while offline.
 */
class BridgeLink(
    private val scope: CoroutineScope,
    private val client: OkHttpClient = defaultClient(),
    private val wifiKeeper: WifiKeeper? = null,
) {
    private val sealKeys = ConcurrentHashMap<String, javax.crypto.spec.SecretKeySpec>()
    private val pending = ConcurrentHashMap<String, PendingCommand>()

    private var webSocket: WebSocket? = null
    private var config: ConnectionConfig? = null
    private var reconnectJob: Job? = null
    private var attempt = 0
    private var closing = false

    /**
     * Addresses still to try, in order, when the current one cannot be reached.
     *
     * A watch may know both a local and a public address for the same PC. Only the
     * local one works at home and only the public one works away, and this is how
     * the fallback happens without asking the user or needing a mode flag.
     */
    private var fallbacks: List<String> = emptyList()

    /**
     * The id the relay assigned this connection, learned from its `ready` frame.
     *
     * Used for diagnostics only: the relay stamps this id on frames it forwards, so
     * nothing the watch sends has to carry it.
     */
    private var relayId: String? = null

    /**
     * Observes link milestones, including transport failures.
     *
     * A release build has no readable logcat, so the reason a socket was refused
     * is otherwise invisible; this is what makes a connection problem diagnosable
     * on the device itself.
     */
    var observer: ((String) -> Unit)? = null

    private val _state = MutableStateFlow(LinkState.Disconnected)
    /** Current link state, for the status line and the reconnect UI. */
    val state: StateFlow<LinkState> = _state.asStateFlow()

    private val _events = MutableSharedFlow<BridgeEvent>(
        replay = 0,
        extraBufferCapacity = 256,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    /** Decoded bridge events. Slow collectors drop the oldest buffered events. */
    val events: SharedFlow<BridgeEvent> = _events.asSharedFlow()

    private class PendingCommand(
        val continuation: kotlin.coroutines.Continuation<CommandResponse>,
    )

    /**
     * The key for one direction, derived on first use.
     *
     * @return null while no pairing secret is known, which is the state a watch is
     *   in between discovering a PC and being paired by it. Callers treat that as
     *   "cannot seal or open yet" rather than as an error, because it is the
     *   normal first-run condition and not a fault.
     */
    private fun keyFor(direction: String): javax.crypto.spec.SecretKeySpec? {
        val secret = config?.pairingSecret
        if (secret.isNullOrBlank()) return null
        return sealKeys.getOrPut(direction) { Sealing.deriveKey(secret, direction) }
    }

    /**
     * Point the link at a bridge and keep it connected.
     *
     * @param fallbacks - further addresses to try if this one cannot be reached.
     *   A watch may know both a local and a public address for the same PC, and
     *   only one of them works depending on where the watch is. Trying them in
     *   order means a stale address costs one failed attempt instead of a stuck
     *   connection.
     */
    fun connect(config: ConnectionConfig, fallbacks: List<String> = emptyList()) {
        disconnect()
        this.config = config
        this.fallbacks = fallbacks
        this.closing = false
        this.attempt = 0
        sealKeys.clear()
        openSocket()
    }

    /**
     * Move to the next candidate address after this one proved unreachable.
     *
     * @returns true when there was one to move to.
     */
    private fun advance(): Boolean {
        val next = fallbacks.firstOrNull() ?: return false
        fallbacks = fallbacks.drop(1)
        val current = config ?: return false
        config = current.copy(url = next)
        // A different address is a fresh start: the backoff earned by the address
        // that failed should not delay the one that may work.
        attempt = 0
        sealKeys.clear()
        observer?.invoke("falling back to the next address")
        openSocket()
        return true
    }

    /** Stop reconnecting and close the socket. */
    fun disconnect() {
        closing = true
        reconnectJob?.cancel()
        reconnectJob = null
        val socket = webSocket
        webSocket = null
        socket?.close(1000, "client closing")
        wifiKeeper?.release()
        failAllPending("disconnected")
        _state.value = LinkState.Disconnected
    }

    private fun openSocket() {
        val config = this.config ?: return
        _state.value = LinkState.Connecting
        // The token is redacted: this observation is recorded on the device, where
        // `adb pull` can retrieve it.
        observer?.invoke("opening ${config.redactedWatchUrl()}")
        val request = Request.Builder().url(config.watchUrl()).build()
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                attempt = 0
                // A watch suspends its radio seconds into an idle connection, so
                // the lock is taken for exactly as long as a socket is open.
                wifiKeeper?.acquire()
                _state.value = LinkState.Connected
                scope.launch {
                    runCatching { handshake() }
                        .onFailure { observer?.invoke("onOpen: handshake threw ${it.message}") }
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                scope.launch { handleFrame(text) }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                val code = response?.code
                wifiKeeper?.release()
                observer?.invoke("socket failed: ${t.javaClass.simpleName}: ${t.message} http=${code ?: "-"}")
                // The relay answers 401 for a bad token and 400 for a missing pc
                // id; both are configuration errors that retrying cannot fix.
                _state.value = when (code) {
                    401, 403 -> LinkState.Unauthorized
                    400 -> LinkState.Failed
                    else -> LinkState.Disconnected
                }
                failAllPending(t.message ?: "connection failed")
                // An address that could not be reached says nothing about the next
                // one, so another is tried immediately rather than after a backoff.
                // A response, by contrast, means the address works and the failure
                // is elsewhere: falling back would only hide it.
                if (response == null && !closing && advance()) return
                scheduleReconnect()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                wifiKeeper?.release()
                observer?.invoke("socket closed: $code $reason")
                failAllPending(reason.ifBlank { "closed" })
                scheduleReconnect()
            }
        }
        webSocket = client.newWebSocket(request, listener)
    }

    private fun scheduleReconnect() {
        if (closing) return
        if (_state.value == LinkState.Unauthorized || _state.value == LinkState.Failed) return
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            // Capped exponential backoff: a watch on a flaky mobile link should
            // recover quickly from a blip but must not hammer the relay.
            attempt += 1
            val delayMs = minOf(1_000L * (1L shl minOf(attempt, 5)), 30_000L)
            delay(delayMs)
            if (!closing) openSocket()
        }
    }

    /** Send the handshake and pull the initial state. */
    suspend fun handshake() {
        val hello = call(
            Commands.HELLO,
            buildJsonObject {
                put("app", "watch-dsh")
                put("protocol", JsonPrimitive(PROTOCOL_VERSION))
            },
        )
        observer?.invoke("handshake: harness=${hello.status?.harness ?: "-"}")
        hello.status?.let { _events.tryEmit(BridgeEvent.Status(it)) }
        val sessions = call(Commands.SESSIONS)
        observer?.invoke("handshake: sessions=${sessions.sessions?.size ?: -1}")
        sessions.sessions?.let { _events.tryEmit(BridgeEvent.Sessions(it)) }
    }

    /** Ask the bridge for the session list again. */
    suspend fun refreshSessions(): List<SessionRow> = call(Commands.SESSIONS).sessions ?: emptyList()

    /** Read a session's transcript window. */
    suspend fun transcript(sessionId: String): CommandResponse =
        call(Commands.TRANSCRIPT, buildJsonObject { put("sessionId", sessionId) })

    /** Open an existing session, or create one when `sessionId` is null. */
    suspend fun openSession(sessionId: String? = null): CommandResponse =
        call(
            Commands.SESSION_OPEN,
            buildJsonObject {
                if (sessionId != null) put("sessionId", sessionId)
            },
        )

    /** Send a prompt into a session. */
    suspend fun send(sessionId: String, text: String): CommandResponse =
        call(
            Commands.SEND,
            buildJsonObject {
                put("sessionId", sessionId)
                put("text", text)
            },
        )

    /** Interrupt the running turn. */
    suspend fun cancel(sessionId: String): CommandResponse =
        call(Commands.CANCEL, buildJsonObject { put("sessionId", sessionId) })

    /** Answer a pending approval. */
    suspend fun approve(approvalId: String, outcome: String): CommandResponse =
        call(
            Commands.APPROVE,
            buildJsonObject {
                put("approvalId", approvalId)
                put("outcome", outcome)
            },
        )

    /** Follow a different session without re-sending the whole handshake. */
    suspend fun subscribe(sessionId: String): CommandResponse =
        call(Commands.SUBSCRIBE, buildJsonObject { put("sessionId", sessionId) })

    /** Allow once, the only grant the approval vocabulary offers. */
    suspend fun allowOnce(approvalId: String) = approve(approvalId, ApprovalOutcome.ALLOW_ONCE)

    /** Reject an approval. */
    suspend fun reject(approvalId: String) = approve(approvalId, ApprovalOutcome.REJECTED)

    /**
     * Seal and send one command, then suspend until its response arrives.
     *
     * @throws BridgeException when the bridge answers with `ok: false`, or when
     *   the link is not usable.
     */
    suspend fun call(name: String, body: JsonObject = JsonObject(emptyMap())): CommandResponse {
        val socket = webSocket ?: throw BridgeException("not-connected", "no active connection")
        val key = keyFor(Sealing.WATCH_TO_BRIDGE)
            ?: throw BridgeException("not-connected", "this watch is not paired yet")
        val id = UUID.randomUUID().toString()
        val frame = dev.watchdsh.protocol.command(id, name, body)
        val sealed = Sealing.sealText(key, frame.toString())
        val sent = socket.send(ProtocolJson.encodeToString(sealed))
        if (!sent) throw BridgeException("not-connected", "socket refused the frame")

        val response = withTimeoutOrNull(COMMAND_TIMEOUT_MS) {
            suspendCancellableCoroutine<CommandResponse> { continuation ->
                pending[id] = PendingCommand(continuation)
                continuation.invokeOnCancellation { pending.remove(id) }
            }
        } ?: throw BridgeException("not-connected", "no response to $name")
        if (!response.ok) {
            val error = response.error
            throw BridgeException(error?.code ?: "internal", error?.message ?: "$name failed")
        }
        return response
    }

    /**
     * Decode one raw frame from the relay.
     *
     * The relay's own transport notices are the only frames that are not sealed;
     * the `ready` frame carries the connection id this link records for logs.
     * Everything else must open with the pairing secret, which is what proves the
     * sender is the bridge this watch was configured for.
     */
    private suspend fun handleFrame(text: String) {
        val envelope = runCatching { ProtocolJson.decodeFromString<Envelope>(text) }.getOrNull() ?: return

        // Transport frames are the relay's own, and the only frames that are not
        // sealed. The `ready` frame carries the id this link records for logs.
        if (envelope.t != null && !envelope.isSealed) {
            if (envelope.t == "ready") relayId = envelope.from
            return
        }

        val key = keyFor(Sealing.BRIDGE_TO_WATCH) ?: return
        val plaintext = Sealing.openText(key, envelope.asSealed()!!) ?: run {
            observer?.invoke("recv: could not open a frame")
            return
        }
        val json = runCatching { ProtocolJson.parseToJsonElement(plaintext) as? JsonObject }.getOrNull() ?: return
        when (json["ch"]?.let { (it as? JsonPrimitive)?.contentOrNullSafe() }) {
            "res" -> deliverResponse(json)
            "evt" -> deliverEvent(json)
            else -> Unit
        }
    }

    private fun deliverResponse(json: JsonObject) {
        val response = runCatching { ProtocolJson.decodeFromJsonElement(CommandResponse.serializer(), json) }.getOrNull() ?: return
        val waiting = pending.remove(response.id) ?: return
        waiting.continuation.resume(response)
    }

    private fun deliverEvent(json: JsonObject) {
        val name = (json["evt"] as? JsonPrimitive)?.contentOrNullSafe() ?: return
        val event = when (name) {
            Events.STATUS -> json["status"]?.let {
                runCatching { ProtocolJson.decodeFromJsonElement(BridgeStatus.serializer(), it) }.getOrNull()
            }?.let { BridgeEvent.Status(it) }

            Events.SESSIONS -> json["sessions"]?.let {
                runCatching { ProtocolJson.decodeFromJsonElement(kotlinx.serialization.builtins.ListSerializer(SessionRow.serializer()), it) }.getOrNull()
            }?.let { BridgeEvent.Sessions(it) }

            Events.SESSION -> json["session"]?.let {
                runCatching { ProtocolJson.decodeFromJsonElement(dev.watchdsh.protocol.SessionInfo.serializer(), it) }.getOrNull()
            }?.let { BridgeEvent.Session(it.id, it.title, it.running, it.updatedAt) }

            Events.TRANSCRIPT -> runCatching {
                val sessionId = (json["sessionId"] as? JsonPrimitive)?.contentOrNullSafe() ?: ""
                val entries = json["entries"]?.let {
                    ProtocolJson.decodeFromJsonElement(kotlinx.serialization.builtins.ListSerializer(TranscriptEntry.serializer()), it)
                } ?: emptyList()
                val cursor = (json["cursor"] as? JsonPrimitive)?.content?.toLongOrNull() ?: 0L
                BridgeEvent.Transcript(sessionId, entries, cursor)
            }.getOrNull()

            Events.DELTA -> BridgeEvent.Delta(
                sessionId = (json["sessionId"] as? JsonPrimitive)?.contentOrNullSafe() ?: "",
                text = (json["text"] as? JsonPrimitive)?.contentOrNullSafe() ?: "",
                reasoning = (json["reasoning"] as? JsonPrimitive)?.booleanOrNull ?: false,
            )

            Events.TOOL -> BridgeEvent.Tool(
                sessionId = (json["sessionId"] as? JsonPrimitive)?.contentOrNullSafe(),
                state = (json["state"] as? JsonPrimitive)?.contentOrNullSafe() ?: "call",
                name = (json["name"] as? JsonPrimitive)?.contentOrNullSafe(),
                callId = (json["callId"] as? JsonPrimitive)?.contentOrNullSafe(),
                summary = (json["summary"] as? JsonPrimitive)?.contentOrNullSafe(),
                failed = (json["failed"] as? JsonPrimitive)?.booleanOrNull ?: false,
            )

            Events.TURN -> BridgeEvent.Turn(
                sessionId = (json["sessionId"] as? JsonPrimitive)?.contentOrNullSafe() ?: "",
                state = (json["state"] as? JsonPrimitive)?.contentOrNullSafe() ?: "",
                reason = (json["reason"] as? JsonPrimitive)?.contentOrNullSafe(),
            )

            Events.APPROVAL -> json["approval"]?.let {
                runCatching { ProtocolJson.decodeFromJsonElement(dev.watchdsh.protocol.Approval.serializer(), it) }.getOrNull()
            }?.let { BridgeEvent.Approval(it.approvalId, it.sessionId, it.toolName, it.callId, it.reason) }

            Events.APPROVAL_CLOSED -> BridgeEvent.ApprovalClosed(
                approvalId = (json["approvalId"] as? JsonPrimitive)?.contentOrNullSafe() ?: "",
                outcome = (json["outcome"] as? JsonPrimitive)?.contentOrNullSafe(),
                reason = (json["reason"] as? JsonPrimitive)?.contentOrNullSafe(),
            )

            Events.NOTICE -> BridgeEvent.Notice(
                level = (json["level"] as? JsonPrimitive)?.contentOrNullSafe() ?: "info",
                message = (json["message"] as? JsonPrimitive)?.contentOrNullSafe() ?: "",
            )

            else -> null
        }
        if (event != null) _events.tryEmit(event)
    }

    private fun failAllPending(reason: String) {
        val snapshot = pending.keys.toList()
        for (id in snapshot) {
            pending.remove(id)?.continuation?.resumeWith(Result.failure(BridgeException("not-connected", reason)))
        }
    }

    private companion object {
        /** Long enough for a slow tool-free turn, short enough to surface a dead link. */
        const val COMMAND_TIMEOUT_MS = 30_000L

        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            // The relay pings on its own schedule; a slightly longer read timeout
            // avoids tearing down an idle-but-healthy socket.
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }
}

/** `contentOrNullSafe` avoids throwing on a JSON `null` literal. */
private fun JsonPrimitive.contentOrNullSafe(): String? = if (this is kotlinx.serialization.json.JsonNull) null else content
