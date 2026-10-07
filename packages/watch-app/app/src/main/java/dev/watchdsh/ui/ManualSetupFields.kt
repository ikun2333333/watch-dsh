package dev.watchdsh.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.Text

/**
 * The setup form.
 *
 * Each value is entered in the app's own editor rather than the system input
 * activity that used to be launched here. Two reasons, and the second is the one
 * that matters on a first run: the editor starts from the value already in the box,
 * so correcting a mistyped character does not mean retyping forty-three of them, and
 * it stays inside this app instead of handing the screen to another one.
 *
 * It is still a lot of tapping, which is why the intended path is importing a config
 * over adb instead: the bridge writes the file, one `adb push` installs it, and
 * nothing is typed. This form exists for the case where that is not convenient.
 *
 * The relay URL and the LAN relay URL are separate on purpose. The watch tries the
 * local one first and falls back to the other, so filling in both is what makes it
 * work at home and away without changing anything.
 */
@Composable
fun ManualSetupFields(
    state: UiState,
    onSave: (relayUrl: String, lanRelayUrl: String, relayToken: String, pairingSecret: String, pcId: String) -> Unit,
) {
    val values = rememberConnectionDraft(state.settings)

    /** Which value the editor is open on. */
    var target by rememberSaveable { mutableStateOf(EditableField.None) }

    fun currentValue(field: EditableField): String = when (field) {
        EditableField.RelayUrl -> values.relayUrl
        EditableField.LanRelayUrl -> values.lanRelayUrl
        EditableField.RelayToken -> values.relayToken
        EditableField.PairingSecret -> values.pairingSecret
        EditableField.PcId -> values.pcId
        // This form only holds connection values; the recognizer's credentials live
        // in settings, which is the only place that can switch engines as well as
        // store them.
        EditableField.AsrAppId, EditableField.AsrApiKey, EditableField.AsrApiSecret, EditableField.None -> ""
    }

    fun applyText(field: EditableField, text: String) {
        when (field) {
            EditableField.RelayUrl -> values.relayUrl = text
            EditableField.LanRelayUrl -> values.lanRelayUrl = text
            EditableField.RelayToken -> values.relayToken = text
            EditableField.PairingSecret -> values.pairingSecret = text
            EditableField.PcId -> values.pcId = text
            EditableField.AsrAppId, EditableField.AsrApiKey, EditableField.AsrApiSecret, EditableField.None -> Unit
        }
    }

    if (target != EditableField.None) {
        val editing = target
        InputScreen(
            title = editing.title(),
            placeholder = editing.placeholder(),
            confirmLabel = "Use",
            initial = currentValue(editing),
            settings = state.settings,
            onVoiceMessage = {},
            onSubmit = { text ->
                applyText(editing, text)
                target = EditableField.None
            },
            onCancel = { target = EditableField.None },
        )
        return
    }

    androidx.compose.foundation.layout.Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        EditableValue("Relay URL", values.relayUrl, "required") { target = EditableField.RelayUrl }
        EditableValue("LAN Relay URL", values.lanRelayUrl, "optional") {
            target = EditableField.LanRelayUrl
        }
        EditableValue("Relay token", values.relayToken, "required") { target = EditableField.RelayToken }
        EditableValue("PC id", values.pcId, "required") { target = EditableField.PcId }
        EditableValue("Pairing secret", values.pairingSecret, "required") {
            target = EditableField.PairingSecret
        }

        Button(
            onClick = {
                onSave(
                    values.relayUrl,
                    values.lanRelayUrl,
                    values.relayToken,
                    values.pairingSecret,
                    values.pcId,
                )
            },
            enabled = values.isComplete,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Connect")
        }
    }
}
