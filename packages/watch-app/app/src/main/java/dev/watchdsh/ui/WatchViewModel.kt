package dev.watchdsh.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.watchdsh.data.ConfigFile
import dev.watchdsh.data.Diag
import dev.watchdsh.data.Settings
import dev.watchdsh.data.SettingsStore
import dev.watchdsh.net.BridgeEvent
import dev.watchdsh.net.BridgeException
import dev.watchdsh.net.BridgeLink
import dev.watchdsh.net.ConnectionConfig
import dev.watchdsh.net.DiscoveredBridge
import dev.watchdsh.net.Discovery
import dev.watchdsh.net.LinkState
import dev.watchdsh.net.WifiKeeper
import dev.watchdsh.protocol.BridgeStatus
import dev.watchdsh.protocol.SessionRow
import dev.watchdsh.protocol.TranscriptEntry
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** How often buffered streamed text is published; roughly a readable cadence. */
private const val STREAM_FLUSH_MS = 100L

/** How long to wait for the link to come up during pairing. */
private const val PAIRING_WAIT_MS = 20_000L

/** A pause so the relay's ready frame lands before the pairing request is sent. */
private const val READY_FRAME_GRACE_MS = 300L

/** One line of the conversation as the watch shows it. */
data class ChatMessage(
    val id: String,
    val fromUser: Boolean,
    val text: String,
    val usage: String? = null,
)

/** A pending approval, plus whether this watch is currently answering it. */
data class PendingApproval(
    val approvalId: String,
    val toolName: String,
    val reason: String?,
    val answering: Boolean = false,
    val failure: String? = null,
)

/** The activity line: what the agent is doing right now. */
data class Activity(
    val running: Boolean = false,
    val toolName: String? = null,
    val detail: String? = null,
)

/**
 * Everything the UI renders.
 *
 * `streaming` is deliberately separate from `messages`: streamed deltas are
 * advisory, and the authoritative text replaces them when the assistant message
 * commits. Keeping them apart means a dropped connection can never leave a
 * half-received message looking final.
 */
data class UiState(
    val settings: Settings = Settings(),
    val link: LinkState = LinkState.Disconnected,
    val status: BridgeStatus? = null,
    val sessions: List<SessionRow> = emptyList(),
    val currentSessionId: String? = null,
    val currentTitle: String = "",
    val messages: List<ChatMessage> = emptyList(),
    val streaming: String = "",
    val activity: Activity = Activity(),
    val approvals: List<PendingApproval> = emptyList(),
    val notice: String? = null,
    val lastError: String? = null,
    /** Bridges found on the local network, newest scan wins. */
    val discovered: List<DiscoveredBridge> = emptyList(),
    /** Whether a scan is in flight, so the button can say so. */
    val scanning: Boolean = false,
)

/**
 * Owns the link and folds its events into [UiState].
 *
 * All protocol details stay in [BridgeLink]; this class decides what a watch
 * user sees and what a tap does.
 */
class WatchViewModel(application: Application) : AndroidViewModel(application) {
    private val settingsStore = SettingsStore(application)
    private val link = BridgeLink(
        scope = viewModelScope,
        // Held only while a socket is open; a watch otherwise suspends its Wi-Fi
        // seconds into an idle connection.
        wifiKeeper = WifiKeeper(application),
    ).apply {
        // A release build has no readable logcat, so transport failures are
        // recorded on the device where `adb pull` can reach them.
        observer = { message -> Diag.log(getApplication(), "link: $message") }
    }

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    /**
     * Streamed assistant text that has not been published yet.
     *
     * The model's deltas arrive far faster than a watch can usefully redraw, so
     * they accumulate here and are published at [STREAM_FLUSH_MS] intervals.
     */
    private val streamBuffer = StringBuilder()
    private var streamFlush: Job? = null

