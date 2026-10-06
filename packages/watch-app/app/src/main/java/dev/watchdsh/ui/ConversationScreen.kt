package dev.watchdsh.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
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
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.Text
import dev.watchdsh.net.LinkState
import dev.watchdsh.voice.VoicePhase
import dev.watchdsh.voice.rememberVoiceCapture

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
    onAllow: (String) -> Unit,
    onReject: (String) -> Unit,
) {
    val listState = rememberScalingLazyListState()

    // Voice input. Which recognizer runs is decided by the stored settings, so the
    // screen does not choose a path - it only shows the phase it is told.
    val voice = rememberVoiceCapture(
        settings = state.settings,
        onResult = onVoiceResult,
        onMessage = { message -> onVoiceMessage(message) },
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

    ScreenScaffold(scrollState = listState) {
        ScalingLazyColumn(
            state = listState,
            modifier = Modifier.fillMaxWidth(),
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
                Button(
                    onClick = {
                        when {
                            state.activity.running -> onCancel()
                            voice.phase == VoicePhase.Recording -> voice.stop()
                            voice.phase == VoicePhase.Transcribing -> Unit
                            else -> voice.start()
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
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
 */
@Composable
private fun LevelBar(level: Float) {
    val width = (level.coerceIn(0f, 1f) * 100).dp
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 4.dp)
            .height(3.dp)
            .clip(RoundedCornerShape(2.dp))
            // Wear's ColorScheme has no surfaceVariant; a dimmed muted foreground
            // is the same idea and exists in every Wear theme.
            .background(MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.3f)),
    ) {
        Box(
            modifier = Modifier
                .width(width)
                .fillMaxHeight()
                .clip(RoundedCornerShape(2.dp))
                .background(MaterialTheme.colorScheme.primary),
        )
    }
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
