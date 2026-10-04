package dev.watchdsh.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dev.watchdsh.net.ConnectionConfig
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

/** The one DataStore file this app owns. */
private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "watch-dsh")

/** Persisted connection settings. */
data class Settings(
    val relayUrl: String = "",
    /**
     * This PC's address on the local network, when one is known.
     *
     * Kept alongside [relayUrl] because neither address works in both places: at
     * home the local one is faster and works with no internet, and away only the
     * public one is reachable. The watch tries the local one first and falls back,
     * which needs no user choice and no mode flag that could disagree with the
     * addresses actually stored.
     */
    val lanRelayUrl: String = "",
    val relayToken: String = "",
    val pairingSecret: String = "",
    val pcId: String = "",
    val lastSessionId: String? = null,
) {
    /**
     * Whether enough is known to attempt a connection.
     *
     * A missing pairing secret is deliberately still "configured": that is the
     * state a watch is in right after discovering a PC, and connecting in it is
     * what triggers the pairing handshake that obtains the secret.
     */
    val isConfigured: Boolean
        get() = relayUrl.isNotBlank() && relayToken.isNotBlank() && pcId.isNotBlank()

    /**
     * Addresses to try, in order, skipping blanks and duplicates.
     *
     * The local address leads because it is the one that works with no internet,
     * and a stale one costs only a failed attempt before the public address is
     * tried. This is why a DHCP change does not need any action: the local attempt
     * fails, the public one succeeds, and nothing has to notice or repair it.
     */
    val candidates: List<String>
        get() = listOf(lanRelayUrl.trim(), relayUrl.trim()).filter { it.isNotEmpty() }.distinct()

    /** Convert to the network layer's configuration for one address. */
    fun toConnectionConfig(url: String = relayUrl) = ConnectionConfig(
        url = url,
        token = relayToken,
        pairingSecret = pairingSecret,
        pcId = pcId,
    )
}

/**
 * Settings storage.
 *
 * The pairing secret is kept in DataStore rather than EncryptedSharedPreferences
 * because the watch is the user's own device and the app has no other secret to
 * protect; the relay never learns this value, which is what actually matters.
 */
class SettingsStore(private val context: Context) {
    private object Keys {
        val RELAY_URL = stringPreferencesKey("relay_url")
        val LAN_RELAY_URL = stringPreferencesKey("lan_relay_url")
        val RELAY_TOKEN = stringPreferencesKey("relay_token")
        val PAIRING_SECRET = stringPreferencesKey("pairing_secret")
        val PC_ID = stringPreferencesKey("pc_id")
        val LAST_SESSION = stringPreferencesKey("last_session")
    }

    /** Current settings, updating as they change. */
    val settings: Flow<Settings> = context.dataStore.data.map { preferences ->
        Settings(
            relayUrl = preferences[Keys.RELAY_URL].orEmpty(),
            lanRelayUrl = preferences[Keys.LAN_RELAY_URL].orEmpty(),
            relayToken = preferences[Keys.RELAY_TOKEN].orEmpty(),
            pairingSecret = preferences[Keys.PAIRING_SECRET].orEmpty(),
            pcId = preferences[Keys.PC_ID].orEmpty(),
            lastSessionId = preferences[Keys.LAST_SESSION],
        )
    }

    /** Replace the whole connection configuration, as the setup screen does. */
    suspend fun saveConnection(
        relayUrl: String,
        relayToken: String,
        pairingSecret: String,
        pcId: String,
        lanRelayUrl: String = "",
    ) {
        context.dataStore.edit { preferences ->
            preferences[Keys.RELAY_URL] = relayUrl.trim()
            if (lanRelayUrl.isBlank()) preferences.remove(Keys.LAN_RELAY_URL)
            else preferences[Keys.LAN_RELAY_URL] = lanRelayUrl.trim()
            preferences[Keys.RELAY_TOKEN] = relayToken.trim()
            preferences[Keys.PAIRING_SECRET] = pairingSecret.trim()
            preferences[Keys.PC_ID] = pcId.trim()
        }
    }

    /** Remember which session the user was last reading. */
    suspend fun setLastSession(sessionId: String?) {
        context.dataStore.edit { preferences ->
            if (sessionId == null) preferences.remove(Keys.LAST_SESSION)
            else preferences[Keys.LAST_SESSION] = sessionId
        }
    }

    /** Forget everything, returning the app to first-run state. */
    suspend fun clear() {
        context.dataStore.edit { it.clear() }
    }
}
