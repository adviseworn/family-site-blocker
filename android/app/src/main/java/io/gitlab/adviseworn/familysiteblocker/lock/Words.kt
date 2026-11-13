package io.gitlab.adviseworn.familysiteblocker.lock

import org.json.JSONObject

/**
 * The lock's words and numbers that need no phone to work out: which waits are offered, how a wait reads,
 * what each entry of the record says, and the line on where the lock stands. Kept apart from [LockState] so
 * that the unit tests can pin them.
 *
 * They follow the add-on's locked-away password page on a computer (extension/lockbox.html and
 * extension/lib/lockbox.js): the same seven waits under the same names, a whole number of days read in days,
 * and the same words for the same things (Start unlocking, Carry on unlocking, Stop unlocking, "paused at",
 * "carried on, from", "the work was thrown away"). Someone who uses both should not have to learn two sets.
 */
object Words {
    /** The waits offered, in seconds: the computer's "Wait before it can be seen again" menu. */
    val waits: List<Long> = listOf(60, 600, 3600, 4 * 3600, 12 * 3600, 24 * 3600, 48 * 3600)

    /**
     * The wait a sealed box stands for, from the seconds its squarings take. A wait is sealed as a whole number
     * of squarings, so a box sealed for 1 hour takes a hair under or over 3600 seconds; it is still a wait of
     * 1 hour. Within two seconds of an offered wait it is that wait (the first build to reach a phone could add
     * a single second when "lengthening" 1 hour to 1 hour).
     */
    fun nominal(seconds: Double): Long {
        val rounded = Math.round(seconds)
        return waits.firstOrNull { Math.abs(it - rounded) <= 2 } ?: rounded
    }

    /** The offered waits that are longer than a wait of [seconds]: what Lengthen the wait may offer. */
    fun longerThan(seconds: Long): List<Long> = waits.filter { it > seconds }

    /**
     * "45 seconds", "12 minutes", "3 hours 20 minutes", "1 day", "2 days": a wait in words, as
     * extension/lib/lockbox.js writes it. A whole number of days reads in days, as the menu of waits puts it.
     */
    fun duration(seconds: Long): String {
        val s = maxOf(1, seconds)
        if (s < 60) return plural(s, "second")
        val minutes = Math.round(s / 60.0)
        if (minutes < 60) return plural(minutes, "minute")
        val hours = minutes / 60
        if (hours < 48 && minutes % 1440 != 0L) {
            return listOf(plural(hours, "hour"), if (minutes % 60 > 0) plural(minutes % 60, "minute") else "").filter { it.isNotEmpty() }.joinToString(" ")
        }
        val days = hours / 24
        return listOf(plural(days, "day"), if (hours % 24 > 0) plural(hours % 24, "hour") else "").filter { it.isNotEmpty() }.joinToString(" ")
    }

    private fun plural(count: Long, word: String) = "$count $word${if (count == 1L) "" else "s"}"

    /** "40%": how far the unlocking has got. */
    fun percent(done: Long, steps: Long): String = if (steps <= 0) "0%" else "${(100 * done / steps).coerceIn(0, 100)}%"

    /** "once", "twice", "3 times". */
    fun times(count: Int): String = when (count) { 1 -> "once"; 2 -> "twice"; else -> "$count times" }

    /**
     * What the phone's Settings call the permission to read Android's record of app use, on an Android of
     * the API level [sdk]: "Usage access" up to Android 15, "App usage data" from Android 16 (level 36) on.
     * The Lock page and the record say it as the phone does.
     */
    fun usageAccessName(sdk: Int): String = if (sdk >= 36) "App usage data" else "Usage access"

    /**
     * What an entry of the record says happened, without its time. Entries are kept as they were written, so
     * the words for an entry from an earlier build are chosen here: the first build to reach a phone wrote a
     * pause as "stopped" (its Stop unlocking kept the work), where "stopped" now carries `discarded` and means
     * what it means on the computer, the work thrown away. [usageAccess] is the phone's name for usage access
     * ([usageAccessName]).
     */
    fun describe(entry: JSONObject, usageAccess: String = "Usage access"): String {
        val at = percent(entry.optLong("done"), entry.optLong("steps"))
        return when (entry.optString("event")) {
            "on" -> "Lock turned on, with a wait of ${duration(entry.optLong("delay"))}"
            "lengthened" -> {
                val from = entry.optLong("from")
                val to = entry.optLong("to")
                // Two waits that read the same (1 hour to 1 hour, the first build's slip) say nothing: say what was added.
                if (duration(from) == duration(to)) "Wait lengthened by ${duration(to - from)}, to ${duration(to)}"
                else "Wait lengthened from ${duration(from)} to ${duration(to)}"
            }
            "started" -> "Unlocking started" + entry.optString("why").let { if (it.isBlank()) "" else ": “$it”" }
            "paused" -> "Unlocking paused at $at done"
            "resumed" -> if (entry.has("steps")) "Unlocking carried on, from $at done" else "Unlocking carried on"
            "stopped" -> when {
                !entry.optBoolean("discarded") -> "Unlocking paused at $at done"
                entry.optString("by") == "update" -> "Unlocking stopped at $at done by an update of the app; the work was thrown away"
                entry.optString("by") == "error" -> "Unlocking stopped at $at done by a fault; the work was thrown away"
                else -> "Unlocking stopped at $at done; the work was thrown away"
            }
            "unlock-error" -> "Unlocking failed" + entry.optString("error").let { if (it.isBlank()) "" else ": $it" }
            "off" -> "Lock off for ${duration(entry.optLong("for"))}"
            "on-again" -> "Lock on again, by hand"
            "on-again-auto" -> "Lock on again, by itself"
            "turned-off" -> "Lock turned off"
            "watch-on" -> "Accessibility service on"
            "watch-off" -> "Accessibility service off"
            "admin-on" -> "Device administrator on"
            "admin-off" -> "Device administrator off"
            "usage-on" -> "$usageAccess on"
            "usage-off" -> "$usageAccess off"
            "blocked-browser" -> entry.optString("app").let { if (it.isBlank()) "An app that opens web links was turned away" else "$it was turned away" }
            "blocked-settings" -> "A Settings screen for the lock was turned away"
            "blocked-security" -> "Security & privacy was turned away"
            "blocked-bedtime" -> entry.optString("app").let { if (it.isBlank()) "An app was turned away at bedtime" else "$it was turned away at bedtime" }
            "blocked-clock" -> "A Settings screen for the phone’s clock was turned away"
            "bedtime-apps-on" -> "Other apps are turned away at bedtime from now on"
            "bedtime-apps-off" -> "Other apps are left open at bedtime from now on"
            else -> entry.optString("event")
        }
    }

    /**
     * Where the lock stands while it is on, as the computer's page puts it for the password: "On since Oct 11,
     * 2026, never unlocked." or "On since Oct 11, 2026, unlocked twice, last on Oct 24, 2026." From the record:
     * since it was last turned on, and how often its wait has been worked through since. Null when the record
     * no longer reaches back to the turning on. [day] turns an entry's time into a date.
     */
    fun standing(events: List<JSONObject>, day: (String) -> String): String? {
        val from = events.indexOfLast { it.optString("event") == "on" }
        if (from < 0) return null
        val opened = events.drop(from).filter { it.optString("event") == "off" }
        val unlocks = if (opened.isEmpty()) "never unlocked" else "unlocked ${times(opened.size)}, last on ${day(opened.last().optString("at"))}"
        return "On since ${day(events[from].optString("at"))}, $unlocks."
    }
}
