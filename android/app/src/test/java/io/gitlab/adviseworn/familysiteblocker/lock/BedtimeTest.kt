package io.gitlab.adviseworn.familysiteblocker.lock

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId
import java.time.ZonedDateTime

class BedtimeTest {
    private val zone = ZoneId.of("America/New_York")
    private val nine = 21 * 60
    private val five = 5 * 60

    /** A moment on the phone's clock in November 2026. */
    private fun at(day: Int, hour: Int, minute: Int = 0, month: Int = 11): Long =
        ZonedDateTime.of(2026, month, day, hour, minute, 0, 0, zone).toInstant().toEpochMilli()

    private val bedtime = Bedtime(on = true, from = nine, to = five)

    @Test
    fun `the add-on's words are read as the add-on reads them`() {
        assertEquals(bedtime, Bedtime.parse("""{"on":true,"from":1260,"to":300}"""))
        assertEquals(
            Bedtime(true, nine, five, Bedtime.Change(on = false, from = nine, to = five, at = 1_794_500_000_000)),
            Bedtime.parse("""{"on":true,"from":1260,"to":300,"next":{"on":false,"from":1260,"to":300,"at":1794500000000,"why":"Travelling","asked":1794413600000}}"""),
        )
        // What a browser writes for whole numbers it holds as floating point.
        assertEquals(bedtime, Bedtime.parse("""{"on":true,"from":1260.0,"to":300.0}"""))
        // Off keeps its times, so that they can be shown.
        assertEquals(Bedtime(false, 22 * 60, 6 * 60), Bedtime.parse("""{"on":false,"from":1320,"to":360}"""))
    }

    @Test
    fun `anything that is not a bedtime is no bedtime`() {
        for (text in listOf(
            null, "", "null", "[]", "nonsense", "{}",
            """{"on":true}""",
            """{"on":true,"from":1260}""",
            """{"on":true,"from":1260,"to":1260}""",
            """{"on":true,"from":-1,"to":300}""",
            """{"on":true,"from":1440,"to":300}""",
            """{"on":true,"from":1260.5,"to":300}""",
            """{"on":true,"from":"1260","to":"300"}""",
        )) {
            assertEquals("for $text", Bedtime.OFF, Bedtime.parse(text))
        }
        assertFalse("on only when it says true", Bedtime.parse("""{"on":"yes","from":1260,"to":300}""").on)
        assertFalse(Bedtime.parse("""{"from":1260,"to":300}""").on)
    }

    @Test
    fun `a change that is not well-formed is left out and the bedtime stays`() {
        for (next in listOf(
            """{"on":false,"from":1260,"to":300}""",
            """{"on":false,"from":1260,"to":1260,"at":1794500000000}""",
            """{"from":1260,"to":300,"at":1794500000000}""",
            """{"on":false,"from":1260,"to":300,"at":"soon"}""",
            """"off"""",
        )) {
            assertEquals("for $next", bedtime, Bedtime.parse("""{"on":true,"from":1260,"to":300,"next":$next}"""))
        }
    }

    @Test
    fun `what is read can be written and read again`() {
        val waiting = Bedtime(true, nine, five, Bedtime.Change(true, 22 * 60, five, at(12, 13)))
        assertEquals(waiting, Bedtime.parse(waiting.toJson().toString()))
        assertEquals(bedtime, Bedtime.parse(bedtime.toJson().toString()))
        assertFalse(JSONObject(bedtime.toJson().toString()).has("next"))
    }

    @Test
    fun `bedtime runs over midnight from its start to its end`() {
        assertFalse(bedtime.blockedAt(at(11, 20, 59), zone))
        assertTrue(bedtime.blockedAt(at(11, 21, 0), zone))
        assertTrue(bedtime.blockedAt(at(11, 23, 59), zone))
        assertTrue(bedtime.blockedAt(at(12, 0, 0), zone))
        assertTrue(bedtime.blockedAt(at(12, 4, 59), zone))
        assertFalse(bedtime.blockedAt(at(12, 5, 0), zone))
        assertFalse(bedtime.blockedAt(at(12, 12, 0), zone))
        // Hours within one day.
        val nap = Bedtime(true, 13 * 60, 14 * 60)
        assertFalse(nap.blockedAt(at(11, 12, 59), zone))
        assertTrue(nap.blockedAt(at(11, 13, 0), zone))
        assertFalse(nap.blockedAt(at(11, 14, 0), zone))
        // Off blocks nothing.
        assertFalse(Bedtime(false, nine, five).blockedAt(at(11, 23), zone))
    }

