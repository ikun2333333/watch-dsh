package dev.watchdsh.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material3.Card
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.Text
import dev.watchdsh.net.LinkState

/**
 * Shared building blocks.
 *
 * Screen layout comes from `ScreenScaffold`, which is Wear Material 3's per-screen
 * container: it owns the time text, the scroll indicator, and the vertical
 * centring that a round display needs, so each screen only supplies a list.
 */

/** Centred placeholder text, used for empty lists and terminal errors. */
@Composable
fun CenteredMessage(
    title: String,
    body: String? = null,
    tint: Color = MaterialTheme.colorScheme.onSurfaceVariant,
) {
    Box(
        modifier = Modifier.fillMaxSize().padding(horizontal = 18.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleSmall,
                textAlign = TextAlign.Center,
                color = tint,
            )
            if (body != null) {
                Text(
                    text = body,
                    style = MaterialTheme.typography.bodySmall,
                    textAlign = TextAlign.Center,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/** Human wording for the link state, so every screen agrees on the phrasing. */
fun LinkState.label(): String = when (this) {
    LinkState.Disconnected -> "Offline"
    LinkState.Connecting -> "Connecting…"
    LinkState.Connected -> "Connected"
    LinkState.Unauthorized -> "Token rejected"
    LinkState.Failed -> "Cannot reach PC"
}

/**
 * A one-line connection summary.
 *
 * Every list screen opens with this, so the user can always tell whether the
 * watch is actually talking to the PC before reading anything else.
 */
@Composable
fun StatusCard(state: UiState, modifier: Modifier = Modifier) {
    val dot = when (state.link) {
        LinkState.Connected -> MaterialTheme.colorScheme.primary
        LinkState.Connecting -> MaterialTheme.colorScheme.tertiary
        else -> MaterialTheme.colorScheme.error
    }
    Card(modifier = modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(horizontal = 8.dp, vertical = 6.dp)) {
            Text(
                text = state.link.label(),
                style = MaterialTheme.typography.labelMedium,
                color = dot,
            )
            val detail = state.status?.detail?.takeIf { it.isNotBlank() }
                ?: state.lastError
                ?: "Harness ${state.status?.harness ?: "unknown"}"
            Text(text = detail, style = MaterialTheme.typography.bodySmall)
        }
    }
}

/** Arrangement shared by every list screen. */
val ListArrangement = Arrangement.spacedBy(6.dp)
