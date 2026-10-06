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
 * The setup form.
 *
 * Wear Material 3 ships no text field and a watch has no keyboard, so each value
 * is entered through the system input activity — the same activity dictation uses.
 * That is a lot of tapping, which is why the intended path is importing a config
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

    // One launcher serves every row; the target says where the result goes.
    var target by rememberSaveable { mutableStateOf(EditableField.None) }
    val launcher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            val text = VoiceInput.extractText(result.data)
            if (text != null) {
                when (target) {
                    EditableField.RelayUrl -> values.relayUrl = text
                    EditableField.LanRelayUrl -> values.lanRelayUrl = text
                    EditableField.RelayToken -> values.relayToken = text
                    EditableField.PairingSecret -> values.pairingSecret = text
                    EditableField.PcId -> values.pcId = text
                    // This form only holds connection values; the recognizer's
                    // credentials live in settings, which is the only place that
                    // can switch engines as well as store them.
                    EditableField.AsrAppId, EditableField.AsrApiKey, EditableField.AsrApiSecret -> Unit
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
        EditableValue("LAN Relay URL", values.lanRelayUrl, "optional") {
            edit(EditableField.LanRelayUrl, "LAN Relay URL")
        }
        EditableValue("Relay token", values.relayToken, "required") { edit(EditableField.RelayToken, "Relay token") }
        EditableValue("PC id", values.pcId, "required") { edit(EditableField.PcId, "PC id") }
        EditableValue("Pairing secret", values.pairingSecret, "required") {
            edit(EditableField.PairingSecret, "Pairing secret")
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
