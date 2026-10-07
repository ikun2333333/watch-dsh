package dev.watchdsh.ui

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.Card
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.Text
import dev.watchdsh.net.LinkState
import dev.watchdsh.protocol.SessionRow
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The session list: the app's home screen.
 *
 * A session is the unit a user recognises, so each row shows the title the
 * Harness derived, when it last changed, and whether a turn is running. Pending
 * approvals are counted on the row as well, because an approval that arrives
 * while the user is elsewhere has to be findable.
 */
@Composable
fun SessionsScreen(
    state: UiState,
    onOpen: (String) -> Unit,
    onNew: () -> Unit,
    onRefresh: () -> Unit,
    onReconnect: () -> Unit,
    onSettings: () -> Unit,
) {
    val listState = rememberScalingLazyListState()

    // The scaffold's padding keeps the status card clear of the time chip and the
    // last row clear of the bottom curve; it was being discarded.
    ScreenScaffold(scrollState = listState) { contentPadding ->
        ScalingLazyColumn(
            state = listState,
            modifier = Modifier.fillMaxWidth(),
            contentPadding = contentPadding,
            verticalArrangement = ListArrangement,
        ) {
            item { StatusCard(state) }

            if (state.link != LinkState.Connected) {
                item {
                    Button(onClick = onReconnect, modifier = Modifier.fillMaxWidth()) {
                        Text("Reconnect")
                    }
                }
            }

            item {
                Button(onClick = onNew, modifier = Modifier.fillMaxWidth()) {
                    Text("New session")
                }
            }

            if (state.sessions.isEmpty()) {
                item {
                    Card(modifier = Modifier.fillMaxWidth()) {
                        Text(
                            text = if (state.link == LinkState.Connected) {
                                "No sessions yet. Start one above."
                            } else {
                                "Waiting for the PC bridge."
                            },
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp),
                        )
                    }
                }
            }

            for (row in state.sessions) {
                item(key = row.id) {
                    SessionCard(row = row, onClick = { onOpen(row.id) })
                }
            }

            item {
                Button(onClick = onRefresh, modifier = Modifier.fillMaxWidth()) {
                    Text("Refresh")
                }
            }
            item {
                Button(onClick = onSettings, modifier = Modifier.fillMaxWidth()) {
                    Text("Settings")
                }
            }
        }
    }
}

/** One session row. */
@Composable
private fun SessionCard(row: SessionRow, onClick: () -> Unit) {
    Card(onClick = onClick, modifier = Modifier.fillMaxWidth()) {
        androidx.compose.foundation.layout.Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 4.dp),
        ) {
            Text(
                text = row.title.ifBlank { "Untitled session" },
                style = MaterialTheme.typography.titleSmall,
                maxLines = 2,
            )
            val badge = buildList {
                if (row.running) add("running")
                if (row.approvals > 0) add("${row.approvals} approval(s)")
                if (row.blank) add("empty")
                add(relativeTime(row.updatedAt))
            }.joinToString(" · ")
            Text(
                text = badge,
                style = MaterialTheme.typography.bodySmall,
                color = if (row.approvals > 0) {
                    MaterialTheme.colorScheme.error
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
            )
        }
    }
}

/**
 * A coarse "how long ago" label.
 *
 * The list is read at a glance, so minutes and hours beat an exact timestamp; the
 * date formatter is only the day-level fallback.
 */
private fun relativeTime(updatedAt: Long): String {
    if (updatedAt <= 0) return "unknown"
    val minutes = (System.currentTimeMillis() - updatedAt) / 60_000
    return when {
        minutes < 1 -> "just now"
        minutes < 60 -> "${minutes}m ago"
        minutes < 60 * 24 -> "${minutes / 60}h ago"
        else -> dayFormat.format(Date(updatedAt))
    }
}

/**
 * The day-level formatter, built once.
 *
 * It used to be constructed inside [relativeTime], which is called per row - and the
 * whole list recomposes on every stream flush while a turn is running, so this was a
 * formatter allocated per row per frame. `SimpleDateFormat` is also not thread-safe,
 * so sharing one instance is only safe because it is read from the UI thread alone;
 * the single definition is the other reason, since a second one elsewhere could drift
 * in style without anyone noticing.
 */
private val dayFormat = SimpleDateFormat("MMM d", Locale.getDefault())
