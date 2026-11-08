package io.gitlab.adviseworn.familysiteblocker.lock

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.SharedPreferences
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
 * (the accessibility service running, the device administrator active) is a separate question, [Permissions].
 */
class LockState(private val context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences("phone_lock", Context.MODE_PRIVATE)

    /** The waits offered, in seconds, as on the add-on's locked-away password page. */
    val waits: List<Long> = listOf(60, 600, 3600, 4 * 3600, 12 * 3600, 24 * 3600, 48 * 3600)

    val enabled: Boolean get() = prefs.getBoolean(ENABLED, false)
    val delaySeconds: Long get() = prefs.getLong(DELAY, 3600)
    val box: Puzzle.Box? get() = prefs.getString(BOX, null)?.let { Puzzle.Box.fromJson(JSONObject(it)) }
    val progress: Puzzle.Progress? get() = prefs.getString(PROGRESS, null)?.let { Puzzle.Progress.fromJson(JSONObject(it)) }
    val unlocking: Boolean get() = prefs.getBoolean(UNLOCKING, false)
    val offUntil: Long get() = prefs.getLong(OFF_UNTIL, 0)
    val rate: Double get() = prefs.getFloat(RATE, 0f).toDouble()
    val introShown: Boolean get() = prefs.getBoolean(INTRO_SHOWN, false)

    /** The lock is on: turned on, sealed, and not in an off period. */
    val isOn: Boolean get() = enabled && box != null && System.currentTimeMillis() >= offUntil

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

    /** Lengthens the wait to [delaySeconds]: the box goes inside a fresh one for the difference. No wait needed. */
    fun lengthen(delaySeconds: Long): Boolean {
        val current = box ?: return false
        val now = Puzzle.secondsOf(current).toLong()
        if (delaySeconds <= now) return false
        val longer = Puzzle.lengthen(current, delaySeconds - now, rateOrMeasure())
        prefs.edit()
            .putLong(DELAY, delaySeconds)
            .putString(BOX, longer.toJson().toString())
            .remove(PROGRESS)
            .apply()
        record("lengthened", JSONObject().put("from", now).put("to", delaySeconds))
        return true
    }

    fun startUnlocking(why: String?) {
        prefs.edit().putBoolean(UNLOCKING, true).apply()
        record(if (progress == null) "started" else "resumed", JSONObject().apply { if (!why.isNullOrBlank()) put("why", why) })
    }

    fun stopUnlocking() {
        if (!unlocking) return
        prefs.edit().putBoolean(UNLOCKING, false).apply()
        val p = progress
        record("stopped", JSONObject().put("done", (p?.before ?: 0) + (p?.done ?: 0)).put("steps", box?.let { Puzzle.stepsOf(it) } ?: 0))
    }

    fun saveProgress(progress: Puzzle.Progress) = prefs.edit().putString(PROGRESS, progress.toJson().toString()).apply()

    /** The box is open: the lock is off for [offSeconds], then on again with the same wait by itself. */
    fun opened(offSeconds: Long = OFF_SECONDS) {
        prefs.edit()
            .putBoolean(UNLOCKING, false)
            .remove(PROGRESS)
            .putLong(OFF_UNTIL, System.currentTimeMillis() + offSeconds * 1000)
            .apply()
        record("off", JSONObject().put("for", offSeconds))
    }

    /** On again, now: a fresh box with the same wait. Called when the off period ends, or by the person. */
    fun lockAgain(byHand: Boolean) {
        val delay = delaySeconds
        val sealed = Puzzle.seal(ByteArray(32).also { java.security.SecureRandom().nextBytes(it) }, delay, rateOrMeasure())
        prefs.edit()
            .putString(BOX, sealed.toJson().toString())
            .remove(PROGRESS)
            .putBoolean(UNLOCKING, false)
            .putLong(OFF_UNTIL, 0)
            .apply()
        record(if (byHand) "on-again" else "on-again-auto", JSONObject())
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
    fun turnOff(): Boolean {
        if (!isOff && box != null) return false
        prefs.edit().putBoolean(ENABLED, false).remove(BOX).remove(PROGRESS).putBoolean(UNLOCKING, false).putLong(OFF_UNTIL, 0).apply()
        record("turned-off", JSONObject())
        return true
    }

    // --- The record --------------------------------------------------------------------------------------

    /** What has happened to the lock, oldest first: [{ at, event, … }]. */
    fun events(): List<JSONObject> {
        val array = JSONArray(prefs.getString(EVENTS, "[]"))
        return (0 until array.length()).map { array.getJSONObject(it) }
    }

    /** Writes an entry to the record; the add-on is told so that Every try shows it ([LockRecordBridge]). */
    fun record(event: String, details: JSONObject) {
        val entry = JSONObject(details.toString()).put("at", java.time.Instant.now().toString()).put("event", event)
        val array = JSONArray(prefs.getString(EVENTS, "[]"))
        array.put(entry)
        val trimmed = if (array.length() > EVENTS_KEPT) JSONArray((array.length() - EVENTS_KEPT until array.length()).map { array.getJSONObject(it) }) else array
        prefs.edit().putString(EVENTS, trimmed.toString()).putLong(EVENTS_VERSION, prefs.getLong(EVENTS_VERSION, 0) + 1).apply()
        listeners.forEach { it(entry) }
    }

    fun eventsVersion(): Long = prefs.getLong(EVENTS_VERSION, 0)

    fun registerOnChange(listener: SharedPreferences.OnSharedPreferenceChangeListener) = prefs.registerOnSharedPreferenceChangeListener(listener)
    fun unregisterOnChange(listener: SharedPreferences.OnSharedPreferenceChangeListener) = prefs.unregisterOnSharedPreferenceChangeListener(listener)

    /** Words for an entry of the record. */
    fun describe(entry: JSONObject): String {
        val at = runCatching { DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date.from(java.time.Instant.parse(entry.getString("at")))) }.getOrDefault(entry.optString("at"))
        val what = when (entry.optString("event")) {
            "on" -> "Lock turned on, with a wait of ${duration(entry.optLong("delay"))}"
            "lengthened" -> "Wait lengthened from ${duration(entry.optLong("from"))} to ${duration(entry.optLong("to"))}"
            "started" -> "Unlocking started" + entry.optString("why").let { if (it.isBlank()) "" else ": $it" }
            "resumed" -> "Unlocking resumed"
            "stopped" -> "Unlocking stopped at ${percent(entry.optLong("done"), entry.optLong("steps"))}"
            "off" -> "Lock off for ${duration(entry.optLong("for"))}"
            "on-again" -> "Lock on again, by hand"
            "on-again-auto" -> "Lock on again, by itself"
            "turned-off" -> "Lock turned off"
            "watch-on" -> "The phone lets the lock watch again (accessibility on)"
            "watch-off" -> "The phone stopped the lock's watch (accessibility off)"
            "admin-on" -> "Device administrator on"
            "admin-off" -> "Device administrator off"
            "blocked-browser" -> "Another browser was turned away: ${entry.optString("app")}"
            "blocked-settings" -> "A Settings screen for the lock was turned away"
            else -> entry.optString("event")
        }
        return "$at: $what"
    }

    companion object {
        private const val ENABLED = "enabled"
        private const val DELAY = "delaySeconds"
        private const val BOX = "box"
        private const val PROGRESS = "progress"
        private const val UNLOCKING = "unlocking"
        private const val OFF_UNTIL = "offUntil"
        private const val RATE = "rate"
        private const val EVENTS = "events"
        private const val EVENTS_VERSION = "eventsVersion"
        private const val INTRO_SHOWN = "introShown"
        const val EVENTS_KEPT = 500
        /** How long the lock stays off once its box is open. */
        const val OFF_SECONDS = 30L * 60

        private val listeners = mutableListOf<(JSONObject) -> Unit>()
        private val relocking = java.util.concurrent.atomic.AtomicBoolean(false)

        /** Hears every new entry of the record, in the process where it is written. */
        fun addRecordListener(listener: (JSONObject) -> Unit) { listeners += listener }

        /** "45 seconds", "12 minutes", "3 hours 20 minutes", "2 days". */
        fun duration(seconds: Long): String {
            val s = maxOf(1, seconds)
            if (s < 60) return plural(s, "second")
            val minutes = Math.round(s / 60.0)
            if (minutes < 60) return plural(minutes, "minute")
            val hours = minutes / 60
            if (hours < 48) return listOf(plural(hours, "hour"), if (minutes % 60 > 0) plural(minutes % 60, "minute") else "").filter { it.isNotEmpty() }.joinToString(" ")
            val days = hours / 24
            return listOf(plural(days, "day"), if (hours % 24 > 0) plural(hours % 24, "hour") else "").filter { it.isNotEmpty() }.joinToString(" ")
        }

        private fun plural(count: Long, word: String) = "$count $word${if (count == 1L) "" else "s"}"

        fun percent(done: Long, steps: Long): String = if (steps <= 0) "0%" else "${(100 * done / steps).coerceIn(0, 100)}%"
    }
}

/** What the phone lets the lock do: the three things the setup page asks for. */
object Permissions {
    fun accessibilityOn(context: Context): Boolean {
        val expected = ComponentName(context, LockAccessibilityService::class.java).flattenToString()
        val enabled = Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
        val splitter = TextUtils.SimpleStringSplitter(':').also { it.setString(enabled) }
        return splitter.any { it.equals(expected, ignoreCase = true) || ComponentName.unflattenFromString(it)?.let { c -> c.packageName == context.packageName } == true }
    }

    fun adminOn(context: Context): Boolean {
        val manager = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        return manager.isAdminActive(ComponentName(context, LockAdminReceiver::class.java))
    }

    /** Everything the lock needs from the phone is in place. */
    fun allGranted(context: Context): Boolean = accessibilityOn(context) && adminOn(context)
}
