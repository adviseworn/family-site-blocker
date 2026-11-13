package io.gitlab.adviseworn.familysiteblocker.lock

import android.Manifest
import android.app.AppOpsManager
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.os.Build
import android.os.Process
import android.provider.Settings
import android.text.TextUtils
import org.json.JSONArray
import org.json.JSONObject
import java.text.DateFormat
import java.util.Date

/**
 * Where the phone's lock stands, kept in its own preferences file: whether it has been turned on, the wait
 * chosen for turning it off, the sealed box that holds that wait, the unlocking under way, how long the lock
 * is off for once the box has been opened, and the record of what has happened (the last [EVENTS_KEPT]
 * entries, oldest first), which the Lock page shows and the add-on lays into Every try.
 *
 * "On" means: turned on, the wait sealed, and not within an off period. Whether the phone lets the lock work
 * (the accessibility service running, the device administrator active, usage access given) is a separate
 * question, [Permissions].
 *
 * Unlocking follows the computer's locked-away password page: it is started (with a reason), it can pause with
 * the work kept (the notification's Pause, or the phone restarting) and be carried on, and Stop unlocking
 * throws the work away. The Lock page, the unlocking service's thread and the accessibility service all change
 * this state, so every change is made under one gate, and the work saved counts only for the box it was done
 * on ([Puzzle.Progress.isFor]).
 */
