package dev.watchdsh.ui

import android.app.Activity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import dev.watchdsh.voice.VoiceInput

/**
 * The manual fallback for a remote relay.
 *
 * Wear Material 3 ships no text field and a watch has no keyboard, so each value
 * is entered through the system input activity — the same activity dictation
 * uses. Four values is a lot of tapping, which is exactly why discovery exists
 * and why this is collapsed by default.
 */
@Composable
fun ManualSetupFields(
    state: UiState,
    onSave: (relayUrl: String, relayToken: String, pairingSecret: String, pcId: String) -> Unit,
) {
    val values = rememberConnectionDraft(state.settings)

    // One launcher serves all four rows; the target says where the result goes.
    var target by rememberSaveable { mutableStateOf(EditableField.None) }
    val launcher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            val text = VoiceInput.extractText(result.data)
            if (text != null) {
                when (target) {
                    EditableField.RelayUrl -> values.relayUrl = text
                    EditableField.RelayToken -> values.relayToken = text
                    EditableField.PairingSecret -> values.pairingSecret = text
                    EditableField.PcId -> values.pcId = text
                    EditableField.None -> Unit
                }
            }
        }
        target = EditableField.None
    }

    fun edit(field: EditableField, prompt: String) {
        target = field
        VoiceInput.launch(launcher, prompt)
    }

    androidx.compose.foundation.layout.Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        EditableValue("Relay URL", values.relayUrl, "required") { edit(EditableField.RelayUrl, "Relay URL") }
        EditableValue("Relay token", values.relayToken, "required") { edit(EditableField.RelayToken, "Relay token") }
        EditableValue("PC id", values.pcId, "required") { edit(EditableField.PcId, "PC id") }
        // Optional: a discovered PC supplies this automatically, and a remote one
        // hands it over during the pairing handshake.
        EditableValue("Pairing secret", values.pairingSecret, "optional") {
            edit(EditableField.PairingSecret, "Pairing secret")
        }

        Button(
            onClick = { onSave(values.relayUrl, values.relayToken, values.pairingSecret, values.pcId) },
            enabled = values.relayUrl.isNotBlank() && values.relayToken.isNotBlank() && values.pcId.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Connect")
        }
    }
}
