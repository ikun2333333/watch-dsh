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
import androidx.wear.compose.material3.TextToggleButtonDefaults
import androidx.wear.compose.material3.TextToggleButtonShapes
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
    // Says which half is missing. "Connected" here was the bug: the relay is always
    // up, so this state used to be reported while the PC was switched off.
    LinkState.RelayOnly -> "PC not running"
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
        // Reached the relay but not the computer: worth its own colour rather than
        // the error red, because nothing about the watch's own configuration is
        // wrong and the PC being off is the ordinary case, not a failure.
        LinkState.RelayOnly -> MaterialTheme.colorScheme.tertiary
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

/**
 * Corner shapes that show which of a pair is selected, not only its colour.
 *
 * The default `TextToggleButtonDefaults.shapes()` gives every state the same pill, so
 * the only thing separating the chosen button from the other is a colour - which on a
 * watch, glanced at in bright light or by someone who is colour-blind, is not much of
 * a signal. Wear M3 keeps `variantAnimatedShapes()` for exactly this: unselected stays
 * a pill, selected extends into a rounded rectangle, and the change animates rather
 * than switching.
 */
@Composable
fun selectionToggleShapes(): TextToggleButtonShapes =
    TextToggleButtonDefaults.variantAnimatedShapes()