class LockState(private val context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences("phone_lock", Context.MODE_PRIVATE)

    init {
        dropWorkOfAnEarlierBuild()
    }

    /** The waits offered, in seconds, as on the add-on's locked-away password page ([Words.waits]). */
    val waits: List<Long> get() = Words.waits

    val enabled: Boolean get() = prefs.getBoolean(ENABLED, false)
    val delaySeconds: Long get() = prefs.getLong(DELAY, 3600)
    val box: Puzzle.Box? get() = prefs.getString(BOX, null)?.let { Puzzle.Box.fromJson(JSONObject(it)) }

    /** The unlocking under way or paused: the work saved, when it was done on the box now stored. */
    val progress: Puzzle.Progress? get() {
        val saved = prefs.getString(PROGRESS, null) ?: return null
        val stored = box ?: return null
        return runCatching { Puzzle.Progress.fromJson(JSONObject(saved)) }.getOrNull()?.takeIf { it.isFor(stored) }
    }

    val unlocking: Boolean get() = prefs.getBoolean(UNLOCKING, false)
    val offUntil: Long get() = prefs.getLong(OFF_UNTIL, 0)
    val rate: Double get() = prefs.getFloat(RATE, 0f).toDouble()
    val introShown: Boolean get() = prefs.getBoolean(INTRO_SHOWN, false)

    /** The wait the lock now has, in seconds, as it reads: 3600 for a box sealed for 1 hour ([Words.nominal]). */
    val waitSeconds: Long get() = box?.let { Words.nominal(Puzzle.secondsOf(it)) } ?: delaySeconds

    /**
     * The lock is on: turned on, sealed, and not in an off period. The watch asks this at every change on the
     * screen, so the box is only asked for, not read.
     */
    val isOn: Boolean get() = enabled && prefs.contains(BOX) && System.currentTimeMillis() >= offUntil

    /** The lock is in an off period that has not ended. */
    val isOff: Boolean get() = enabled && System.currentTimeMillis() < offUntil

    fun markIntroShown() = prefs.edit().putBoolean(INTRO_SHOWN, true).apply()

    /** Measures this phone's speed once and keeps it; sealing and lengthening use it. */
    fun rateOrMeasure(): Double {
        val known = rate
        if (known > 0) return known
        val measured = Puzzle.measureRate()
        prefs.edit().putFloat(RATE, measured.toFloat()).apply()
        return measured
    }

    /** Turns the lock on with [delaySeconds] as the wait: seals a fresh box, ends any off period. */
    fun turnOn(delaySeconds: Long) {
        val sealed = Puzzle.seal(ByteArray(32).also { java.security.SecureRandom().nextBytes(it) }, delaySeconds, rateOrMeasure())
        synchronized(gate) {
            prefs.edit()
                .putBoolean(ENABLED, true)
                .putLong(DELAY, delaySeconds)
                .putString(BOX, sealed.toJson().toString())
                .remove(PROGRESS)
                .putBoolean(UNLOCKING, false)
                .putLong(OFF_UNTIL, 0)
                .apply()
            record("on", JSONObject().put("delay", delaySeconds))
        }
    }

    /**
     * Lengthens the wait to [delaySeconds]: the box goes inside a fresh one for the difference. No wait is
     * needed for that. Only a wait that is longer than the present one is taken; any unlocking under way or
     * paused is thrown away first, since its work was done on the box as it was.
     */
    fun lengthen(delaySeconds: Long): Boolean {
        val current = box ?: return false
        val from = waitSeconds
        if (delaySeconds <= from) return false
        cancelUnlocking()
        // The box takes what its squarings take; the new layer makes up the rest of the wait asked for.
        val extra = maxOf(1L, delaySeconds - Math.round(Puzzle.secondsOf(current)))
        val longer = Puzzle.lengthen(current, extra, rateOrMeasure())
        synchronized(gate) {
            if (box?.n != current.n) return false // turned on afresh or lengthened meanwhile
            prefs.edit()
                .putLong(DELAY, delaySeconds)
                .putString(BOX, longer.toJson().toString())
                .remove(PROGRESS)
                .putBoolean(UNLOCKING, false)
                .apply()
            record("lengthened", JSONObject().put("from", from).put("to", delaySeconds))
        }
        return true
    }

    /** Starts the unlocking, or carries on the work that was paused; [UnlockService] then does the squarings. */
    fun startUnlocking(why: String?) = synchronized(gate) {
        val stored = box ?: return@synchronized
        val paused = progress
        val editor = prefs.edit().putBoolean(UNLOCKING, true)
        if (paused == null) editor.remove(PROGRESS) // nothing of another box may be picked up
        editor.apply()
        if (paused == null) {
            record("started", JSONObject().apply { if (!why.isNullOrBlank()) put("why", why) })
        } else {
            record("resumed", JSONObject().put("done", paused.before + paused.done).put("steps", Puzzle.stepsOf(stored)))
        }
    }

    /**
     * Pauses the unlocking: the work done so far is kept and Carry on unlocking picks it up. [at] dates the
     * entry when the pause was only found out afterwards (the phone restarted, or Android stopped the app):
     * then it is the time the work was last saved, as on the computer.
     */
    fun pauseUnlocking(at: String? = null): Boolean = synchronized(gate) {
        if (!unlocking) return false
        prefs.edit().putBoolean(UNLOCKING, false).apply()
        val saved = progress
        record(
            "paused",
            JSONObject().put("done", (saved?.before ?: 0) + (saved?.done ?: 0)).put("steps", box?.let { Puzzle.stepsOf(it) } ?: 0),
            at ?: java.time.Instant.now().toString(),
        )
        true
    }

    /**
     * Stops the unlocking and throws its work away, as Stop unlocking does on the computer: the next unlocking
     * starts from the beginning. [by] says what stopped it when it was not the person ("update", "error").
     * False when there was nothing to stop.
     */
    fun cancelUnlocking(by: String? = null): Boolean = synchronized(gate) {
        val saved = progress
        val wasUnlocking = unlocking
        prefs.edit().putBoolean(UNLOCKING, false).remove(PROGRESS).remove(WORKED_AT).apply()
        if (!wasUnlocking && saved == null) return false // nothing under way and nothing paused
        record(
            "stopped",
            JSONObject()
                .put("done", (saved?.before ?: 0) + (saved?.done ?: 0))
                .put("steps", box?.let { Puzzle.stepsOf(it) } ?: 0)
                .put("discarded", true)
                .apply { if (by != null) put("by", by) },
        )
        true
    }

    /** When the unlocking's work was last saved, as an ISO time; null when none has been. */
    val workedAt: String? get() = prefs.getString(WORKED_AT, null)

    /**
     * Saves the work the unlocking has done on [of]. Refused (false) once the unlocking has been paused or
     * stopped, or the box is no longer the stored one: the thread doing the squarings can be a moment behind
     * the page, and work saved late must not come back as paused work, least of all on a lengthened box.
     */
    fun saveProgress(of: Puzzle.Box, progress: Puzzle.Progress): Boolean = synchronized(gate) {
        if (!unlocking || !progress.isFor(of) || box?.n != of.n) return false
        prefs.edit().putString(PROGRESS, progress.toJson().toString()).putString(WORKED_AT, java.time.Instant.now().toString()).apply()
        true
    }

    /**
     * [of] has been opened: the lock is off for [offSeconds], then on again with the same wait by itself.
     * Refused (false) when the unlocking was stopped or the wait lengthened while the last squarings ran.
     */
    fun opened(of: Puzzle.Box, offSeconds: Long = OFF_SECONDS): Boolean = synchronized(gate) {
        if (!unlocking || box?.n != of.n) return false
        prefs.edit()
            .putBoolean(UNLOCKING, false)
            .remove(PROGRESS)
            .remove(WORKED_AT)
            .putLong(OFF_UNTIL, System.currentTimeMillis() + offSeconds * 1000)
            .apply()
        record("off", JSONObject().put("for", offSeconds))
        true
    }

    /** On again, now: a fresh box with the same wait. Called when the off period ends, or by the person. */
    fun lockAgain(byHand: Boolean) {
        val delay = delaySeconds
        val sealed = Puzzle.seal(ByteArray(32).also { java.security.SecureRandom().nextBytes(it) }, delay, rateOrMeasure())
        synchronized(gate) {
            prefs.edit()
                .putString(BOX, sealed.toJson().toString())
                .remove(PROGRESS)
                .putBoolean(UNLOCKING, false)
                .putLong(OFF_UNTIL, 0)
                .apply()
            record(if (byHand) "on-again" else "on-again-auto", JSONObject())
        }
    }

    /**
     * If an off period has run out, seals the lock again, off the calling thread (sealing takes a moment).
     * The lock already holds meanwhile: [isOn] is true as soon as the off period is over.
     */
    fun relockIfDue() {
        if (!enabled || offUntil == 0L || System.currentTimeMillis() < offUntil) return
        if (!relocking.compareAndSet(false, true)) return
        Thread {
            try { lockAgain(byHand = false) } finally { relocking.set(false) }
        }.start()
    }

    /** Turns the lock off for good: only during an off period, which is the one way out. */
    fun turnOff(): Boolean = synchronized(gate) {
        if (!isOff && box != null) return false
        prefs.edit().putBoolean(ENABLED, false).remove(BOX).remove(PROGRESS).putBoolean(UNLOCKING, false).putLong(OFF_UNTIL, 0).apply()
        record("turned-off", JSONObject())
        true
    }

    /**
     * Work saved by the first build to reach a phone does not say which box it was done on, so it cannot be
     * carried on safely (that build could save old work against a lengthened box). It is thrown away once,
     * with an entry in the record that says so; the unlocking can be started again.
     */
    private fun dropWorkOfAnEarlierBuild() {
        val saved = prefs.getString(PROGRESS, null) ?: return
        if (runCatching { JSONObject(saved).optString("n").isNotEmpty() }.getOrDefault(false)) return
        synchronized(gate) {
            val again = prefs.getString(PROGRESS, null) ?: return
            val old = runCatching { JSONObject(again) }.getOrNull()
            if (old != null && old.optString("n").isNotEmpty()) return
            prefs.edit().putBoolean(UNLOCKING, false).remove(PROGRESS).remove(WORKED_AT).apply()
            record(
                "stopped",
                JSONObject()
                    .put("done", (old?.optLong("before") ?: 0) + (old?.optLong("done") ?: 0))
                    .put("steps", box?.let { Puzzle.stepsOf(it) } ?: 0)
                    .put("discarded", true)
                    .put("by", "update"),
            )
        }
    }

    // --- The record --------------------------------------------------------------------------------------

    /** What has happened to the lock, oldest first: [{ at, event, … }]. */
    fun events(): List<JSONObject> {
        val array = JSONArray(prefs.getString(EVENTS, "[]"))
        return (0 until array.length()).map { array.getJSONObject(it) }
    }

    /**
     * Writes an entry to the record; the add-on is told so that Every try shows it ([LockRecordBridge]). [at]
     * dates it when it did not happen just now (a pause found out afterwards).
     */
    fun record(event: String, details: JSONObject, at: String = java.time.Instant.now().toString()) = synchronized(gate) {
        val entry = JSONObject(details.toString()).put("at", at).put("event", event)
        val array = JSONArray(prefs.getString(EVENTS, "[]"))
        array.put(entry)
        val trimmed = if (array.length() > EVENTS_KEPT) JSONArray((array.length() - EVENTS_KEPT until array.length()).map { array.getJSONObject(it) }) else array
        prefs.edit().putString(EVENTS, trimmed.toString()).putLong(EVENTS_VERSION, prefs.getLong(EVENTS_VERSION, 0) + 1).apply()
        listeners.forEach { it(entry) }
    }

    fun eventsVersion(): Long = prefs.getLong(EVENTS_VERSION, 0)

    /**
     * Writes to the record that usage access was given or taken away. Android tells an app neither, so the
     * watch and the Lock page say what they find, and a change from what was found last is written down.
     */
    fun noteUsageAccess(granted: Boolean) = synchronized(gate) {
        if (prefs.contains(USAGE_ACCESS) && prefs.getBoolean(USAGE_ACCESS, false) == granted) return@synchronized
        val known = prefs.contains(USAGE_ACCESS)
        prefs.edit().putBoolean(USAGE_ACCESS, granted).apply()
        if (granted || known) record(if (granted) "usage-on" else "usage-off", JSONObject())
    }

    fun registerOnChange(listener: SharedPreferences.OnSharedPreferenceChangeListener) = prefs.registerOnSharedPreferenceChangeListener(listener)
    fun unregisterOnChange(listener: SharedPreferences.OnSharedPreferenceChangeListener) = prefs.unregisterOnSharedPreferenceChangeListener(listener)

    /** An entry of the record as a line: its time, then what happened ([Words.describe]). */
    fun describe(entry: JSONObject): String {
        val at = runCatching { DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date.from(java.time.Instant.parse(entry.getString("at")))) }.getOrDefault(entry.optString("at"))
        return "$at: ${Words.describe(entry, Words.usageAccessName(Build.VERSION.SDK_INT))}"
    }

    /** "On since Oct 11, 2026, never unlocked.", from the record; null when it no longer reaches back that far ([Words.standing]). */
    fun standing(): String? = Words.standing(events()) { time ->
        runCatching { DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date.from(java.time.Instant.parse(time))) }.getOrDefault(time)
    }

    companion object {
        private const val ENABLED = "enabled"
        private const val DELAY = "delaySeconds"
        private const val BOX = "box"
        private const val PROGRESS = "progress"
        private const val WORKED_AT = "progressWorkedAt"
        private const val UNLOCKING = "unlocking"
        private const val OFF_UNTIL = "offUntil"
        private const val RATE = "rate"
        private const val EVENTS = "events"
        private const val EVENTS_VERSION = "eventsVersion"
        private const val INTRO_SHOWN = "introShown"
        private const val USAGE_ACCESS = "usageAccess"
        const val EVENTS_KEPT = 500
        /** How long the lock stays off once its box is open. */
        const val OFF_SECONDS = 30L * 60

        /** Every change of the lock's state is made holding this: the page, the unlocking's thread and the services share one process. */
        private val gate = Any()

        private val listeners = mutableListOf<(JSONObject) -> Unit>()
        private val relocking = java.util.concurrent.atomic.AtomicBoolean(false)

        /** Hears every new entry of the record, in the process where it is written. */
        fun addRecordListener(listener: (JSONObject) -> Unit) { listeners += listener }
    }
}