    init {
        Diag.clear(getApplication())
        Diag.log(getApplication(), "start")

        // An imported config file is a one-shot seed for first run, applied before
        // anything else so a pushed config behaves exactly like a manual entry.
        viewModelScope.launch {
            ConfigFile.read(getApplication())?.let { imported ->
                Diag.log(getApplication(), "importing config for pc=${imported.pcId}")
                settingsStore.saveConnection(
                    imported.relayUrl,
                    imported.relayToken,
                    imported.pairingSecret,
                    imported.pcId,
                )
                // It holds a credential; keeping it on external storage would leave
                // it where a later `adb pull` could still read it.
                ConfigFile.consume(getApplication())
                Diag.log(getApplication(), "config imported and consumed")
            }
        }
        // Settings drive the link: saving them is what (re)connects. Only distinct
        // values are acted on, so repeated DataStore emissions cannot cause
        // repeated reconnects.
        viewModelScope.launch {
            settingsStore.settings.distinctUntilChanged().collect { settings ->
                _state.update { it.copy(settings = settings) }
                if (settings.isConfigured) {
                    val current = link.state.value
                    if (current == LinkState.Disconnected) {
                        connectPreferred(settings)
                    }
                }
            }
        }
        viewModelScope.launch {
            link.state.collect { linkState ->
                Diag.log(getApplication(), "link=$linkState")
                _state.update { it.copy(link = linkState) }
            }
        }
        viewModelScope.launch {
            link.events.collect { event -> onEvent(event) }
        }
    }

    /**
     * Connect to the first address that works.
     *
     * Two addresses may be stored because neither is right in both places: the
     * local one is faster at home and works with no internet, and only the public
     * one is reachable away. Trying them in order needs no user choice and no mode
     * flag that could disagree with the addresses actually stored.
     *
     * This deliberately does not use discovery to decide where it is. A broadcast
     * only reaches the local network, which makes it a natural way to detect "at
     * home" - but routers that drop traffic between wireless clients are common
     * enough that this project measured one, where the same watch that reaches the
     * PC over TCP could not deliver a broadcast to it at all. A decision that
     * depends on a packet the network may discard is a decision that silently goes
     * the wrong way.
     *
     * A stale local address costs one failed attempt, so a DHCP change repairs
     * itself: the local try fails and the public one carries the connection.
     */
    private suspend fun connectPreferred(settings: Settings) {
        val candidates = settings.candidates
        if (candidates.isEmpty()) return
        Diag.log(getApplication(), "connecting; ${candidates.size} address(es) to try")
        link.connect(settings.toConnectionConfig(candidates.first()), candidates.drop(1))
    }

    /** An address without its query, for logs that are readable on the device. */
    private fun redact(url: String): String = url.substringBefore('?')

    /** Persist new connection settings and connect with them. */
    fun saveConnection(relayUrl: String, relayToken: String, pairingSecret: String, pcId: String) {
        viewModelScope.launch {
            settingsStore.saveConnection(relayUrl, relayToken, pairingSecret, pcId)
            link.connect(
                Settings(relayUrl.trim(), relayToken.trim(), pairingSecret.trim(), pcId.trim()).toConnectionConfig(),
            )
        }
    }

    /**
     * Scan the local network for bridges.
     *
     * On Wi-Fi this removes the need to type anything: the bridge answers with the
     * relay address, token, and pc id, and the pairing secret follows over the
     * authenticated connection.
     */
    fun scanForBridges() {
        viewModelScope.launch {
            _state.update { it.copy(scanning = true, lastError = null) }
            try {
                if (!Discovery.hasLocalNetwork()) {
                    _state.update {
                        it.copy(
                            scanning = false,
                            discovered = emptyList(),
                            lastError = "No Wi-Fi network. Connect the watch to Wi-Fi, then scan again.",
                        )
                    }
                    return@launch
                }
                // The address this watch last connected to is probed by unicast as
                // well as broadcast. On a router that drops traffic between
                // wireless clients, broadcast never arrives while unicast does, so
                // without this the app could not rediscover a PC it had already
                // used - which is exactly the symptom that led here.
                val remembered = _state.value.settings.relayUrl
                    .removePrefix("ws://").removePrefix("wss://")
                    .substringBefore('/').substringBefore(':')
                    .takeIf { it.isNotBlank() }
                val found = Discovery.findBridges(
                    context = getApplication(),
                    knownHosts = listOfNotNull(remembered),
                )
                _state.update {
                    it.copy(
                        scanning = false,
                        discovered = found,
                        // Discovery can legitimately fail while manual entry still
                        // works - a router that drops broadcasts, or a watch on a
                        // different band - so the fallback is named here rather
                        // than leaving the user with only a failure.
                        lastError = if (found.isEmpty()) {
                            "No PC answered. Check both are on the same Wi-Fi, or enter the address below."
                        } else {
                            null
                        },
                    )
                }
            } catch (error: Exception) {
                _state.update { it.copy(scanning = false, lastError = error.message ?: "Scan failed") }
            }
        }
    }

