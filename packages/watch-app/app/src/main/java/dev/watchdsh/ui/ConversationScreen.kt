package dev.watchdsh.ui

import android.app.Activity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
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
import dev.watchdsh.voice.VoiceInput

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
    onAllow: (String) -> Unit,
    onReject: (String) -> Unit,
) {
    val listState = rememberScalingLazyListState()

    // The system input activity handles both voice and typing and returns the
    // recognized text as an activity result.
    val voiceLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            VoiceInput.extractText(result.data)?.let(onVoiceResult)
        }
    }

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

            item {
                Button(
                    onClick = {
                        if (state.activity.running) onCancel()
                        else VoiceInput.launch(voiceLauncher, "Ask the agent")
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    if (state.activity.running) {
                        Icon(AppIcons.Close, contentDescription = null, modifier = Modifier.size(18.dp))
                        Text("Stop")
                    } else {
                        Icon(AppIcons.Mic, contentDescription = null, modifier = Modifier.size(18.dp))
                        Text("Speak")
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

/** One message bubble; the streaming one is labelled as provisional. */
@Composable
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
