package dev.watchdsh.net

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import dev.watchdsh.MainActivity
import dev.watchdsh.R
import dev.watchdsh.data.Diag

/**
 * Keeps the process alive while the app means to stay connected.
 *
 * ## Why this exists
 *
 * Holding a `WifiLock` keeps the radio on and does nothing for the CPU. A watch
 * freezes a backgrounded app's scheduling, and the effects are not subtle: the
 * socket is cut about twenty seconds after the screen goes off - which is the
 * OkHttp ping interval, because a frozen process cannot answer the ping - and the
 * reconnect the app schedules never runs, because a frozen process does not run
 * delayed coroutines either. Waking the screen resumed everything instantly, which
 * is how the cause was identified rather than guessed.
 *
 * A foreground service is the only thing Android guarantees will not be frozen, and
 * it requires an ongoing notification. That notification is the price of a link that
 * survives the screen going off, and it is why this is a deliberate choice rather
 * than something the app does silently.
 *
 * `dataSync` is the type: this is an app keeping a network connection to its own
 * backend, which is what that type is for. The service holds nothing itself - it
 * exists to be visible to the scheduler, and the connection lives in [BridgeLink].
 */
class LinkService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel(this)
        // Posted immediately: a foreground service that has not called
        // startForeground within a few seconds is killed by the platform, and that
        // would leave the process frozen exactly as before, only harder to explain.
        startForeground(NOTIFICATION_ID, buildNotification(this))
        Diag.log(this, "link service started")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Restarted if the platform kills it, because the reason it exists - a
        // connection the user expects to be there - has not gone away.
        return START_STICKY
    }

    override fun onDestroy() {
        Diag.log(this, "link service stopped")
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL_ID = "watch-dsh-link"
        private const val NOTIFICATION_ID = 1

        /**
         * The channel, created on demand and recreated if the user deletes it.
         *
         * Low importance on purpose. This says the app is running; it is not news,
         * and a watch should not buzz to announce that a connection is up.
         */
        private fun ensureChannel(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val manager = context.getSystemService(NotificationManager::class.java) ?: return
            if (manager.getNotificationChannel(CHANNEL_ID) != null) return
            val channel = NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.link_channel_name),
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = context.getString(R.string.link_channel_description)
                setShowBadge(false)
                enableVibration(false)
            }
            manager.createNotificationChannel(channel)
        }

        private fun buildNotification(context: Context): Notification {
            // Tapping it opens the app, which is the only thing a reader would want
            // from it.
            val open = PendingIntent.getActivity(
                context,
                0,
                Intent(context, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )

            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(context, CHANNEL_ID)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(context)
            }

            return builder
                .setContentTitle(context.getString(R.string.link_notification_title))
                .setContentText(context.getString(R.string.link_notification_text))
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setContentIntent(open)
                // Not dismissible: swiping it away would hide a service that is
                // still running, which is worse than showing it.
                .setOngoing(true)
                .build()
        }

        /** Bring the service up. Safe to call when it is already running. */
        fun start(context: Context) {
            val intent = Intent(context, LinkService::class.java)
            runCatching {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            }.onFailure { Diag.log(context, "link service would not start: ${it.message}") }
        }

        /** Take the service down, and its notification with it. */
        fun stop(context: Context) {
            runCatching { context.stopService(Intent(context, LinkService::class.java)) }
                .onFailure { Diag.log(context, "link service would not stop: ${it.message}") }
        }
    }
}
