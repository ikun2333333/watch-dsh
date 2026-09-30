package dev.watchdsh.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import dev.watchdsh.data.Settings

/**
 * Mutable holder for the four pairing values.
 *
 * It exists so a setup screen can drive one shared text-input launcher instead of
 * declaring four of them, and so the values survive the system input activity
 * taking the foreground.
 */
class ConnectionDraft(initial: Settings) {
    var relayUrl by mutableStateOf(initial.relayUrl)
    var relayToken by mutableStateOf(initial.relayToken)
    var pairingSecret by mutableStateOf(initial.pairingSecret)
    var pcId by mutableStateOf(initial.pcId)

    /**
     * Whether every required value is present.
     *
     * The pairing secret is not required: discovery supplies it on a LAN, and a
     * remote bridge hands it over during the pairing handshake.
     */
    val isComplete: Boolean
        get() = relayUrl.isNotBlank() && relayToken.isNotBlank() && pcId.isNotBlank()
}

/** Remember a draft seeded from the saved settings. */
@Composable
fun rememberConnectionDraft(settings: Settings): ConnectionDraft =
    remember(settings.relayUrl, settings.relayToken, settings.pairingSecret, settings.pcId) {
        ConnectionDraft(settings)
    }
