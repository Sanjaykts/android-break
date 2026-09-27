package dev.breakremote.agent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import dev.breakremote.agent.net.Session
import dev.breakremote.agent.ui.MainActivity

/**
 * Reboot recovery.
 *
 * ### What this deliberately does NOT do
 *
 * It does not start `CaptureService`. On API 34+ a `mediaProjection` foreground
 * service cannot be started without a live MediaProjection, and consent can never
 * be re-acquired silently. Trying produces a crash loop with no user-visible
 * symptom beyond a blank console -- a far worse outcome than asking for one tap.
 *
 * What it does do is the part that is genuinely automatic: bring the relay
 * session back, and post a notification asking for the one tap that cannot be
 * automated.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) {
            return
        }
        Log.i(TAG, "restoring relay session after $action")

        // BOOT_COMPLETED is one of the exemptions to background-start limits, so
        // the outbound WebSocket may be re-established without a foreground
        // service. Screen capture waits for the user.
        Session.start(context.applicationContext)

        if (action == Intent.ACTION_BOOT_COMPLETED) {
            notifyNeedsConsent(context)
        }
    }

    private fun notifyNeedsConsent(context: Context) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "Reconnect",
                    NotificationManager.IMPORTANCE_DEFAULT
                ).apply {
                    description = "Asks for screen sharing again after a restart."
                }
            )
        }

        val reopen = PendingIntent.getActivity(
            context, 1,
            Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val n = Notification.Builder(context, CHANNEL_ID)
            .setContentTitle(context.getString(R.string.app_name) + " needs one tap")
            .setContentText("Screen sharing was cleared by the restart. Tap to allow it again.")
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentIntent(reopen)
            .setAutoCancel(true)
            .build()

        try {
            manager.notify(NOTIFICATION_ID, n)
        } catch (_: SecurityException) {
            // POST_NOTIFICATIONS not granted; the owner will find out when they
            // open the app, which is acceptable.
        }
    }

    companion object {
        const val TAG = "brk/boot"
        private const val CHANNEL_ID = "brk_reconnect"
        private const val NOTIFICATION_ID = 4202
    }
}
