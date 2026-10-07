package dev.watchdsh.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.Card
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.Text

/**
 * Setup.
 *
 * A watch is configured by importing a file rather than by pairing: the bridge
 * writes a config holding both relay addresses, the token, the pairing secret, and
 * the pc id, and one `adb push` installs it. That replaced an earlier design where
 * the watch broadcast a probe and the bridge handed the secret over, which needed
 * a router that passes broadcast between wireless clients — commonly not the case,
 * and measurably not the case on the network this was built against.
 *
 * So there is nothing to discover and nothing to negotiate. The form below exists
 * for when pushing a file is inconvenient; it asks for the same values the file
 * would supply.
 */
@Composable
fun SetupScreen(
    state: UiState,
    onSaveManual: (
        relayUrl: String,
        lanRelayUrl: String,
        relayToken: String,
        pairingSecret: String,
        pcId: String,
    ) -> Unit,
) {
    val listState = rememberScalingLazyListState()
    var formOpen by rememberSaveable { mutableStateOf(false) }

    ScreenScaffold(scrollState = listState) { contentPadding ->
        ScalingLazyColumn(
            state = listState,
            modifier = Modifier.fillMaxWidth(),
            contentPadding = contentPadding,
            verticalArrangement = ListArrangement,
        ) {
            item {
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 4.dp)) {
                        Text("Connect to your PC", style = MaterialTheme.typography.titleSmall)
                        Text(
                            "Push a config from the PC, or enter the values here.",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }
            }

            state.lastError?.let { message ->
                item {
                    Text(
                        text = message,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }

            item {
                Button(onClick = { formOpen = !formOpen }, modifier = Modifier.fillMaxWidth()) {
                    Text(if (formOpen) "Hide values" else "Enter values")
                }
            }

            if (formOpen) {
                item {
                    ManualSetupFields(state = state, onSave = onSaveManual)
                }
            }
        }
    }
}