    @Test
    fun `the hours are the phone's clock's, wherever it is`() {
        val elevenAtNightInNewYork = at(11, 23)
        assertTrue(bedtime.blockedAt(elevenAtNightInNewYork, zone))
        assertFalse("8 PM in Los Angeles", bedtime.blockedAt(elevenAtNightInNewYork, ZoneId.of("America/Los_Angeles")))
    }

    @Test
    fun `a change that waits takes the bedtime's place at its own time`() {
        val off = Bedtime(true, nine, five, Bedtime.Change(on = false, from = nine, to = five, at = at(12, 13)))
        assertTrue("the night before, the bedtime holds", off.blockedAt(at(11, 23), zone))
        assertEquals(off, off.inForce(at(12, 12, 59)))
        assertEquals(Bedtime(false, nine, five), off.inForce(at(12, 13)))
        assertFalse("the night after, there is none", off.blockedAt(at(12, 23), zone))

        val later = Bedtime(true, nine, five, Bedtime.Change(on = true, from = 23 * 60, to = five, at = at(12, 13)))
        assertTrue(later.blockedAt(at(11, 22), zone))
        assertFalse(later.blockedAt(at(12, 22), zone))
        assertTrue(later.blockedAt(at(12, 23), zone))
    }

    @Test
    fun `bedtime ends at the end of its hours`() {
        assertNull(bedtime.endOf(at(11, 20), zone))
        assertEquals(at(12, 5), bedtime.endOf(at(11, 22), zone))
        assertEquals(at(12, 5), bedtime.endOf(at(12, 4, 59), zone))
        assertNull(bedtime.endOf(at(12, 5), zone))
    }

    @Test
    fun `a change that waits can end the bedtime early or run it on`() {
        val turnsOff = Bedtime(true, nine, five, Bedtime.Change(on = false, from = nine, to = five, at = at(11, 23, 30)))
        assertEquals(at(11, 23, 30), turnsOff.endOf(at(11, 22), zone))
        val runsOn = Bedtime(true, nine, five, Bedtime.Change(on = true, from = nine, to = 7 * 60, at = at(12, 2)))
        assertEquals(at(12, 7), runsOn.endOf(at(11, 22), zone))
        val afterTheEnd = Bedtime(true, nine, five, Bedtime.Change(on = false, from = nine, to = five, at = at(12, 13)))
        assertEquals(at(12, 5), afterTheEnd.endOf(at(11, 22), zone))
    }

    @Test
    fun `the night the clocks go back the bedtime still ends when the clock says so`() {
        // November 1, 2026: 2:00 AM comes twice in New York.
        val saturdayNight = ZonedDateTime.of(2026, 10, 31, 22, 0, 0, 0, zone).toInstant().toEpochMilli()
        val fiveOnSunday = ZonedDateTime.of(2026, 11, 1, 5, 0, 0, 0, zone).toInstant().toEpochMilli()
        assertEquals(fiveOnSunday, bedtime.endOf(saturdayNight, zone))
        assertEquals("seven hours on the clock, and the hour that comes twice", 8 * 3_600_000L, fiveOnSunday - saturdayNight)
    }

    @Test
    fun `the phone is told ten minutes before bedtime begins`() {
        assertNull(bedtime.beginsSoon(at(11, 20, 49), zone))
        assertEquals(at(11, 21), bedtime.beginsSoon(at(11, 20, 50), zone))
        assertEquals(at(11, 21), bedtime.beginsSoon(at(11, 20, 59), zone))
        assertNull("it has begun", bedtime.beginsSoon(at(11, 21), zone))
        assertNull(Bedtime(false, nine, five).beginsSoon(at(11, 20, 55), zone))
        // A change that turns it off before the start: nothing begins.
        val offFirst = Bedtime(true, nine, five, Bedtime.Change(on = false, from = nine, to = five, at = at(11, 20, 58)))
        assertNull(offFirst.beginsSoon(at(11, 20, 55), zone))
        // A change that takes effect in the middle of its own hours begins a bedtime then.
        val earlier = Bedtime(true, nine, five, Bedtime.Change(on = true, from = 19 * 60, to = five, at = at(11, 20, 30)))
        assertEquals(at(11, 20, 30), earlier.beginsSoon(at(11, 20, 25), zone))
    }

