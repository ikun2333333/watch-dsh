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
import dev.watchdsh.data.AsrEngine
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
    onSaveRecognizer: (engine: AsrEngine, appId: String, apiKey: String, apiSecret: String) -> Unit,
    onNotice: (String) -> Unit,
    onForget: () -> Unit,
    onBack: () -> Unit,
) {
    val listState = rememberScalingLazyListState()
    val values = rememberConnectionDraft(state.settings)

    // The recognizer's own draft, kept separate because it is saved by its own
    // button: folding it into the connection draft would make one Save write both
    // and blur which values belong to which service.
    var asrAppId by rememberSaveable { mutableStateOf(state.settings.asrAppId) }
    var asrApiKey by rememberSaveable { mutableStateOf(state.settings.asrApiKey) }
    var asrApiSecret by rememberSaveable { mutableStateOf(state.settings.asrApiSecret) }

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
                EditableField.AsrAppId -> asrAppId = text
                EditableField.AsrApiKey -> asrApiKey = text
                EditableField.AsrApiSecret -> asrApiSecret = text
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

            // --- the recognizer -------------------------------------------------
            // Placed after the connection because it is optional, and labelled with
            // what each choice costs: one needs no setup but depends on a service
            // the watch may not have, the other needs credentials but is the one
            // that shows words while the user is still speaking.
            item {
                Card(modifier = Modifier.fillMaxWidth()) {
                    Text(
                        text = "Voice input",
                        style = MaterialTheme.typography.titleSmall,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 4.dp),
                    )
                }
            }

            item {
                Button(
                    onClick = {
                        onSaveRecognizer(AsrEngine.System, asrAppId, asrApiKey, asrApiSecret)
                        onNotice("Using the watch's own recognizer")
                    },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = state.settings.asrEngine != AsrEngine.System,
                ) {
                    Text(if (state.settings.asrEngine == AsrEngine.System) "System recognizer (in use)" else "Use system recognizer")
                }
            }

            item {
                Button(
                    onClick = {
                        if (asrAppId.isBlank() || asrApiKey.isBlank() || asrApiSecret.isBlank()) {
                            onNotice("Fill all three credentials first")
                        } else {
                            onSaveRecognizer(AsrEngine.Xfyun, asrAppId, asrApiKey, asrApiSecret)
                            onNotice("Streaming recognizer on")
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = state.settings.asrEngine != AsrEngine.Xfyun,
                ) {
                    Text(if (state.settings.asrEngine == AsrEngine.Xfyun) "Streaming (in use)" else "Use streaming recognizer")
                }
            }

            item { EditableValue("ASR app id", asrAppId, "not set") { edit(EditableField.AsrAppId, "ASR app id") } }
            item { EditableValue("ASR api key", asrApiKey, "not set") { edit(EditableField.AsrApiKey, "ASR api key") } }
            item { EditableValue("ASR api secret", asrApiSecret, "not set") { edit(EditableField.AsrApiSecret, "ASR api secret") } }

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
