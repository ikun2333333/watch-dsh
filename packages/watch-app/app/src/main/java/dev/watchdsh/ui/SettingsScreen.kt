package dev.watchdsh.ui

import androidx.compose.foundation.layout.PaddingValues
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
import androidx.wear.compose.material3.ButtonGroup
import androidx.wear.compose.material3.Card
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.Text
import androidx.wear.compose.material3.TextToggleButton
import dev.watchdsh.data.AsrEngine

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

    /**
     * The value each field is edited from.
     *
     * The point of the on-screen editor over the system input activity that used to
     * be launched here: that one starts from a blank box, so correcting one character
     * of a forty-three character token meant retyping the whole thing on a watch. Here
     * the current value is loaded and the caret is put at its end.
     */
    fun currentValue(field: EditableField): String = when (field) {
        EditableField.RelayUrl -> values.relayUrl
        EditableField.LanRelayUrl -> values.lanRelayUrl
        EditableField.RelayToken -> values.relayToken
        EditableField.PairingSecret -> values.pairingSecret
        EditableField.PcId -> values.pcId
        EditableField.AsrAppId -> asrAppId
        EditableField.AsrApiKey -> asrApiKey
        EditableField.AsrApiSecret -> asrApiSecret
        EditableField.None -> ""
    }

    fun applyText(field: EditableField, text: String) {
        when (field) {
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

    // While a value is being edited the editor covers this screen. It is the same
    // composable the message composer uses, which is the point of having built it as
    // a module rather than inside the conversation screen.
    if (pendingTarget != EditableField.None) {
        val target = pendingTarget
        InputScreen(
            title = target.title(),
            placeholder = target.placeholder(),
            confirmLabel = "Save",
            initial = currentValue(target),
            settings = state.settings,
            onVoiceMessage = onNotice,
            onSubmit = { text ->
                applyText(target, text)
                pendingTarget = EditableField.None
            },
            onCancel = { pendingTarget = EditableField.None },
        )
        return
    }

    fun edit(field: EditableField) {
        pendingTarget = field
    }

    ScreenScaffold(scrollState = listState) { contentPadding ->
        ScalingLazyColumn(
            state = listState,
            modifier = Modifier.fillMaxWidth(),
            contentPadding = contentPadding,
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

            item { EditableValue("Relay URL", values.relayUrl, "not set") { edit(EditableField.RelayUrl) } }
            item {
                EditableValue("LAN Relay URL", values.lanRelayUrl, "optional") {
                    edit(EditableField.LanRelayUrl)
                }
            }
            item { EditableValue("Relay token", values.relayToken, "not set") { edit(EditableField.RelayToken) } }
            item { EditableValue("Pairing secret", values.pairingSecret, "not set") { edit(EditableField.PairingSecret) } }
            item { EditableValue("PC id", values.pcId, "not set") { edit(EditableField.PcId) } }

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

            // One choice, so one control.
            //
            // This was two full-width buttons whose labels carried "(in use)", which
            // asked the reader to compare two strings to work out which was active and
            // left the losing button tappable-looking but disabled. A toggle group says
            // it by shape: the selected one is a rounded rectangle, the other a pill.
            item {
                ButtonGroup(
                    modifier = Modifier.fillMaxWidth(),
                    contentPadding = PaddingValues(0.dp),
                ) {
                    AsrEngine.entries.forEach { engine ->
                        TextToggleButton(
                            checked = state.settings.asrEngine == engine,
                            onCheckedChange = { checked ->
                                if (!checked) return@TextToggleButton
                                when (engine) {
                                    AsrEngine.System -> {
                                        onSaveRecognizer(AsrEngine.System, asrAppId, asrApiKey, asrApiSecret)
                                        onNotice("Using the watch's own recognizer")
                                    }

                                    AsrEngine.Xfyun -> {
                                        if (asrAppId.isBlank() || asrApiKey.isBlank() || asrApiSecret.isBlank()) {
                                            onNotice("Fill all three credentials first")
                                        } else {
                                            onSaveRecognizer(AsrEngine.Xfyun, asrAppId, asrApiKey, asrApiSecret)
                                            onNotice("Streaming recognizer on")
                                        }
                                    }
                                }
                            },
                            modifier = Modifier.weight(1f),
                            shapes = selectionToggleShapes(),
                        ) {
                            Text(
                                text = if (engine == AsrEngine.System) "System" else "Streaming",
                                style = MaterialTheme.typography.labelMedium,
                                maxLines = 1,
                            )
                        }
                    }
                }
            }

            item { EditableValue("ASR app id", asrAppId, "not set") { edit(EditableField.AsrAppId) } }
            item { EditableValue("ASR api key", asrApiKey, "not set") { edit(EditableField.AsrApiKey) } }
            item { EditableValue("ASR api secret", asrApiSecret, "not set") { edit(EditableField.AsrApiSecret) } }

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
