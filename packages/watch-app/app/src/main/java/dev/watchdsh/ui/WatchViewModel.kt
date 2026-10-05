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

/**
 * How much of a streaming reply to keep.
 *
 * A watch screen shows a few hundred characters at a time, and the full reply is
 * committed to the transcript as soon as it arrives, so this is generous for
 * reading while keeping the string small enough that concatenating onto it stays
 * cheap.
 */
private const val STREAMING_KEEP_CHARS = 4_000

/**
 * How many transcript messages to keep on screen.
 *
 * The Harness owns the transcript; this is a reading window, not a copy. An
 * unbounded list is what a long session hands the watch, and holding all of it
 * costs memory and layout time for messages the user has long scrolled past.
 */
private const val TRANSCRIPT_KEEP_MESSAGES = 60

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
    /**
     * Whether the stored settings have been read at all.
     *
     * [settings] starts at its empty default, which is indistinguishable from a
     * watch that has genuinely never been configured. Anything that must not act
     * on "unconfigured" before the read completes - the starting screen does -
     * has to wait for this.
     */
    val settingsLoaded: Boolean = false,
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
                _state.update { it.copy(settings = settings, settingsLoaded = true) }
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
    fun saveConnection(
        relayUrl: String,
        relayToken: String,
        pairingSecret: String,
        pcId: String,
        lanRelayUrl: String = "",
    ) {
        viewModelScope.launch {
            settingsStore.saveConnection(relayUrl, relayToken, pairingSecret, pcId, lanRelayUrl)
            // Built from the same values that were just stored, so the local address
            // is tried first here too rather than only after a restart.
            connectPreferred(
                Settings(
                    relayUrl = relayUrl.trim(),
                    lanRelayUrl = lanRelayUrl.trim(),
                    relayToken = relayToken.trim(),
                    pairingSecret = pairingSecret.trim(),
                    pcId = pcId.trim(),
                ),
            )
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
                        messages = transcript.entries.orEmpty().map(::toMessage).takeLast(TRANSCRIPT_KEEP_MESSAGES),
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
        _state.update { state ->
            val grown = state.streaming + chunk
            state.copy(
                // Only the tail is kept. The whole reply is on the PC, and the
                // committed message replaces this as soon as it arrives, so the
                // watch is not the place to hold all of it. Keeping it all was
                // quadratic: `streaming + chunk` reallocates the whole string,
                // and a watch has neither the cpu nor the heap to do that several
                // times a second once a reply runs long.
                streaming = if (grown.length > STREAMING_KEEP_CHARS) {
                    grown.takeLast(STREAMING_KEEP_CHARS)
                } else {
                    grown
                },
                activity = state.activity.copy(running = true),
            )
        }
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
     *
     * The result is trimmed to a reading window. The merge builds a map of
     * everything it was given, so letting that set grow without bound means every
     * later event copies the entire session history to add one line to it.
     */
    private fun mergeTranscript(existing: List<ChatMessage>, incoming: List<TranscriptEntry>): List<ChatMessage> {
        if (incoming.isEmpty()) return existing
        val bySeq = LinkedHashMap<String, ChatMessage>()
        for (message in existing) if (!message.id.startsWith("local-")) bySeq[message.id] = message
        for (entry in incoming) bySeq[entry.seq.toString()] = toMessage(entry)
        // Locally echoed prompts stay at the end until the bridge confirms them.
        return bySeq.values.toList().takeLast(TRANSCRIPT_KEEP_MESSAGES)
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