    /**
     * Pair with a discovered bridge.
     *
     * Everything is already known except the pairing secret, and the bridge hands
     * that over once the relay has authenticated the relay token from discovery —
     * so this is the whole pairing flow, with nothing typed.
     */
    fun pairWith(bridge: DiscoveredBridge) {
        viewModelScope.launch {
            _state.update { it.copy(scanning = true, lastError = null) }
            try {
                // Connect with no secret, which is the signal to pair.
                settingsStore.saveConnection(bridge.relayUrl, bridge.relayToken, "", bridge.pcId)
                link.connect(
                    ConnectionConfig(
                        url = bridge.relayUrl,
                        token = bridge.relayToken,
                        pairingSecret = "",
                        pcId = bridge.pcId,
                    ),
                )
                // Wait for the socket, then ask for the secret.
                val secret = waitForPairingSecret()
                if (secret == null) {
                    _state.update { it.copy(scanning = false, lastError = "The PC did not answer the pairing request.") }
                    return@launch
                }
                settingsStore.saveConnection(bridge.relayUrl, bridge.relayToken, secret, bridge.pcId)
                _state.update { it.copy(scanning = false, lastError = null) }
            } catch (error: Exception) {
                _state.update { it.copy(scanning = false, lastError = error.message ?: "Pairing failed") }
            }
        }
    }

    /**
     * Wait until the link is up, then adopt the pairing secret.
     *
     * The socket opens asynchronously, so this waits on the link state rather than
     * assuming the connection is ready the moment `connect` returns. It also gives
     * the relay's `ready` frame a moment to arrive, since the pairing request must
     * echo the connection id that frame carries.
     */
    private suspend fun waitForPairingSecret(): String? {
        Diag.log(getApplication(), "pairing: waiting for the link")
        val connected = withTimeoutOrNull(PAIRING_WAIT_MS) {
            link.state.first { it == LinkState.Connected || it == LinkState.Unauthorized }
        }
        Diag.log(getApplication(), "pairing: link reached $connected")
        if (connected != LinkState.Connected) {
            _state.update { it.copy(lastError = "The watch could not reach the relay.") }
            return null
        }
        // The ready frame usually arrives with the socket, but it is a separate
        // message; a short pause keeps this from racing it.
        delay(READY_FRAME_GRACE_MS)
        return try {
            val secret = link.adoptPairingSecret()
            Diag.log(getApplication(), "pairing: absorbed secret=${secret?.length ?: 0}chars")
            secret
        } catch (error: BridgeException) {
            Diag.log(getApplication(), "pairing failed: ${error.code} ${error.message}")
            _state.update { it.copy(lastError = error.message) }
            null
        }
    }

    /** Forget the configuration and drop the link. */
    fun forgetConnection() {
        viewModelScope.launch {
            link.disconnect()
            settingsStore.clear()
            _state.value = UiState()
        }
    }

    /** Force a reconnect; useful after the PC side restarts. */
    fun reconnect() {
        val settings = _state.value.settings
        if (settings.isConfigured) link.connect(settings.toConnectionConfig())
    }

    /** Re-read the session list. */
    fun refreshSessions() {
        viewModelScope.launch { runCatching { link.refreshSessions() } }
    }

