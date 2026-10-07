package dev.watchdsh.data

import android.content.Context
import java.io.File
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.concurrent.Executors

/**
 * A small on-device log the PC can read back with `adb pull`.
 *
 * A release build has no readable logcat for this app, and the failures worth
 * diagnosing here - a config file being rejected, a socket refused, a local
 * address that no longer answers - all happen on the watch, where there is no
 * console. This writes a bounded, append-only file into the app's external files
 * directory so `adb pull` can fetch it.
 *
 * It records connection milestones only: never a token, a pairing secret, or any
 * message text.
 *
 * ## Why the write is not on the caller's thread
 *
 * It used to be, and the callers are not a quiet backwater: this is called for
 * every screen change, for every link-state transition, and twice at startup. Each
 * call opened, appended to and closed a file - main-thread disk IO on navigation,
 * which is precisely the kind of thing that shows up as a hitch on a watch. The
 * call is now a queue submission.
 *
 * One thread, not a pool, so lines keep their order; a daemon thread, so a write
 * still in flight can never hold the process open. Ordering between [clear] and
 * [log] is kept for the same reason - they share the queue.
 */
object Diag {
    private const val FILE_NAME = "diagnostics.log"
    private const val MAX_BYTES = 16 * 1024

    /**
     * Thread-safe, unlike the `SimpleDateFormat` this replaced - which was both a
     * data race once more than one thread logged, and a reason the formatting had to
     * move onto the writer thread and lose the true call time.
     */
    private val stamp = DateTimeFormatter.ofPattern("MM-dd HH:mm:ss.SSS", Locale.US)

    /** The single writer, so ordering is total and no two writes interleave. */
    private val writer = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "diag-writer").apply { isDaemon = true }
    }

    /** Where the log lives, so a failure can be reported with its path. */
    fun path(context: Context): String = File(dir(context), FILE_NAME).absolutePath

    /** Queue one line, rotating the file when it grows past [MAX_BYTES]. */
    fun log(context: Context, message: String) {
        // Stamped on the calling thread: the time a thing happened is the useful
        // part, and a queue that is briefly behind would otherwise date every line by
        // when it was written instead.
        val line = "${stamp.format(LocalDateTime.now())}  $message\n"
        val file = File(dir(context), FILE_NAME)
        runCatching { writer.execute { append(file, line) } }
    }

    /** Clear the log, so a fresh run is not read through an old one. */
    fun clear(context: Context) {
        val file = File(dir(context), FILE_NAME)
        runCatching { writer.execute { runCatching { file.delete() } } }
    }

    private fun append(file: File, line: String) {
        // Swallowed here rather than at the call site: a diagnostic log that can
        // throw is worse than one that misses a line.
        runCatching {
            if (file.length() > MAX_BYTES) file.delete()
            file.appendText(line)
        }
    }

    private fun dir(context: Context): File =
        context.getExternalFilesDir(null) ?: context.filesDir
}
