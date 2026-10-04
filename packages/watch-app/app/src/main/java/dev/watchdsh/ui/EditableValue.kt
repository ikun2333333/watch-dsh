package dev.watchdsh.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material3.Card
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.Text

/** Which connection value the shared text-input launcher is currently editing. */
enum class EditableField { None, RelayUrl, LanRelayUrl, RelayToken, PairingSecret, PcId }

/**
 * One editable value.
 *
 * The card shows the label, the current value, and a hint that tapping opens
 * input. A long secret is abbreviated rather than wrapped, because on a round
 * display a wrapped secret is unreadable and gives no useful confirmation
 * anyway.
 */
@Composable
fun EditableValue(
    label: String,
    value: String,
    placeholder: String,
    onEdit: () -> Unit,
) {
    Card(onClick = onEdit, modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 4.dp)) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                text = if (value.isBlank()) placeholder else abbreviate(value),
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                color = if (value.isBlank()) {
                    MaterialTheme.colorScheme.onSurfaceVariant
                } else {
                    MaterialTheme.colorScheme.onSurface
                },
            )
            Text(
                text = "tap to enter",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary,
            )
        }
    }
}

/**
 * Shorten a value for display.
 *
 * The ends are kept because they are what a user compares against the bridge's
 * console output; the middle of a base64 secret carries no recognisable shape.
 */
private fun abbreviate(value: String): String =
    if (value.length <= 22) value else "${value.take(10)}…${value.takeLast(6)}"
