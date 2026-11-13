package io.gitlab.adviseworn.familysiteblocker.lock

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONObject
import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime

/**
 * The add-on's bedtime as the app knows it: between two times of day, by the phone's own clock, every site is
 * blocked, every day. The add-on owns the setting (its settings page, a day and a reason to loosen it, its
 * record; extension/lib/bedtime.js holds the rules) and tells the app whenever it changes ([AddOnBridge]),
 * so that the lock can do the phone's part while it is on: turn the other apps away at bedtime
 * ([BedtimeWatch]) and hold the clock the bedtime goes by.
 *
 * [from] and [to] are minutes after midnight, so 9:00 PM to 5:00 AM is 1260 and 300: a bedtime that starts
 * later in the day than it ends runs over midnight. [next] is a change that waits: it takes the bedtime's
 * place at its own time, which the app works out for itself, since the add-on may not be running then.
 */
data class Bedtime(val on: Boolean, val from: Int, val to: Int, val next: Change? = null) {
    /** A change that waits a day: at [at], milliseconds since 1970, it takes the bedtime's place. */
    data class Change(val on: Boolean, val from: Int, val to: Int, val at: Long)

    /** The bedtime in force at [now]: a change that has waited out its time has taken its place. */
    fun inForce(now: Long): Bedtime = if (next != null && now >= next.at) Bedtime(next.on, next.from, next.to) else this

    /** Whether it is bedtime at [now]: on, and the clock within its hours. A change that waits doesn't count yet. */
    fun blockedAt(now: Long, zone: ZoneId): Boolean = inForce(now).let { it.on && within(it.from, it.to, minutesAt(now, zone)) }

    /**
     * When the bedtime in force at [now] ends, or null when it isn't bedtime then: at the end of its hours,
     * unless a change that waits takes its place first, which can end it early or, when its own hours hold at
     * that moment, run it on to their end.
     */
    fun endOf(now: Long, zone: ZoneId): Long? {
        var setting = inForce(now)
        if (!setting.blockedAt(now, zone)) return null
        var at = now
        // The bedtime in force, then the one that takes its place: two steps at most.
        repeat(3) {
            val end = nextAt(setting.to, at, zone)
            val change = setting.next
            at = if (change != null && change.at < end) change.at else end
            setting = setting.inForce(at)
            if (!setting.blockedAt(at, zone)) return at
        }
        return at
    }

    /**
     * The moment bedtime begins, when that is within [WARN_MS] of [now] and it isn't bedtime yet: the start
     * of its hours, unless a change that waits will have turned it off or moved it by then, or the moment
     * such a change takes effect in the middle of its own hours. Null otherwise.
     */
    fun beginsSoon(now: Long, zone: ZoneId): Long? {
        val setting = inForce(now)
        if (setting.blockedAt(now, zone)) return null
        val starts = mutableListOf<Long>()
        if (setting.on) starts += nextAt(setting.from, now, zone)
        setting.next?.let { starts += it.at }
        return starts.filter { it - now <= WARN_MS && setting.blockedAt(it, zone) }.minOrNull()
    }

    /** Whether the phone's clock decides anything at [now]: there is a bedtime, or one may be on its way. */
    fun goesByTheClock(now: Long): Boolean = inForce(now).let { it.on || it.next?.on == true }

    fun toJson(): JSONObject = JSONObject().put("on", on).put("from", from).put("to", to).apply {
        next?.let { put("next", JSONObject().put("on", it.on).put("from", it.from).put("to", it.to).put("at", it.at)) }
    }

    companion object {
        /** How long before a bedtime begins the phone says so, as the add-on tells the pages open. */
        const val WARN_MS = 10 * 60 * 1000L
        private const val DAY_MINUTES = 24 * 60

        /** No bedtime, at the times the add-on offers first: 9:00 PM to 5:00 AM. */
        val OFF = Bedtime(on = false, from = 21 * 60, to = 5 * 60)

        /**
         * The bedtime in the add-on's own words, JSON text { on, from, to, next?: { on, from, to, at } }. Anything
         * that isn't well-formed is left out, as the add-on leaves it out (settingOf): without two different
         * times there is no bedtime.
         */
        fun parse(text: String?): Bedtime {
            val json = runCatching { JSONObject(text ?: "") }.getOrNull() ?: return OFF
            val (from, to) = timesOf(json) ?: return OFF
            val change = json.optJSONObject("next")?.let { next ->
                val times = timesOf(next)
                val on = next.opt("on") as? Boolean
                val at = (next.opt("at") as? Number)?.toDouble()?.takeIf { it.isFinite() }?.toLong()
                if (times != null && on != null && at != null) Change(on, times.first, times.second, at) else null
            }
            return Bedtime(json.opt("on") == true, from, to, change)
        }

        /** Two times of day that aren't the same, or null. */
        private fun timesOf(json: JSONObject): Pair<Int, Int>? {
            val from = minutesOf(json.opt("from")) ?: return null
            val to = minutesOf(json.opt("to")) ?: return null
            return if (from == to) null else from to to
        }

        /** A whole number of minutes after midnight, short of a day, or null. */
        private fun minutesOf(value: Any?): Int? {
            val number = (value as? Number)?.toDouble() ?: return null
            return if (number >= 0 && number < DAY_MINUTES && number == Math.floor(number)) number.toInt() else null
        }

        /** The minutes after midnight at a moment, on the phone's clock. */
        fun minutesAt(now: Long, zone: ZoneId): Int = Instant.ofEpochMilli(now).atZone(zone).let { it.hour * 60 + it.minute }

        /** Whether a time of day falls within a bedtime's hours, which run over midnight when they start later than they end. */
        fun within(from: Int, to: Int, minutes: Int): Boolean = if (from < to) minutes >= from && minutes < to else minutes >= from || minutes < to

        /** The next moment after [now] when the phone's clock reads [minutes] after midnight. */
        fun nextAt(minutes: Int, now: Long, zone: ZoneId): Long {
            val day = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
            val time = LocalTime.of(minutes / 60, minutes % 60)
            val today = ZonedDateTime.of(day, time, zone).toInstant().toEpochMilli()
            return if (today > now) today else ZonedDateTime.of(day.plusDays(1), time, zone).toInstant().toEpochMilli()
        }
    }
}

