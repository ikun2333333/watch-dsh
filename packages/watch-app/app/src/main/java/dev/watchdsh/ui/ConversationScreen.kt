package dev.watchdsh.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material3.AlertDialog
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.Card
import androidx.wear.compose.material3.CircularProgressIndicator
import androidx.wear.compose.material3.Icon
import androidx.wear.compose.material3.LinearProgressIndicator
import androidx.wear.compose.material3.LinearProgressIndicatorDefaults
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.Text
import dev.watchdsh.net.LinkState
import dev.watchdsh.voice.VoicePhase
import dev.watchdsh.voice.rememberVoiceCapture
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.first

/**
 * How many lines of one message to lay out.
 *
 * Generous enough that a normal reply is shown whole on a watch, and low enough
 * that one enormous message cannot dominate the frame. The full text is on the
 * PC, so truncating the view is not losing anything.
 */
private const val MAX_MESSAGE_LINES = 40

/**
 * The conversation.
 *
 * Reading is the primary activity, so the transcript fills the screen and the
 * actions sit at the bottom: speak (or type, through the same system input
 * activity) and stop. While a turn runs the primary action becomes stop, because
 * that is the only thing a waiting user wants.
 *
 * Streamed text renders separately from committed messages and is replaced once
 * the committed version arrives, so a dropped connection can never leave a
 * half-received reply looking final.
 */
