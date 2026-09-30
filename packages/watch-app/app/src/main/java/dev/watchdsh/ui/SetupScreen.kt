package dev.watchdsh.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.Card
import androidx.wear.compose.material3.CircularProgressIndicator
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.Text
import dev.watchdsh.net.DiscoveredBridge

/**
 * Pairing.
 *
 * On a LAN this needs no typing at all: the watch broadcasts a probe, the bridge
 * answers with the relay address, token, and pc id, and the pairing secret
 * follows over the relay's authenticated connection. Typing is only the fallback
 * for a remote relay, where there is nothing to discover.
 */
@Composable
fun SetupScreen(
    state: UiState,
    onScan: () -> Unit,
    onPick: (DiscoveredBridge) -> Unit,
    onSaveManual: (relayUrl: String, relayToken: String, pairingSecret: String, pcId: String) -> Unit,
) {
    val listState = rememberScalingLazyListState()
    var manualOpen by rememberSaveable { mutableStateOf(false) }

    ScreenScaffold(scrollState = listState) {
        ScalingLazyColumn(
            state = listState,
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = ListArrangement,
        ) {
            item {
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 4.dp)) {
                        Text("Connect to your PC", style = MaterialTheme.typography.titleSmall)
                        Text(
                            "The watch and the PC must be on the same Wi-Fi.",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }
            }

            if (state.scanning) {
                item {
                    Column(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        CircularProgressIndicator(modifier = Modifier.size(24.dp))
                        Text("Looking...", style = MaterialTheme.typography.bodySmall)
                    }
                }
            } else {
                item {
                    Button(onClick = onScan, modifier = Modifier.fillMaxWidth()) {
                        Text("Find my PC")
                    }
                }
            }

            for (bridge in state.discovered) {
                item(key = bridge.pcId) {
                    Card(onClick = { onPick(bridge) }, modifier = Modifier.fillMaxWidth()) {
                        Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 4.dp)) {
                            Text(bridge.pcId, style = MaterialTheme.typography.titleSmall, maxLines = 1)
                            Text(
                                text = bridge.relayUrl,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                            )
                        }
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

            // The fallback path, collapsed by default so the common case is one tap.
            item {
                Button(onClick = { manualOpen = !manualOpen }, modifier = Modifier.fillMaxWidth()) {
                    Text(if (manualOpen) "Hide manual setup" else "Enter details manually")
                }
            }

            if (manualOpen) {
                item {
                    ManualSetupFields(state = state, onSave = onSaveManual)
                }
            }
        }
    }
}
