package dev.watchdsh.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dev.watchdsh.net.ConnectionConfig
import dev.watchdsh.voice.RecognizerConfig
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

/** The one DataStore file this app owns. */
private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "watch-dsh")

/**
 * Which speech recognizer the watch uses.
 *
 * The system one is the platform's input activity. It needs no setup but hands
 * the audio to whichever recognition service the device happens to have, and that
 * service decides for itself whether it works - which on a watch is often not.
 * The other records here and streams to a recognizer the app controls, which is
 * what makes results appear while the user is still speaking.
 */
enum class AsrEngine { System, Xfyun }

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
    /**
     * Which recognizer to use, as [AsrEngine.name].
     *
     * A string rather than the enum so that an unknown value read back from disk
     * cannot crash the app on launch; [asrEngine] maps it and falls back.
     */
    val asrEngineName: String = AsrEngine.System.name,
    /**
     * Credentials for the streaming recognizer.
     *
     * These are the user's own account credentials and they have to be on the
     * watch, because the request is signed locally - there is no server of ours to
     * sign for it. They are no more exposed here than the relay token already is.
     */
    val asrAppId: String = "",
    val asrApiKey: String = "",
    val asrApiSecret: String = "",
) {
    /** The configured recognizer, falling back to the system one. */
    val asrEngine: AsrEngine
        get() = AsrEngine.entries.firstOrNull { it.name == asrEngineName } ?: AsrEngine.System

    /**
     * Whether the streaming recognizer can actually be used.
     *
     * Both halves are required: choosing it without credentials would otherwise
     * look like a broken microphone rather than an unfinished setting.
     */
    val asrReady: Boolean
        get() = asrEngine == AsrEngine.Xfyun && asrCredentials.isComplete

    /** The credentials, for the recognizer. */
    val asrCredentials: RecognizerConfig
        get() = RecognizerConfig(
            appId = asrAppId.trim(),
            apiKey = asrApiKey.trim(),
            apiSecret = asrApiSecret.trim(),
            language = "zh_cn",
        )

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
        val ASR_ENGINE = stringPreferencesKey("asr_engine")
        val ASR_APP_ID = stringPreferencesKey("asr_app_id")
        val ASR_API_KEY = stringPreferencesKey("asr_api_key")
        val ASR_API_SECRET = stringPreferencesKey("asr_api_secret")
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
            asrEngineName = preferences[Keys.ASR_ENGINE] ?: AsrEngine.System.name,
            asrAppId = preferences[Keys.ASR_APP_ID].orEmpty(),
            asrApiKey = preferences[Keys.ASR_API_KEY].orEmpty(),
            asrApiSecret = preferences[Keys.ASR_API_SECRET].orEmpty(),
        )
    }

    /**
     * Replace the recognizer settings.
     *
     * A blank value removes its key rather than storing an empty string, so
     * clearing a field in the UI really does clear it - otherwise a credential the
     * user deleted would keep being sent.
     */
    suspend fun saveAsr(
        engine: AsrEngine,
        appId: String,
        apiKey: String,
        apiSecret: String,
    ) {
        context.dataStore.edit { preferences ->
            preferences[Keys.ASR_ENGINE] = engine.name
            putOrRemove(preferences, Keys.ASR_APP_ID, appId)
            putOrRemove(preferences, Keys.ASR_API_KEY, apiKey)
            putOrRemove(preferences, Keys.ASR_API_SECRET, apiSecret)
        }
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

    /**
     * Store a value, or drop the key when it is blank.
     *
     * Storing an empty string would be indistinguishable from "never set" on read
     * but would still occupy the key, and for a credential that means a value the
     * user deleted stays in the file. Removing it makes "cleared" mean cleared.
     */
    private fun putOrRemove(
        preferences: androidx.datastore.preferences.core.MutablePreferences,
        key: Preferences.Key<String>,
        value: String,
    ) {
        if (value.isBlank()) preferences.remove(key) else preferences[key] = value.trim()
    }
}
