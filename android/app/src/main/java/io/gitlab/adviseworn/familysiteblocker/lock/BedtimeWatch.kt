package io.gitlab.adviseworn.familysiteblocker.lock

import android.Manifest
import android.accessibilityservice.AccessibilityService
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import io.gitlab.adviseworn.familysiteblocker.BrowserActivity
import io.gitlab.adviseworn.familysiteblocker.R
import java.time.ZoneId
import java.util.Date

/**
 * The phone's part of the bedtime, done by the lock's watch ([LockAccessibilityService]) while the lock is
 * on. The add-on blocks every site during a bedtime; with "other apps" switched on from the Lock page, this
 * turns every other app away as well ([BedtimeApps] says which), so that the phone is no use for anything
 * but calls and the clock until morning. And while a bedtime is set, it has the watch cover the Settings
 * screens that set the phone's clock, since the bedtime goes by it.
 *
 * The watch decides what is in front and covers it; this says which apps are turned away, and when
 * ([turnsAway]). An app that was in front already when bedtime began has sent the watch nothing, so every
 * [LOOK_EVERY_MS] of a bedtime this asks the watch for a look ([look]), unless the screen is off. The same
 * clock says ten minutes ahead that bedtime is coming, so that nothing half-written is lost.
 */
class BedtimeWatch(
    private val service: AccessibilityService,
    private val state: LockState,
    private val look: () -> Unit,
) {
    private val setting = BedtimeSetting(service)
    private val handler = Handler(Looper.getMainLooper())
    private val power = service.getSystemService(Context.POWER_SERVICE) as? PowerManager
    @Volatile private var apps: Set<String> = emptySet()
    private var blockedUntilChecked = 0L
    private var blocked = false
    private var toldOf = 0L

    private val tick = object : Runnable {
        override fun run() {
            // With the screen off nobody is using what is in front; it is looked at when the screen comes on.
            if (setting.apps && isBedtime() && power?.isInteractive != false) look()
            warn()
            handler.postDelayed(this, LOOK_EVERY_MS)
        }
    }

    fun start() {
        rescan()
        handler.removeCallbacks(tick)
        handler.postDelayed(tick, LOOK_EVERY_MS)
    }

    fun stop() {
        handler.removeCallbacks(tick)
    }

    /** Re-reads which apps are turned away, off the main thread; the field is volatile, read on the event thread. */
    fun rescan() {
        val app = service.applicationContext
        Thread { apps = BedtimeApps.turnedAway(app) }.start()
    }

    /** Whether an app's screens are to be covered now: other apps switched on, an app that is turned away, and bedtime. */
    fun turnsAway(packageName: String): Boolean = setting.apps && packageName in apps && isBedtime()

    /** Whether the lock holds the phone's clock: a bedtime is set, and it goes by that clock. */
    fun holdsClock(): Boolean = setting.bedtime.goesByTheClock(System.currentTimeMillis())

    /** Until when it is bedtime, in the phone's own way of writing times, or null when it isn't. */
    fun until(): String? = setting.bedtime.endOf(System.currentTimeMillis(), ZoneId.systemDefault())?.let { timeOf(service, it) }

    private fun isBedtime(): Boolean {
        // Asked at every window change while an app is used: the answer is kept for a second.
        val now = SystemClock.elapsedRealtime()
        if (now >= blockedUntilChecked) {
            blocked = setting.bedtime.blockedAt(System.currentTimeMillis(), ZoneId.systemDefault())
            blockedUntilChecked = now + 1000
        }
        return blocked
    }

    /** Says once, in a notification, that bedtime begins within ten minutes. Without leave for notifications it says nothing. */
    private fun warn() {
        if (!state.isOn || !setting.apps) return
        val now = System.currentTimeMillis()
        val begins = setting.bedtime.beginsSoon(now, ZoneId.systemDefault()) ?: return
        if (begins == toldOf) return
        toldOf = begins
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(service, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        val notifications = NotificationManagerCompat.from(service)
        if (!notifications.areNotificationsEnabled()) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            service.getSystemService(NotificationManager::class.java)?.createNotificationChannel(
                NotificationChannel(CHANNEL, service.getString(R.string.bedtime_notification_channel), NotificationManager.IMPORTANCE_DEFAULT),
            )
        }
        val open = PendingIntent.getActivity(
            service,
            0,
            Intent(service, BrowserActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(service, CHANNEL)
            .setSmallIcon(R.drawable.ic_lock_notification)
            .setContentTitle(service.getString(R.string.bedtime_notification_title, timeOf(service, begins)))
            .setContentText(service.getString(R.string.bedtime_notification_text))
            .setStyle(NotificationCompat.BigTextStyle().bigText(service.getString(R.string.bedtime_notification_text)))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setTimeoutAfter(Bedtime.WARN_MS)
            .build()
        @Suppress("MissingPermission") // checked above
        runCatching { notifications.notify(NOTIFICATION, notification) }
    }

    companion object {
        private const val LOOK_EVERY_MS = 20_000L
        private const val CHANNEL = "bedtime"
        private const val NOTIFICATION = 21_00

        /** "9:00 PM", or "21:00" on a phone set to the 24-hour clock. */
        fun timeOf(context: Context, millis: Long): String = android.text.format.DateFormat.getTimeFormat(context).format(Date(millis))

        /** The time of day [minutes] after midnight, written the same way. */
        fun timeOfDay(context: Context, minutes: Int): String =
            timeOf(context, Bedtime.nextAt(minutes, System.currentTimeMillis(), ZoneId.systemDefault()))
    }
}