    @Test
    fun `the clock matters while there is a bedtime`() {
        assertTrue(bedtime.goesByTheClock(at(11, 12)))
        assertFalse(Bedtime.OFF.goesByTheClock(at(11, 12)))
        val turnsOff = Bedtime(true, nine, five, Bedtime.Change(on = false, from = nine, to = five, at = at(12, 13)))
        assertTrue("until the day's wait is over", turnsOff.goesByTheClock(at(12, 12, 59)))
        assertFalse(turnsOff.goesByTheClock(at(12, 13)))
    }

    // --- The Settings screens that set the clock ---------------------------------------------------------

    @Test
    fun `Date and time is a clock screen on a Pixel and on Android 9`() {
        assertTrue(ClockScreen.shows(listOf("Date & time", "Set time automatically", "Date", "November 11, 2026", "Time", "1:30 PM", "Set automatically", "Use location", "Time zone", "GMT-05:00 Eastern Standard Time", "Use locale default", "Use 24-hour format", "1:00 PM")))
        assertTrue(ClockScreen.shows(listOf("Navigate up", "Date & time", "Automatic date & time", "Use network-provided time", "Automatic time zone", "Use network-provided time zone", "Set date", "Set time", "Select time zone", "Automatic 24‑hour format", "Use 24-hour format")))
        // The dialog that sets the time, with the screen it was opened from behind it.
        assertTrue(ClockScreen.shows(listOf("1", "30", "AM", "PM", "Cancel", "OK", "Date & time", "Set time automatically", "Time")))
    }

    @Test
    fun `the time zone's screens are clock screens`() {
        assertTrue(ClockScreen.shows(listOf("Time zone", "Region", "United States", "Time zone", "New York (GMT-05:00)", "Uses Eastern Time. Eastern Daylight Time starts on March 14, 2027.")))
        assertTrue(ClockScreen.shows(listOf("Region", "Search region", "Afghanistan", "Åland Islands", "Albania")))
        assertTrue(ClockScreen.shows(listOf("United States", "Adak (GMT-10:00)", "Anchorage (GMT-09:00)", "Los Angeles (GMT-08:00)", "Denver (GMT-07:00)")))
        assertTrue(ClockScreen.shows(listOf("Select UTC offset", "UTC-12:00", "UTC-11:00")))
        assertTrue(ClockScreen.shows(listOf("Select time zone", "Midway", "GMT-11:00", "Honolulu", "GMT-10:00", "Anchorage", "GMT-09:00")))
    }

    @Test
    fun `other Settings screens are left alone`() {
        // The System list, where Date & time is one line among others.
        assertFalse(ClockScreen.shows(listOf("System", "Languages", "Keyboard", "Gestures", "Date & time", "GMT-05:00 Eastern Standard Time", "Backup", "System update", "Reset options")))
        assertFalse(ClockScreen.shows(listOf("Network & internet", "Internet", "Calls & SMS", "Hotspot & tethering", "Airplane mode")))
        assertFalse(ClockScreen.shows(listOf("App info", "Family Site Blocker", "Open", "Uninstall", "Force stop", "Notifications", "Screen time", "12 minutes today")))
        assertFalse(ClockScreen.shows(listOf("Do Not Disturb", "Schedules", "Sleeping", "10:00 PM – 7:00 AM", "Set time", "Region")))
        assertFalse(ClockScreen.shows(emptyList()))
    }

    // --- The record --------------------------------------------------------------------------------------

    @Test
    fun `the record says what the bedtime turned away`() {
        fun entry(event: String, app: String? = null) = JSONObject().put("event", event).apply { if (app != null) put("app", app) }
        assertEquals("Calculator was turned away at bedtime", Words.describe(entry("blocked-bedtime", "Calculator")))
        assertEquals("An app was turned away at bedtime", Words.describe(entry("blocked-bedtime")))
        assertEquals("A Settings screen for the phone’s clock was turned away", Words.describe(entry("blocked-clock", "Settings")))
        assertEquals("Other apps are turned away at bedtime from now on", Words.describe(entry("bedtime-apps-on")))
        assertEquals("Other apps are left open at bedtime from now on", Words.describe(entry("bedtime-apps-off")))
    }
}
