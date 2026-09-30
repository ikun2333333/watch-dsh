package dev.watchdsh.net

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Build
import dev.watchdsh.data.Diag

/**
 * Keeps the Wi-Fi radio awake while a link is live.
 *
 * A watch aggressively powers down its radio to save battery, and a weak signal
 * makes it worse: a socket that is idle for a few seconds gets its Wi-Fi
 * association suspended, the connection dies, and the app appears to work in
 * bursts. This is not specific to one app — a foreground app that holds a
 * connection has to say so.
 *
 * The lock is a high-performance Wi-Fi lock, held only while a socket is open and
 * released the moment it closes, so it costs battery only during an active
 * connection and never while the app is idle in the background.
 */
class WifiKeeper(private val context: Context) {
    private var lock: WifiManager.WifiLock? = null

    /** Take the lock; safe to call when already held. */
    fun acquire() {
        if (lock?.isHeld == true) return
        runCatching {
            val manager = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            // Android 10 replaced the full-high-performance mode with a
            // low-latency one; both keep the radio from dozing during a
            // connection, which is the only property this needs.
            val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                WifiManager.WIFI_MODE_FULL_LOW_LATENCY
            } else {
                @Suppress("DEPRECATION")
                WifiManager.WIFI_MODE_FULL_HIGH_PERF
            }
            lock = manager.createWifiLock(mode, "watch-dsh:link").apply {
                setReferenceCounted(false)
                acquire()
            }
            Diag.log(context, "wifi lock acquired")
        }.onFailure {
            // A missing permission or a device without Wi-Fi must not break the
            // link; it only means the connection may need to reconnect more often.
            Diag.log(context, "wifi lock unavailable: ${it.message}")
        }
    }

    /** Release the lock; safe to call when not held. */
    fun release() {
        val held = lock ?: return
        runCatching {
            if (held.isHeld) held.release()
        }
        lock = null
    }
}