@Composable
fun ConversationScreen(
    state: UiState,
    onBack: () -> Unit,
    onSend: (String) -> Unit,
    onCancel: () -> Unit,
    onVoiceResult: (String) -> Unit,
    onVoiceMessage: (String) -> Unit,
    onType: (String) -> Unit,
    onAllow: (String) -> Unit,
    onReject: (String) -> Unit,
) {
    val listState = rememberScalingLazyListState()

    /**
     * Whether the newest text should be kept in view.
     *
     * True until the reader scrolls up, and true again once they return to the
     * bottom. A reply streams in a word at a time and the screen had no scrolling of
     * its own at all, so on a watch the reader had to chase the text with a finger
     * while it was being written - the one moment they are most likely to be watching.
     *
     * Following is suspended the instant the reader takes control, because a view
     * that yanks itself back down while someone is reading is worse than one that
     * never moved: it makes the transcript unreadable rather than merely inconvenient.
     */
    var follow by remember { mutableStateOf(true) }

    LaunchedEffect(listState) {
        snapshotFlow { listState.isScrollInProgress }
            // The first emission is the state at subscription, not a gesture, and
            // treating it as one would decide "the reader scrolled away" on arrival.
            .drop(1)
            .filter { !it }
            .collect {
                // At the bottom means canScrollForward is false. Re-enabling on that
                // condition rather than on a button is what makes reading back through
                // a reply and then following it again take no deliberate action.
                follow = !listState.canScrollForward
            }
    }

    // Keyed on the size of the transcript and the length of the last piece of text,
    // not on the transcript itself: while a reply streams, the message list is rebuilt
    // on every flush, and keying on that would restart this effect constantly. The
    // count and the length only change when there is actually something new to show.
    val lastMessageLength = state.messages.lastOrNull()?.text?.length ?: 0
    LaunchedEffect(state.messages.size, lastMessageLength, state.streaming.length, follow) {
        if (!follow) return@LaunchedEffect
        // The item count is only known after the list has been measured once, and
        // scrolling before that has no target to scroll to.
        val count = snapshotFlow { listState.layoutInfo.totalItemsCount }.first { it > 0 }
        if (count > 0) listState.scrollToItem(count - 1)
    }

    // Voice input. Which recognizer runs is decided by the stored settings, so the
    // screen does not choose a path - it only shows the phase it is told.
    //
    // `onEditResult` is the third exit from a recording, and the reason the Type
    // button can be pressed mid-sentence: a finished transcript goes to the editor
    // instead of being sent, so a misheard word is corrected rather than resubmitted.
    val voice = rememberVoiceCapture(
        settings = state.settings,
        onResult = onVoiceResult,
        onMessage = { message -> onVoiceMessage(message) },
        onEditResult = onType,
    )

    // A pending approval blocks the agent, so it is presented as a dialog rather
    // than buried in the list.
    val pending = state.approvals.firstOrNull()
    if (pending != null) {
        AlertDialog(
            visible = true,
            onDismissRequest = { /* An unanswered approval stays until it is decided or withdrawn. */ },
            title = { Text("Allow ${pending.toolName}?") },
            // Wear's AlertDialog takes its body as plain text, not a composable.
            text = {
                Text(
                    text = pending.failure ?: pending.reason ?: "The agent needs permission to continue.",
                    style = MaterialTheme.typography.bodySmall,
                )
            },
            confirmButton = {
                Button(onClick = { onAllow(pending.approvalId) }, enabled = !pending.answering) {
                    Icon(AppIcons.Check, contentDescription = null, modifier = Modifier.size(18.dp))
                    Text("Once")
                }
            },
            dismissButton = {
                Button(onClick = { onReject(pending.approvalId) }, enabled = !pending.answering) {
                    Icon(AppIcons.Close, contentDescription = null, modifier = Modifier.size(18.dp))
                    Text("Reject")
                }
            },
        )
    }

    // The padding the scaffold hands over is what keeps content clear of the round
    // edge and the system time chip at the top. It was being discarded here, which
    // on a round display means the first card can sit under the clock and the last
    // can run off the bottom curve.
    ScreenScaffold(scrollState = listState) { contentPadding ->
        ScalingLazyColumn(
            state = listState,
            modifier = Modifier.fillMaxWidth(),
            contentPadding = contentPadding,
            // Autocentering snaps the focused item to the middle of the display, which
            // is wrong for a transcript in two ways: scrolling to the last item puts it
            // in the centre of the screen instead of at the bottom, leaving a gap where
            // the next line will appear, and every arriving line would re-centre the
            // list under the reader. Normal scroll geometry is what following needs.
            autoCentering = null,
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            item {
                Card(onClick = onBack, modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 4.dp)) {
                        Text(
                            text = state.currentTitle.ifBlank { "Session" },
                            style = MaterialTheme.typography.titleSmall,
                            maxLines = 1,
                        )
                        Text(
                            text = activityLine(state),
                            style = MaterialTheme.typography.bodySmall,
                            color = if (state.link == LinkState.Connected) {
                                MaterialTheme.colorScheme.onSurfaceVariant
                            } else {
                                MaterialTheme.colorScheme.error
                            },
                            maxLines = 2,
                        )
                    }
                }
            }

            if (state.messages.isEmpty() && state.streaming.isEmpty()) {
                item {
                    Text(
                        text = "Tap Speak to send a request.",
                        style = MaterialTheme.typography.bodySmall,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                    )
                }
            }

            items(state.messages, key = { it.id }) { message ->
                MessageCard(message)
            }

            if (state.streaming.isNotEmpty()) {
                item {
                    MessageCard(
                        ChatMessage(id = "streaming", fromUser = false, text = state.streaming),
                        streaming = true,
                    )
                }
            }

            if (state.activity.running) {
                item {
                    Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(modifier = Modifier.size(24.dp))
                    }
                }
            }

            // Words appearing while the user is still speaking. Without this the
            // streaming recognizer looks identical to the system one until the very
            // end, which hides the thing it was chosen for.
            if (voice.phase == VoicePhase.Recording || voice.partial.isNotEmpty()) {
                item {
                    Card(modifier = Modifier.fillMaxWidth()) {
                        Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 4.dp)) {
                            Text(
                                text = when {
                                    voice.phase == VoicePhase.Transcribing -> "Recognizing..."
                                    voice.partial.isNotEmpty() -> voice.partial
                                    else -> "Listening..."
                                },
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.primary,
                            )
                            if (voice.phase == VoicePhase.Recording) {
                                LevelBar(voice.level)
                            }
                        }
                    }
                }
            }

            item {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Button(
                        onClick = {
                            when {
                                state.activity.running -> onCancel()
                                voice.phase == VoicePhase.Recording -> voice.stop()
                                voice.phase == VoicePhase.Transcribing -> Unit
                                else -> voice.start()
                            }
                        },
                        modifier = Modifier.weight(1f),
                    ) {
                        when {
                            state.activity.running -> {
                                Icon(AppIcons.Close, contentDescription = null, modifier = Modifier.size(18.dp))
                                Text("Stop")
                            }
                            voice.phase == VoicePhase.Recording -> {
                                Icon(AppIcons.Close, contentDescription = null, modifier = Modifier.size(18.dp))
                                Text("Finish")
                            }
                            voice.phase == VoicePhase.Transcribing -> Text("Working...")
                            else -> {
                                Icon(AppIcons.Mic, contentDescription = null, modifier = Modifier.size(18.dp))
                                Text("Speak")
                            }
                        }
                    }

                    // Type instead of talk.
                    //
                    // Mid-recording this takes the route that ends in the editor
                    // rather than the one that sends, so the words already recognized
                    // arrive in a field the user can correct. Sending them instead
                    // would post a sentence that was, by the very act of reaching for
                    // the keyboard, suspected of being wrong.
                    Button(
                        onClick = {
                            if (voice.phase == VoicePhase.Recording) {
                                voice.stopToEdit()
                            } else {
                                onType("")
                            }
                        },
                        enabled = voice.phase != VoicePhase.Transcribing,
                        modifier = Modifier.weight(1f),
                    ) {
                        Text("Type", maxLines = 1)
                    }
                }
            }

            item {
                Button(onClick = onBack, modifier = Modifier.fillMaxWidth()) {
                    Text("Sessions")
                }
            }
        }
    }
}