    /** Open a session and show its transcript. */
    fun openSession(sessionId: String) {
        viewModelScope.launch {
            try {
                link.subscribe(sessionId)
                val transcript = link.transcript(sessionId)
                _state.update {
                    it.copy(
                        currentSessionId = sessionId,
                        currentTitle = it.sessions.firstOrNull { row -> row.id == sessionId }?.title.orEmpty(),
                        messages = transcript.entries.orEmpty().map(::toMessage),
                        streaming = "",
                        lastError = null,
                    )
                }
                settingsStore.setLastSession(sessionId)
            } catch (error: BridgeException) {
                _state.update { it.copy(lastError = error.message) }
            }
        }
    }

    /** Start a brand-new session and open it. */
    fun startNewSession() {
        viewModelScope.launch {
            try {
                val created = link.openSession()
                val id = created.sessionId ?: return@launch
                _state.update {
                    it.copy(
                        currentSessionId = id,
                        currentTitle = created.title ?: "New session",
                        messages = emptyList(),
                        streaming = "",
                        lastError = null,
                    )
                }
                settingsStore.setLastSession(id)
                refreshSessions()
            } catch (error: BridgeException) {
                _state.update { it.copy(lastError = error.message) }
            }
        }
    }

    /** Send a prompt, echoing it locally so the watch reacts immediately. */
    fun send(text: String) {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return
        val sessionId = _state.value.currentSessionId
        if (sessionId == null) {
            _state.update { it.copy(lastError = "Open a session first") }
            return
        }
        _state.update {
            it.copy(
                messages = it.messages + ChatMessage(id = "local-${it.messages.size}", fromUser = true, text = trimmed),
                streaming = "",
                activity = Activity(running = true),
                lastError = null,
            )
        }
        viewModelScope.launch {
            try {
                link.send(sessionId, trimmed)
            } catch (error: BridgeException) {
                _state.update { it.copy(lastError = error.message, activity = Activity()) }
            }
        }
    }

    /** Interrupt the running turn. */
    fun cancel() {
        val sessionId = _state.value.currentSessionId ?: return
        viewModelScope.launch {
            runCatching { link.cancel(sessionId) }
        }
    }

    /** Allow a pending approval once. */
    fun allow(approvalId: String) = answer(approvalId) { link.allowOnce(it) }

    /** Reject a pending approval. */
    fun reject(approvalId: String) = answer(approvalId) { link.reject(it) }

    private fun answer(approvalId: String, action: suspend (String) -> Unit) {
        markAnswering(approvalId, true, null)
        viewModelScope.launch {
            try {
                action(approvalId)
            } catch (error: BridgeException) {
                markAnswering(approvalId, false, error.message)
            }
        }
    }

    private fun markAnswering(approvalId: String, answering: Boolean, failure: String?) {
        _state.update { state ->
            state.copy(
                approvals = state.approvals.map { approval ->
                    if (approval.approvalId == approvalId) approval.copy(answering = answering, failure = failure)
                    else approval
                },
            )
        }
    }

    /** Dismiss the transient notice banner. */
    fun clearNotice() {
        _state.update { it.copy(notice = null, lastError = null) }
    }

    /**
     * Publish buffered streamed text at most once per [STREAM_FLUSH_MS].
     *
     * A flush is only scheduled when one is not already pending, so a burst of
     * deltas costs exactly one state update per interval rather than one per
     * delta.
     */
    private fun scheduleStreamFlush() {
        if (streamFlush?.isActive == true) return
        streamFlush = viewModelScope.launch {
            delay(STREAM_FLUSH_MS)
            publishStreamBuffer()
        }
    }

    /** Move whatever is buffered into the state in one update. */
    private fun publishStreamBuffer() {
        if (streamBuffer.isEmpty()) return
        val chunk = streamBuffer.toString()
        streamBuffer.setLength(0)
        _state.update { state -> state.copy(streaming = state.streaming + chunk, activity = state.activity.copy(running = true)) }
    }

    /** Publish immediately, for boundaries where waiting would look wrong. */
    private fun flushStreamNow() {
        streamFlush?.cancel()
        streamFlush = null
        publishStreamBuffer()
    }

