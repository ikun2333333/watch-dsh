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

/** Which value the shared text-input launcher is currently editing. */
enum class EditableField {
    None,
    RelayUrl,
    LanRelayUrl,
    RelayToken,
    PairingSecret,
    PcId,
    AsrAppId,
    AsrApiKey,
    AsrApiSecret,
}

/**
 * What the editor calls this value.
 *
 * Named in full rather than shortened, because the two services both have a key and
 * a secret: "API key" alone does not say which one is being pasted.
 */
fun EditableField.title(): String = when (this) {
    EditableField.RelayUrl -> "Public relay URL"
    EditableField.LanRelayUrl -> "LAN relay URL"
    EditableField.RelayToken -> "Relay token"
    EditableField.PairingSecret -> "Pairing secret"
    EditableField.PcId -> "PC id"
    EditableField.AsrAppId -> "Xfyun app id"
    EditableField.AsrApiKey -> "Xfyun API key"
    EditableField.AsrApiSecret -> "Xfyun API secret"
    EditableField.None -> ""
}

/**
 * What to show while the box is empty.
 *
 * The credential fields say how long the value is, because these are copied from a
 * provider console by eye and a length is the only check a user can make on a watch
 * without reading every character.
 */
fun EditableField.placeholder(): String = when (this) {
    EditableField.RelayUrl -> "ws://host:port, or wss:// for a remote relay"
    EditableField.LanRelayUrl -> "optional; cleared if left empty"
    EditableField.RelayToken -> "from .state/relay-token"
    EditableField.PairingSecret -> "from .state/pairing-secret"
    EditableField.PcId -> "shown by the bridge at startup"
    EditableField.AsrAppId -> "8 hex characters"
    EditableField.AsrApiKey -> "32 hex characters"
    EditableField.AsrApiSecret -> "32 hex characters"
    EditableField.None -> ""
}

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
