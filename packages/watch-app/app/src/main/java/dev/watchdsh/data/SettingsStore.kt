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

    /** Convert to the network layer's configuration. */
    fun toConnectionConfig() = ConnectionConfig(
        url = relayUrl,
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
        val RELAY_TOKEN = stringPreferencesKey("relay_token")
        val PAIRING_SECRET = stringPreferencesKey("pairing_secret")
        val PC_ID = stringPreferencesKey("pc_id")
        val LAST_SESSION = stringPreferencesKey("last_session")
    }

    /** Current settings, updating as they change. */
    val settings: Flow<Settings> = context.dataStore.data.map { preferences ->
        Settings(
            relayUrl = preferences[Keys.RELAY_URL].orEmpty(),
            relayToken = preferences[Keys.RELAY_TOKEN].orEmpty(),
            pairingSecret = preferences[Keys.PAIRING_SECRET].orEmpty(),
            pcId = preferences[Keys.PC_ID].orEmpty(),
            lastSessionId = preferences[Keys.LAST_SESSION],
        )
    }

    /** Replace the whole connection configuration, as the setup screen does. */
    suspend fun saveConnection(relayUrl: String, relayToken: String, pairingSecret: String, pcId: String) {
        context.dataStore.edit { preferences ->
            preferences[Keys.RELAY_URL] = relayUrl.trim()
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
