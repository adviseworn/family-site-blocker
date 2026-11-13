package io.gitlab.adviseworn.familysiteblocker.lock

import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context

/**
 * Which screen was brought to the front last, from Android's own record of app use. The lock's watch needs it
 * for the screens Android keeps from it. Since Android 14 a screen that guards itself against taps passed
 * through an overlay shows a service that is not an accessibility tool nothing: not that its window has come,
 * and nothing on it. Security & privacy is such a screen, and its Remove access button switches the watch
 * off. The record still names the screen, to an app the person has given usage access ([Permissions.usageOn]).
 */
class Front(context: Context) {
    /** A screen as the record names it: its app, its class, and when it was brought to the front. */
    data class Screen(val packageName: String, val className: String?, val at: Long)

    private val usage = context.applicationContext.getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager
    private var readFrom = 0L
    private var last: Screen? = null

    /**
     * The screen brought to the front most recently, or null when the record names none: the app has no usage
     * access, or nothing has come to the front for [FIRST_READING]. The first reading goes back that far;
     * later ones start at the last screen found, and a clock that was set back starts over.
     */
    @Synchronized
    fun last(now: Long = System.currentTimeMillis()): Screen? {
        if (readFrom == 0L || readFrom > now) {
            readFrom = now - FIRST_READING
            last = null
        }
        val events = runCatching { usage?.queryEvents(readFrom, now + AHEAD) }.getOrNull() ?: return last
        val event = UsageEvents.Event()
        while (events.hasNextEvent()) {
            events.getNextEvent(event)
            if (event.eventType != UsageEvents.Event.ACTIVITY_RESUMED) continue
            val packageName = event.packageName ?: continue
            last = later(last, Screen(packageName, event.className, event.timeStamp))
        }
        last?.let { readFrom = maxOf(readFrom, it.at) }
        return last
    }

    companion object {
        /** How far back the first reading of the record goes, in milliseconds. */
        const val FIRST_READING = 2L * 60 * 60 * 1000

        /** The record is read to a little past now: its clock and the app's are read at different moments. */
        const val AHEAD = 5_000L

        /** The later of two screens; of two brought forward at the same moment, the one named second. */
        fun later(known: Screen?, next: Screen): Screen = if (known == null || next.at >= known.at) next else known
    }
}
