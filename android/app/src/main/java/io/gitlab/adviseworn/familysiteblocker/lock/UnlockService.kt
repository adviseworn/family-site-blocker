package io.gitlab.adviseworn.familysiteblocker.lock

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import io.gitlab.adviseworn.familysiteblocker.BrowserActivity
import io.gitlab.adviseworn.familysiteblocker.R
import kotlin.concurrent.thread

/**
 * Works through the lock's puzzle ([Puzzle.work]) in the background, as a foreground service with a
 * notification that shows how far it has got, so that the wait goes on with the screen off and the app
 * closed. Progress is saved every couple of seconds; stopping and starting again picks up where it was.
 * When the box opens, the lock goes off for a while ([LockState.opened]).
 */
class UnlockService : Service() {
    @Volatile private var running = false
    private var worker: Thread? = null
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            running = false
            LockState(this).stopUnlocking()
            stopSelf()
            return START_NOT_STICKY
        }
        val state = LockState(this)
        val box = state.box
        if (box == null || !state.unlocking) {
            stopSelf()
            return START_NOT_STICKY
        }
        startInForeground(notification(state, box, state.progress))
        if (worker?.isAlive != true) {
            running = true
            // The squarings need the processor awake with the screen off; the lock holds it while the work goes on.
            wakeLock = (getSystemService(Context.POWER_SERVICE) as PowerManager)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "FamilySiteBlocker:unlock")
                .also { it.acquire(48 * 3600 * 1000L) }
            worker = thread(name = "unlock", isDaemon = true) { work(state, box) }
        }
        return START_STICKY
    }

    private fun work(state: LockState, box: Puzzle.Box) {
        var progress = state.progress ?: Puzzle.start()
        var lastSaved = SystemClock.elapsedRealtime()
        var chunk = 512L
        try {
            while (running) {
                val began = SystemClock.elapsedRealtime()
                val next = Puzzle.work(box, progress, chunk) { }
                if (next == null) {
                    state.opened()
                    running = false
                    break
                }
                progress = next
                val took = SystemClock.elapsedRealtime() - began
                // Aim at about half a second per chunk, so stopping is prompt and saving is cheap.
                chunk = (chunk * 500 / maxOf(took, 1)).coerceIn(64, 1L shl 20)
                if (SystemClock.elapsedRealtime() - lastSaved > 2000) {
                    state.saveProgress(progress)
                    lastSaved = SystemClock.elapsedRealtime()
                    manager().notify(NOTIFICATION_ID, notification(state, box, progress))
                }
            }
            if (running) state.saveProgress(progress)
        } catch (error: Exception) {
            state.record("unlock-error", org.json.JSONObject().put("error", error.message ?: error.toString()))
            state.stopUnlocking()
        }
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        running = false
        wakeLock?.let { if (it.isHeld) it.release() }
        super.onDestroy()
    }

    private fun startInForeground(notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun manager() = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    private fun notification(state: LockState, box: Puzzle.Box, progress: Puzzle.Progress?): Notification {
        val manager = manager()
        if (manager.getNotificationChannel(CHANNEL) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL, getString(R.string.lock_notification_channel), NotificationManager.IMPORTANCE_LOW),
            )
        }
        val total = Puzzle.stepsOf(box)
        val done = (progress?.before ?: 0) + (progress?.done ?: 0)
        val left = remainingSeconds(box, progress)
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, BrowserActivity::class.java).putExtra(BrowserActivity.EXTRA_OPEN_LOCK, true),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this, 1,
            Intent(this, UnlockService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_lock_notification)
            .setContentTitle(getString(R.string.lock_notification_title))
            .setContentText(getString(R.string.lock_notification_text, LockState.percent(done, total), LockState.duration(left)))
            .setProgress(1000, if (total > 0) (1000 * done / total).toInt() else 0, false)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .addAction(0, getString(R.string.lock_stop_unlocking), stop)
            .build()
    }

    companion object {
        const val CHANNEL = "phone-lock"
        const val NOTIFICATION_ID = 7001
        const val ACTION_STOP = "io.gitlab.adviseworn.familysiteblocker.lock.STOP"

        /** Starts (or resumes) the work; [LockState.startUnlocking] must have been called. */
        fun start(context: Context) {
            val intent = Intent(context, UnlockService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
        }

        fun stop(context: Context) {
            context.startService(Intent(context, UnlockService::class.java).setAction(ACTION_STOP))
        }

        /** Seconds left at the rates the box's layers were sealed at. */
        fun remainingSeconds(box: Puzzle.Box, progress: Puzzle.Progress?): Long {
            val layers = Puzzle.layersOf(box)
            if (progress == null) return Puzzle.secondsOf(box).toLong()
            var before = progress.before
            var seconds = 0.0
            var inCurrent = true
            var remainingDone = progress.done
            // Layers already opened account for `before` squarings; the current layer has `done` of its own.
            for (layer in layers) {
                if (before >= layer.steps && inCurrent) { before -= layer.steps; continue }
                inCurrent = false
                val done = remainingDone.also { remainingDone = 0 }
                seconds += maxOf(0L, layer.steps - done) / layer.rate
            }
            return seconds.toLong()
        }
    }
}