/** What the phone lets the lock do: the things the setup page asks for. */
object Permissions {
    fun accessibilityOn(context: Context): Boolean {
        val expected = ComponentName(context, LockAccessibilityService::class.java).flattenToString()
        val enabled = Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
        val splitter = TextUtils.SimpleStringSplitter(':').also { it.setString(enabled) }
        return splitter.any { it.equals(expected, ignoreCase = true) || ComponentName.unflattenFromString(it)?.let { c -> c.packageName == context.packageName } == true }
    }

    /**
     * Whether the accessibility shortcut is set to this app's service ([Guard.shortcutSetTo]): holding both
     * volume keys, the accessibility button or its gesture would then switch the lock's watch off. Android
     * keeps the lists under names of its own; a list an Android does not have, or does not let an app read,
     * counts as empty.
     */
    fun shortcutOn(context: Context): Boolean = Guard.shortcutSetTo(
        context.packageName,
        listOf(
            "accessibility_shortcut_target_service", "accessibility_button_targets", "accessibility_gesture_targets",
            "accessibility_qs_targets",
        ).map {
            runCatching { Settings.Secure.getString(context.contentResolver, it) }.getOrNull()
        },
    )

    fun adminOn(context: Context): Boolean {
        val manager = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        return manager.isAdminActive(ComponentName(context, LockAdminReceiver::class.java))
    }

