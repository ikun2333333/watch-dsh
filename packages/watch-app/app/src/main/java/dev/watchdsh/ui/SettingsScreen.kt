package dev.watchdsh.ui

import android.app.Activity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.Card
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.Text
import dev.watchdsh.voice.VoiceInput

/**
 * Connection settings.
 *
 * This is the setup screen again with the saved values loaded, because
 * re-pairing is exactly the first-run flow and a second screen would only
 * duplicate it. "Forget" is the one destructive action and is therefore last.
 */
@Composable
fun SettingsScreen(
    state: UiState,
    onSave: (
        relayUrl: String,
        lanRelayUrl: String,
        relayToken: String,
        pairingSecret: String,
        pcId: String,
    ) -> Unit,
    onForget: () -> Unit,
    onBack: () -> Unit,
) {
    val listState = rememberScalingLazyListState()
    val values = rememberConnectionDraft(state.settings)

    var pendingTarget by rememberSaveable { mutableStateOf(EditableField.None) }
    val inputLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            val text = VoiceInput.extractText(result.data) ?: return@rememberLauncherForActivityResult
            when (pendingTarget) {
                EditableField.RelayUrl -> values.relayUrl = text
                EditableField.LanRelayUrl -> values.lanRelayUrl = text
                EditableField.RelayToken -> values.relayToken = text
                EditableField.PairingSecret -> values.pairingSecret = text
                EditableField.PcId -> values.pcId = text
                EditableField.None -> Unit
            }
        }
        pendingTarget = EditableField.None
    }

    fun edit(field: EditableField, prompt: String) {
        pendingTarget = field
        VoiceInput.launch(inputLauncher, prompt)
    }

    ScreenScaffold(scrollState = listState) {
        ScalingLazyColumn(
            state = listState,
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = ListArrangement,
        ) {
            item {
                Card(modifier = Modifier.fillMaxWidth()) {
                    Text(
                        text = state.status?.let { "Harness ${it.harness} · ${state.link.label()}" } ?: state.link.label(),
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 4.dp),
                    )
                }
            }

            item { EditableValue("Relay URL", values.relayUrl, "not set") { edit(EditableField.RelayUrl, "Relay URL") } }
            item {
                EditableValue("LAN Relay URL", values.lanRelayUrl, "optional") {
                    edit(EditableField.LanRelayUrl, "LAN Relay URL")
                }
            }
            item { EditableValue("Relay token", values.relayToken, "not set") { edit(EditableField.RelayToken, "Relay token") } }
            item { EditableValue("Pairing secret", values.pairingSecret, "not set") { edit(EditableField.PairingSecret, "Pairing secret") } }
            item { EditableValue("PC id", values.pcId, "not set") { edit(EditableField.PcId, "PC id") } }

            item {
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
                    modifier = Modifier.fillMaxWidth(),
                    enabled = values.isComplete,
                ) {
                    Text("Save and reconnect")
                }
            }

            item {
                Button(onClick = onBack, modifier = Modifier.fillMaxWidth()) {
                    Text("Back")
                }
            }

            item {
                Button(onClick = onForget, modifier = Modifier.fillMaxWidth()) {
                    Text("Forget this PC", color = MaterialTheme.colorScheme.error)
                }
            }
        }
    }
}
