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
 * closed. Progress is saved every couple of seconds. When the box opens, the lock goes off for a while
 * ([LockState.opened]).
 *
 * The work goes on for as long as [LockState.unlocking] says so, which the thread asks before every batch of
 * squarings: the Lock page's Stop unlocking (the work is thrown away), a lengthened wait and the
 * notification's Pause (the work is kept) all end it by changing the state, and nothing saved after that
 * counts ([LockState.saveProgress]). If the phone restarts or Android stops the app, the work pauses where it
 * was last saved; the Lock page finds that out the next time it is opened ([alive]).
 */
class UnlockService : Service() {
    private var worker: Thread? = null
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val state = LockState(this)
        if (intent?.action == ACTION_PAUSE) {
            // The notification's button. The thread sees the pause before its next batch and ends the service.
            state.pauseUnlocking()
            if (worker?.isAlive != true) finish(nothingToDo = true)
            return START_NOT_STICKY
        }
        val box = state.box
        // Started as a foreground service, so it has to show its notification even when there is nothing to do.
        // Android can refuse that when it restarts the service by itself with the app in the background: the
        // work then pauses where it was last saved, and Carry on unlocking picks it up from the Lock page.
        val shown = runCatching { startInForeground(notification(box, state.progress)) }.isSuccess
        if (!shown) state.pauseUnlocking(state.workedAt)
        if (!shown || box == null || !state.unlocking) {
            finish(nothingToDo = true)
            return START_NOT_STICKY
        }
        if (worker?.isAlive != true) {
            owner = this
            // The squarings need the processor awake with the screen off; the lock holds it while the work goes on.
            wakeLock = (getSystemService(Context.POWER_SERVICE) as PowerManager)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "FamilySiteBlocker:unlock")
                .also { it.acquire(72 * 3600 * 1000L) }
            worker = thread(name = "unlock", isDaemon = true) { work(state, box) }
        }
        return START_STICKY
    }

    private fun work(state: LockState, box: Puzzle.Box) {
        try {
            var progress = state.progress ?: Puzzle.start(box)
            var lastSaved = SystemClock.elapsedRealtime()
            var chunk = 512L
            while (state.unlocking) {
                val began = SystemClock.elapsedRealtime()
                val next = Puzzle.work(box, progress, chunk) { }
                if (next == null) {
                    state.opened(box)
                    break
                }
                progress = next
                val took = SystemClock.elapsedRealtime() - began
                // Aim at about half a second per batch, so that stopping is prompt and saving is cheap.
                chunk = (chunk * 500 / maxOf(took, 1)).coerceIn(64, 1L shl 20)
                if (SystemClock.elapsedRealtime() - lastSaved > 2000) {
                    if (!state.saveProgress(box, progress)) break // paused, stopped or lengthened meanwhile
                    lastSaved = SystemClock.elapsedRealtime()
                    manager().notify(NOTIFICATION_ID, notification(box, progress))
                }
            }
        } catch (error: Exception) {
            // Work that cannot be carried on is thrown away, so that the next unlocking starts clean instead of failing again.
            state.record("unlock-error", org.json.JSONObject().put("error", error.message ?: error.toString()))
            state.cancelUnlocking(by = "error")
        } finally {
            finish()
        }
    }

    /**
     * Ends the service: nothing is being worked on any more. [alive] goes false when the work was this
     * service's, or there was none to do; a service on its way out must not answer for one just started.
     * It goes false last, once the service has been told to stop: the Lock page waits for that before it
     * starts the work again, so a new start never meets a service that is still ending.
     */
    private fun finish(nothingToDo: Boolean = false) {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        if (owner === this || nothingToDo) owner = null
    }

    override fun onDestroy() {
        if (owner === this) owner = null
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

    private fun notification(box: Puzzle.Box?, progress: Puzzle.Progress?): Notification {
        val manager = manager()
        if (manager.getNotificationChannel(CHANNEL) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL, getString(R.string.lock_notification_channel), NotificationManager.IMPORTANCE_LOW),
            )
        }
        val total = box?.let { Puzzle.stepsOf(it) } ?: 0
        val done = (progress?.before ?: 0) + (progress?.done ?: 0)
        val left = box?.let { remainingSeconds(it, progress) } ?: 0
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, BrowserActivity::class.java).putExtra(BrowserActivity.EXTRA_OPEN_LOCK, true),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        // Pause keeps the work, so a stray tap loses nothing. Stop unlocking, which throws it away, is on the
        // Lock page behind a question; a tap on the notification opens that page.
        val pause = PendingIntent.getService(
            this, 1,
            Intent(this, UnlockService::class.java).setAction(ACTION_PAUSE),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_lock_notification)
            .setContentTitle(getString(R.string.lock_notification_title))
            .setContentText(getString(R.string.lock_notification_text, Words.percent(done, total), Words.duration(left)))
            .setProgress(1000, if (total > 0) (1000 * done / total).toInt() else 0, false)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .addAction(0, getString(R.string.lock_pause_unlocking), pause)
            .build()
    }

    companion object {
        const val CHANNEL = "phone-lock"
        const val NOTIFICATION_ID = 7001
        const val ACTION_PAUSE = "io.gitlab.adviseworn.familysiteblocker.lock.PAUSE"

        /**
         * Whether the work is going on in this process: true from [begin] until the thread has ended and
         * told its service to stop. When the state says unlocking and this says no, the work stopped without
         * saying so (the phone restarted, or Android stopped the app), and the Lock page puts the pause on the
         * record. When this says yes and the state says no, work just paused or stopped is still ending.
         */
        val alive: Boolean get() = owner != null

        /** Whose work it is: the service doing it, or [STARTING] between [begin] and the service's start. */
        @Volatile private var owner: Any? = null
        private val STARTING = Any()

        /**
         * Starts the unlocking for the reason [why], or carries on paused work, and sets the squarings going.
         * [alive] is set before the state changes: the Lock page redraws the moment the state says unlocking,
         * and must not take the work that is about to start for work that stopped.
         */
        fun begin(context: Context, state: LockState, why: String?) {
            owner = STARTING
            state.startUnlocking(why)
            val intent = Intent(context, UnlockService::class.java)
            val started = runCatching {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
            }.isSuccess
            // Android can refuse to start the service; the unlocking then stands paused, to be carried on.
            if (!started) {
                owner = null
                state.pauseUnlocking()
            }
        }

        /** Seconds left at the rates the box's layers were sealed at. */
        fun remainingSeconds(box: Puzzle.Box, progress: Puzzle.Progress?): Long {
            val layers = Puzzle.layersOf(box)
            if (progress == null) return Math.round(Puzzle.secondsOf(box))
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
