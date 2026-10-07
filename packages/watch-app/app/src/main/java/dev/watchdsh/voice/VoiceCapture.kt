package dev.watchdsh.voice

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.TextFieldValue
import androidx.core.content.ContextCompat
import dev.watchdsh.data.Settings
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.supervisorScope
import android.app.Activity
import android.content.Intent
import androidx.activity.result.ActivityResultLauncher

/** What the voice button should be doing, which is what it should look like. */
enum class VoicePhase {
    /** Idle; a tap starts listening. */
    Idle,

    /** Recording; a tap stops. */
    Recording,

    /** Recorded; waiting for the transcript. */
    Transcribing,
}

/**
 * A handle to the voice capture, for the screen to drive.
 *
 * [stopToEdit] is the same recording and recognition as [stop]; only where the
 * finished text goes differs. Two exits rather than two implementations, because
 * "record, stream, settle on one sentence" is identical either way - only the last
 * step changes.
 */
data class VoiceCaptureHandle(
    val start: () -> Unit,
    val stop: () -> Unit,
    val stopToEdit: () -> Unit,
    val phase: VoicePhase,
    /** 0..1 input level, meaningful only while [VoicePhase.Recording]. */
    val level: Float,
    /** Interim transcript, for showing words as they are recognized. */
    val partial: String,
    /** The recognizer in use, for the screen to label itself honestly. */
    val engineName: String,
)

/**
 * Voice input, with a choice of recognizer.
 *
 * Two paths, chosen by the stored engine:
 *
 *  1. **Streaming** - records here and sends frames as they fill, so text appears
 *     while the user is still speaking. Needs credentials, because the request is
 *     signed locally.
 *  2. **System input activity** - the platform path, no setup and no permissions
 *     beyond what it asks for itself, but it only returns text once it is done,
 *     and it uses whichever recognition service the watch has installed.
 *
 * The second is the fallback and the default; the first exists because that
 * service frequently does not work on a watch, and when it does not, the app
 * cannot tell whether the audio was ever heard.
 *
 * @param onResult - a finished transcript, to act on immediately.
 * @param onMessage - a sentence to show the user when something went wrong.
 * @param onEditResult - a finished transcript to put in front of the user for
 *   correction instead of acting on. Speech is misheard often, and on a watch
 *   editing one word beats saying the whole thing again.
 * @param onPartial - each interim transcript, for a screen that shows the words as
 *   they arrive. Only the streaming recognizer produces these; the system one
 *   answers once, at the end. Distinct from reading [VoiceCaptureHandle.partial]
 *   because that re-reads the whole screen on every word, and a screen with a text
 *   field in it should be told instead of recomposed.
 */