/** The Settings screens that set the phone's clock, told by their words. */
object ClockScreen {
    /**
     * Whether a Settings screen's words are those of a screen that sets the phone's clock: Date & time itself,
     * the time zone's screens under it, or a list of time zones. Android's own English words, as
     * [LockAccessibilityService] reads the words of the screens about this app. The list of all settings, where
     * "Date & time" is one line among others, is not one of them.
     */
    fun shows(texts: List<String>): Boolean {
        val words = texts.map { it.trim().lowercase() }
        fun has(vararg any: String) = words.any { it in any }
        fun holds(vararg any: String) = words.any { word -> any.any { word.contains(it) } }
        val dateAndTime = has("date & time", "date and time") && holds(
            "set time automatically", "automatic date", "automatic time", "network-provided time", "set automatically",
            "24-hour format", "24‑hour format", "locale default", "select time zone", "set date", "set time",
        )
        val timeZone = has("time zone", "select time zone") && has("region", "select by utc offset", "select utc offset", "select by region")
        val picker = holds("search region") || has("select utc offset")
        val zones = texts.count { ZONE.containsMatchIn(it) } >= 3
        return dateAndTime || timeZone || picker || zones
    }

    private val ZONE = Regex("""\((?:GMT|UTC)[+\-−]\d{1,2}:\d{2}\)|^\s*(?:GMT|UTC)[+\-−]\d{1,2}:\d{2}""")
}

/**
 * What the app keeps about the bedtime, in a preferences file of its own: the add-on's bedtime as last heard,
 * and whether the lock turns the other apps away while it lasts. The second is the lock's to hold: anyone
 * can switch it on, and it comes off only while the lock is off, as with everything the lock holds.
 */
class BedtimeSetting(context: Context) {
    private val prefs: SharedPreferences = context.applicationContext.getSharedPreferences("bedtime", Context.MODE_PRIVATE)

    /** The add-on's bedtime as last heard; [Bedtime.OFF] before the add-on has said anything. */
    val bedtime: Bedtime
        get() {
            val text = prefs.getString(HEARD, null)
            val known = parsed
            if (known != null && known.first == text) return known.second
            return Bedtime.parse(text).also { parsed = text to it }
        }

    /** Whether the lock turns the other apps away at bedtime. */
    val apps: Boolean get() = prefs.getBoolean(APPS, false)

    /** Takes the bedtime from the add-on, as JSON text. Says whether it is news. */
    fun hear(text: String): Boolean {
        val heard = Bedtime.parse(text).toJson().toString()
        if (heard == prefs.getString(HEARD, null)) return false
        prefs.edit().putString(HEARD, heard).apply()
        return true
    }

    /** Switches "other apps" on: the lock turns them away at bedtime. Anyone can, at any time. */
    fun turnAppsAway() = prefs.edit().putBoolean(APPS, true).apply()

    /** Switches "other apps" off again, which the lock lets happen only while it is off. Says whether it did. */
    fun leaveAppsOpen(lockOn: Boolean): Boolean {
        if (lockOn) return false
        prefs.edit().putBoolean(APPS, false).apply()
        return true
    }

    fun registerOnChange(listener: SharedPreferences.OnSharedPreferenceChangeListener) = prefs.registerOnSharedPreferenceChangeListener(listener)
    fun unregisterOnChange(listener: SharedPreferences.OnSharedPreferenceChangeListener) = prefs.unregisterOnSharedPreferenceChangeListener(listener)

    companion object {
        private const val HEARD = "heard"
        private const val APPS = "apps"

        /** The last text read and what it says, so that the lock's watch doesn't parse it at every window change. */
        @Volatile private var parsed: Pair<String?, Bedtime>? = null
    }
}