    override fun onCleared() {
        // A pending flush would otherwise touch state after the ViewModel is gone.
        streamFlush?.cancel()
        streamFlush = null
        streamBuffer.setLength(0)
        super.onCleared()
    }

    private fun onEvent(event: BridgeEvent) {
        when (event) {
            is BridgeEvent.Status -> _state.update { it.copy(status = event.status) }

            is BridgeEvent.Sessions -> _state.update { it.copy(sessions = event.rows) }

            is BridgeEvent.Session -> _state.update { state ->
                state.copy(
                    sessions = state.sessions.map { row ->
                        if (row.id == event.id) row.copy(title = event.title, running = event.running, updatedAt = event.updatedAt)
                        else row
                    },
                    currentTitle = if (state.currentSessionId == event.id) event.title else state.currentTitle,
                )
            }

            is BridgeEvent.Transcript -> {
                // Only the followed session's transcript is kept on screen.
                if (event.sessionId != _state.value.currentSessionId) return
                // The committed message supersedes anything still buffered.
                streamFlush?.cancel()
                streamFlush = null
                streamBuffer.setLength(0)
                _state.update { state ->
                    val merged = mergeTranscript(state.messages, event.entries)
                    state.copy(messages = merged, streaming = "")
                }
            }

            is BridgeEvent.Delta -> {
                if (event.sessionId != _state.value.currentSessionId) return
                if (event.reasoning) {
                    // Reasoning is summarized rather than streamed: a watch has no
                    // room for a chain of thought.
                    _state.update { it.copy(activity = it.activity.copy(running = true, detail = "Thinking…")) }
                    return
                }
                // Append to a buffer instead of the state. A model emits tens of
                // deltas a second, and publishing each one separately recomposed
                // the conversation that often; buffering makes the cost of a
                // stream independent of how fast the provider talks.
                streamBuffer.append(event.text)
                scheduleStreamFlush()
            }

            is BridgeEvent.Tool -> _state.update { state ->
                state.copy(
                    activity = if (event.state == "call") {
                        Activity(running = true, toolName = event.name, detail = event.summary)
                    } else {
                        state.activity.copy(toolName = null, detail = null)
                    },
                )
            }

            is BridgeEvent.Turn -> {
                // A turn boundary is where waiting for the flush interval would
                // leave the last words of a reply missing, so flush first.
                if (event.state != "start") flushStreamNow()
                _state.update { state ->
                    when (event.state) {
                        "start" -> state.copy(activity = Activity(running = true))
                        else -> state.copy(activity = Activity(running = false), streaming = "")
                    }
                }
            }

            is BridgeEvent.Approval -> _state.update { state ->
                val already = state.approvals.any { it.approvalId == event.approvalId }
                if (already) state
                else state.copy(
                    approvals = state.approvals + PendingApproval(event.approvalId, event.toolName, event.reason),
                )
            }

            is BridgeEvent.ApprovalClosed -> _state.update { state ->
                state.copy(approvals = state.approvals.filterNot { it.approvalId == event.approvalId })
            }

            is BridgeEvent.Notice -> _state.update { it.copy(notice = event.message) }
        }
    }

    /**
     * Append or replace transcript entries.
     *
     * The bridge re-sends a window on attach, so entries are merged by sequence
     * number: a replayed entry replaces its earlier copy instead of duplicating.
     */
    private fun mergeTranscript(existing: List<ChatMessage>, incoming: List<TranscriptEntry>): List<ChatMessage> {
        if (incoming.isEmpty()) return existing
        val bySeq = LinkedHashMap<String, ChatMessage>()
        for (message in existing) if (!message.id.startsWith("local-")) bySeq[message.id] = message
        for (entry in incoming) bySeq[entry.seq.toString()] = toMessage(entry)
        // Locally echoed prompts stay at the end until the bridge confirms them.
        return bySeq.values.toList()
    }

    private fun toMessage(entry: TranscriptEntry) = ChatMessage(
        id = entry.seq.toString(),
        fromUser = entry.kind == "user",
        text = entry.text,
        usage = entry.usage?.let { usage ->
            usage.output?.let { "↓$it" }
        },
    )
}