@Composable
fun rememberVoiceCapture(
    settings: Settings,
    onResult: (String) -> Unit,
    onMessage: (String) -> Unit,
    onEditResult: (String) -> Unit = {},
    onPartial: (String) -> Unit = {},
): VoiceCaptureHandle {
    val context = LocalContext.current
    val latestResult by rememberUpdatedState(onResult)
    val latestMessage by rememberUpdatedState(onMessage)
    val latestEdit by rememberUpdatedState(onEditResult)
    val latestPartial by rememberUpdatedState(onPartial)
    val latestSettings by rememberUpdatedState(settings)

    val scope = rememberCoroutineScope()
    val recorder = remember { AudioRecorder() }
    val recognizer = remember { XfyunRecognizer() }

    var phase by remember { mutableStateOf(VoicePhase.Idle) }
    var liveText by remember { mutableStateOf("") }
    var job by remember { mutableStateOf<Job?>(null) }

    /**
     * Where this recording's transcript should go once it exists.
     *
     * A flag rather than two flows, because everything up to the last step is the
     * same for both exits.
     */
    var editIntent by remember { mutableStateOf(false) }

    val level by recorder.level.collectAsState()

    /** The single exit for a transcript; the two destinations split only here. */
    fun deliver(text: String) {
        if (text.isBlank()) {
            latestMessage("did not catch that, try again")
            return
        }
        if (editIntent) latestEdit(text) else latestResult(text)
    }

    /**
     * Record and recognize concurrently.
     *
     * Wrapped in `supervisorScope` deliberately. In a plain `coroutineScope` a
     * failure inside `async` cancels the whole scope immediately, and the scope
     * then rethrows that failure even when the caller caught it at `await()` -
     * which surfaces in `rememberCoroutineScope()`'s launch, has no exception
     * handler, and takes the process down. The user sees the app disappear.
     * `supervisorScope` keeps a child's failure local, so it reaches the caller as
     * a value at `await()` instead.
     *
     * The recognition failure is additionally wrapped in a Result, so it is never
     * thrown at all - cancellation excepted.
     */
    suspend fun runStreaming(config: Settings) = supervisorScope {
        val frames = Channel<ByteArray>(Channel.UNLIMITED)

        val recognition = async {
            try {
                Result.success(
                    recognizer.transcribe(config.asrCredentials, frames) { text ->
                        liveText = text
                        latestPartial(text)
                    },
                )
            } catch (e: CancellationException) {
                // Cancellation has to propagate, or the recording never stops and
                // the socket never closes.
                throw e
            } catch (e: Throwable) {
                // A failed recognition is an expected outcome - no network, bad
                // credentials, quota gone - so it travels as a value rather than
                // being allowed to reach the parent scope.
                Result.failure(e)
            }
        }

        // Stop recording as soon as recognition fails.
        //
        // Without this the connection can be dead while the user is still watching
        // a "listening" screen, and nothing is said until they stop the recording
        // themselves - tens of seconds in which the UI shows no change at all,
        // which reads as a hang. Reported hangs are almost always this.
        val abortRecorder = launch {
            runCatching { recognition.await() }
                .onSuccess { result -> if (result.isFailure) recorder.requestStop() }
        }

        val recorded: Result<ByteArray> = try {
            Result.success(recorder.record(onFrame = { frames.trySend(it) }))
        } catch (e: CancellationException) {
            recognition.cancel()
            abortRecorder.cancel()
            frames.close()
            phase = VoicePhase.Idle
            throw e
        } catch (e: Throwable) {
            Result.failure(e)
        }

        abortRecorder.cancel()
        // Closing the frame channel is how the recognizer is told speech ended; it
        // then sends the last of the transcript.
        frames.close()

        val speech = recognition.await()

        if (recorded.isFailure) {
            phase = VoicePhase.Idle
            // The recognition reason is the real one when recognition failed first:
            // the recorder was just cut short, so its own error would be "too
            // short" and would bury "cannot reach the recognizer".
            //
            // Exception: if the user asked to edit and some text already arrived,
            // hand that over - retyping a whole sentence on a watch is worse than
            // an error message.
            if (editIntent && liveText.isNotBlank()) {
                latestEdit(liveText)
            } else {
                latestMessage(readable(speech.exceptionOrNull() ?: recorded.exceptionOrNull()))
            }
            return@supervisorScope
        }

        phase = VoicePhase.Transcribing
        try {
            val error = speech.exceptionOrNull()
            when {
                error is CancellationException -> throw error
                error != null ->
                    if (editIntent && liveText.isNotBlank()) latestEdit(liveText)
                    else latestMessage(readable(error))
                else -> deliver(speech.getOrThrow())
            }
        } finally {
            phase = VoicePhase.Idle
        }
    }

    /** Record, recognize, hand over the text. The screen only watches [phase]. */
    fun beginRecording() {
        if (phase != VoicePhase.Idle) return
        phase = VoicePhase.Recording
        liveText = ""
        // Reset per recording. Without this, a previous attempt that chose "edit"
        // but never delivered would make this attempt silently not send.
        editIntent = false

        job = scope.launch {
            // Read through the updated-state holder rather than capturing the
            // parameter: the lambda outlives this composition, and the user may
            // have just changed the engine and come straight back to the
            // microphone.
            val current = latestSettings
            if (current.asrReady) {
                runStreaming(current)
            } else {
                latestMessage("no recognizer is configured, pick one in settings")
            }
        }
    }

    // The system path: the platform's input activity, which needs no permission
    // from us because it collects the audio itself.
    val systemLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        if (result.resultCode != Activity.RESULT_OK) return@rememberLauncherForActivityResult
        VoiceInput.extractText(result.data)?.let { deliver(it) }
            ?: latestMessage("did not catch that, try again")
    }
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) beginRecording() else latestMessage("without the microphone there is no voice input")
    }

    fun start() {
        if (phase != VoicePhase.Idle) return
        if (settings.asrReady) {
            if (hasRecordPermission(context)) beginRecording()
            else permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
        } else if (VoiceInput.isAvailable(context)) {
            systemLauncher.launch(VoiceInput.createIntent(context, "Ask the agent"))
        } else {
            // Nothing on this watch can do it, and saying so beats a button that
            // opens nothing.
            latestMessage("this watch has no voice input; set up a streaming recognizer in settings")
        }
    }

    fun stop() {
        if (phase == VoicePhase.Recording) recorder.requestStop()
    }

    /**
     * Finish recording but keep the text for editing.
     *
     * The recording is allowed to finish and the last transcript to arrive rather
     * than leaving with the interim text: navigating away disposes this
     * composable, the recorder would be cut off, and the recognizer's final
     * fragment would never be collected - the user would be handed half a
     * sentence. The wait is the same one "stop and send" already pays.
     */
    fun stopToEdit() {
        if (phase == VoicePhase.Recording) {
            editIntent = true
            recorder.requestStop()
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            // The page was left mid-recording, so stop it explicitly: the read
            // inside record() is blocking and cancelling the coroutine does not
            // return from it, which would leave the microphone hot.
            recorder.requestStop()
            job?.cancel()
        }
    }

    return VoiceCaptureHandle(
        start = ::start,
        stop = ::stop,
        stopToEdit = ::stopToEdit,
        phase = phase,
        level = level,
        partial = liveText,
        engineName = if (settings.asrReady) "streaming" else "system",
    )
}

/** A sentence for the screen, preferring the one written for it. */
private fun readable(error: Throwable?): String = when {
    error == null -> "recognition failed"
    error is SpeechException -> error.hint
    else -> error.message ?: "recognition failed"
}

private fun hasRecordPermission(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
        PackageManager.PERMISSION_GRANTED
