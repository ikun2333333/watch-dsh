package dev.watchdsh.data

import android.content.Context
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * A small on-device log the PC can read back with `adb pull`.
 *
 * A release build has no readable logcat for this app, and the failures worth
 * diagnosing here — discovery finding nothing, pairing not completing, a config
 * file being rejected — all happen on the watch, where there is no console. This
 * writes a bounded, append-only file into the app's external files directory so
 * `adb pull` can fetch it.
 *
 * It records connection milestones only: never a token, a pairing secret, or any
 * message text.
 */
object Diag {
    private const val FILE_NAME = "diagnostics.log"
    private const val MAX_BYTES = 16 * 1024

    private val stamp = SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.US)

    /** Where the log lives, so a failure can be reported with its path. */
    fun path(context: Context): String = File(dir(context), FILE_NAME).absolutePath

    /** Append one line, rotating the file when it grows past [MAX_BYTES]. */
    fun log(context: Context, message: String) {
        runCatching {
            val file = File(dir(context), FILE_NAME)
            if (file.length() > MAX_BYTES) file.delete()
            file.appendText("${stamp.format(Date())}  $message\n")
        }
    }

    /** Clear the log, so a fresh run is not read through an old one. */
    fun clear(context: Context) {
        runCatching { File(dir(context), FILE_NAME).delete() }
    }

    private fun dir(context: Context): File =
        context.getExternalFilesDir(null) ?: context.filesDir
}
