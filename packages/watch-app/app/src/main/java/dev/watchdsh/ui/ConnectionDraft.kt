package dev.watchdsh.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import dev.watchdsh.data.Settings

/**
 * Mutable holder for the connection values.
 *
 * It exists so the setup screen can drive one shared input launcher instead of
 * declaring one per field, and so the values survive the system input activity
 * taking the foreground.
 *
 * Two addresses are held because a watch may have both: the local one is used at
 * home and the public one away, and the link tries them in order. Entering only
 * one is fine; entering both is what makes the watch work in both places.
 */
class ConnectionDraft(initial: Settings) {
    var relayUrl by mutableStateOf(initial.relayUrl)
    var lanRelayUrl by mutableStateOf(initial.lanRelayUrl)
    var relayToken by mutableStateOf(initial.relayToken)
    var pairingSecret by mutableStateOf(initial.pairingSecret)
    var pcId by mutableStateOf(initial.pcId)

    /**
     * Whether every required value is present.
     *
     * The pairing secret is required: it is the end-to-end key and there is no
     * longer any handshake that hands it over, so a watch without one cannot send
     * anything the bridge will accept.
     */
    val isComplete: Boolean
        get() = relayUrl.isNotBlank() && relayToken.isNotBlank() && pcId.isNotBlank() &&
            pairingSecret.isNotBlank()
}

/** Remember a draft seeded from the saved settings. */
@Composable
fun rememberConnectionDraft(settings: Settings): ConnectionDraft =
    remember(
        settings.relayUrl,
        settings.lanRelayUrl,
        settings.relayToken,
        settings.pairingSecret,
        settings.pcId,
    ) {
        ConnectionDraft(settings)
    }