    /**
     * Whether the lock needs usage access on this phone: from Android 14 on, where Security & privacy is
     * kept from the watch and only Android's record of app use tells that it is in front ([Front]).
     */
    val usageNeeded: Boolean get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE

    /** Whether the person has given the app usage access. */
    fun usageOn(context: Context): Boolean {
        val ops = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        @Suppress("DEPRECATION") // its successor checks a calling app; this asks about the app itself
        val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName)
        } else {
            ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName)
        }
        return mode == AppOpsManager.MODE_ALLOWED
    }

    /**
     * Whether the phone may want "Allow restricted settings" before it gives the lock something it still
     * lacks. Android 13 and later hold some settings back from an app installed from a file until the person
     * allows them on the app's App info, so the watch leaves that screen open for as long as this lasts
     * ([Guard.undoesTheLock]). The watch asks, so accessibility is on already; what can still be missing is
     * the device administrator and usage access.
     */
    fun mayNeedAllowing(context: Context): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && (!adminOn(context) || (usageNeeded && !usageOn(context)))

    /**
     * Whether a computer can already give this phone commands, over a cable or over Wi-Fi: USB debugging or
     * wireless debugging is on. Such a command can stop the app, and with it the lock's watch. Developer
     * options, where both are switched off, stays open for as long as this lasts ([Guard.wayRound]).
     */
    fun debuggingOn(context: Context): Boolean = globalSwitch(context, Settings.Global.ADB_ENABLED) || globalSwitch(context, "adb_wifi_enabled")

    /**
     * Whether the phone already lets its user be switched, from the lock screen or the quick settings: a
     * guest or another user has no lock. Users, where that is switched off, stays open for as long as this
     * lasts ([Guard.wayRound]).
     */
    fun userSwitchOn(context: Context): Boolean = globalSwitch(context, "user_switcher_enabled")

    /**
     * Whether the app [packageName] may display over other apps: the person has allowed it in Settings, or
     * Android gave it the leave with the app. Another browser that may can float a window the lock does not
     * always cover ([Guard.letsDisplayOver]), so the Lock page names it, and the page that takes the leave
     * away stays open for it. An app Android does not show to this one counts as not allowed.
     */
    fun displaysOver(context: Context, packageName: String): Boolean = runCatching {
        val uid = context.packageManager.getApplicationInfo(packageName, 0).uid
        val ops = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        @Suppress("DEPRECATION") // its successor checks a calling app; this asks about another one
        val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_SYSTEM_ALERT_WINDOW, uid, packageName)
        } else {
            ops.checkOpNoThrow(AppOpsManager.OPSTR_SYSTEM_ALERT_WINDOW, uid, packageName)
        }
        when (mode) {
            AppOpsManager.MODE_ALLOWED -> true
            // Nobody has said yes or no: then it is as Android installed the app.
            AppOpsManager.MODE_DEFAULT ->
                context.packageManager.checkPermission(Manifest.permission.SYSTEM_ALERT_WINDOW, packageName) == PackageManager.PERMISSION_GRANTED
            else -> false
        }
    }.getOrDefault(false)

    /** One of Android's own switches; one it does not have, or does not let an app read, counts as off. */
    private fun globalSwitch(context: Context, name: String): Boolean =
        runCatching { Settings.Global.getInt(context.contentResolver, name, 0) == 1 }.getOrDefault(false)

    /** Everything the lock needs from the phone is in place. */
    fun allGranted(context: Context): Boolean =
        accessibilityOn(context) && !shortcutOn(context) && adminOn(context) && (!usageNeeded || usageOn(context))
}