/**
 * A bar for the microphone level.
 *
 * It exists because "listening" and "the microphone is dead" look identical on a
 * watch otherwise, and that ambiguity is exactly what a user hits when the
 * microphone is held by another app or permission was never granted.
 *
 * Wear M3's own indicator rather than two stacked, clipped Boxes. It is already the
 * right thing semantically - a track with a progress segment - and the rounded ends,
 * the primary/container colours and the stroke token all come with it instead of
 * being restated here. The previous version also recomputed a `Dp` width and rebuilt
 * two modifiers on every level emission, which arrives about twelve times a second.
 */
@Composable
private fun LevelBar(level: Float) {
    LinearProgressIndicator(
        progress = { level.coerceIn(0f, 1f) },
        strokeWidth = LinearProgressIndicatorDefaults.StrokeWidthSmall,
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 4.dp),
    )
}

/** One message bubble; the streaming one is labelled as provisional. */@Composable
private fun MessageCard(message: ChatMessage, streaming: Boolean = false) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 4.dp)) {
            Text(
                text = when {
                    message.fromUser -> "You"
                    streaming -> "Replying"
                    else -> "Agent"
                },
                style = MaterialTheme.typography.labelSmall,
                color = if (message.fromUser) {
                    MaterialTheme.colorScheme.tertiary
                } else {
                    MaterialTheme.colorScheme.primary
                },
            )
            Text(
                text = message.text.ifBlank { "..." },
                style = MaterialTheme.typography.bodyMedium,
                // A cap, because a single committed message can be long and the
                // scaling list lays text out as it scrolls. Without it one very
                // long message makes scrolling stutter on a watch.
                maxLines = MAX_MESSAGE_LINES,
                overflow = TextOverflow.Ellipsis,
            )
            message.usage?.let { usage ->
                Text(text = usage, style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}

/** The one-line activity summary shown under the session title. */
private fun activityLine(state: UiState): String {
    val activity = state.activity
    return when {
        activity.toolName != null && activity.detail != null -> "${activity.toolName}: ${activity.detail}"
        activity.toolName != null -> "Running ${activity.toolName}"
        activity.running -> "Working"
        state.link != LinkState.Connected -> state.link.label()
        else -> "Ready"
    }
}
