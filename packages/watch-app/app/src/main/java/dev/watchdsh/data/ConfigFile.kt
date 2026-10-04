package dev.watchdsh.data

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File

/**
 * A portable description of how to reach one bridge, written by
 * `tools`-side `--write-config` and pushed to the watch.
 *
 * A relay on the internet has nothing to discover, so this file is how a remote
 * setup avoids the watch keyboard: the bridge writes it, and one `adb push`
 * imports it.
 *
 * It may carry two addresses because neither is right in both places: `relayUrl`
 * is where the bridge is attached (a public relay, for use away from home) and
 * `lanRelayUrl` is this PC on the local network. See `Settings.lanRelayUrl`.
 *
 * See `packages/dsh-bridge/src/config.mjs` for the format's other half.
 */
@Serializable
private data class WatchConfig(
    val dsh: String = "",
    val v: Int = 0,
    val pcId: String = "",
    val relayUrl: String = "",
    val lanRelayUrl: String? = null,
    val relayToken: String = "",
    val pairingSecret: String = "",
)

object ConfigFile {
    /** Must match the bridge's constants; these are file-format values. */
    private const val MAGIC = "watch-dsh-config"
    private const val VERSION = 1

    /** Where an imported config is expected on the watch. */
    private const val FILE_NAME = "watch-config.json"

    private val json = Json { ignoreUnknownKeys = true }

    /**
     * Absolute path the config is read from, for documentation and diagnostics.
     *
     * The app's external files directory is chosen deliberately: it is per-app,
     * so `adb push` can write it without any storage permission, and no other app
     * can read it.
     */
    fun path(context: Context): String =
        File(context.getExternalFilesDir(null), FILE_NAME).absolutePath

    /**
     * Read an imported config.
     *
     * @return the settings it describes, or null when there is no file or it is
     *   not a config this build understands. A malformed file is ignored rather
     *   than reported: discovery and manual entry both still work, so failing the
     *   whole first run over it would be worse than skipping it.
     */
    fun read(context: Context): Settings? {
        val file = File(context.getExternalFilesDir(null), FILE_NAME)
        if (!file.isFile) return null
        val text = runCatching { file.readText() }.getOrNull() ?: return null
        val parsed = runCatching { json.decodeFromString<WatchConfig>(text) }.getOrNull() ?: return null
        if (parsed.dsh != MAGIC || parsed.v != VERSION) return null
        if (parsed.relayUrl.isBlank() || parsed.relayToken.isBlank() || parsed.pcId.isBlank()) return null
        return Settings(
            relayUrl = parsed.relayUrl.trim(),
            lanRelayUrl = parsed.lanRelayUrl?.trim().orEmpty(),
            relayToken = parsed.relayToken.trim(),
            pairingSecret = parsed.pairingSecret.trim(),
            pcId = parsed.pcId.trim(),
            lastSessionId = null,
        )
    }

    /**
     * Delete an imported config after it has been applied.
     *
     * It holds a credential, and leaving it on external storage after import would
     * keep that credential where a `adb pull` could retrieve it long after it was
     * needed.
     */
    fun consume(context: Context) {
        runCatching { File(context.getExternalFilesDir(null), FILE_NAME).delete() }
    }
}
