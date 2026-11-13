package io.gitlab.adviseworn.familysiteblocker.lock

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The lock's words, pinned against the computer's: the add-on's locked-away password page (extension/lockbox.html
 * and extension/lib/lockbox.js) says the same things, and someone who uses both should read the same words.
 */
class WordsTest {
    /** A file of the project, found from wherever the tests are run (Gradle runs them in android/app). */
    private fun inTheProject(path: String): String =
        generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, path) }.first { it.isFile }.readText()

    private fun entry(event: String, vararg details: Pair<String, Any>): JSONObject =
        JSONObject().put("event", event).apply { details.forEach { put(it.first, it.second) } }

    @Test
    fun `the waits offered are the computer's, under the same names`() {
        val menu = Regex("""<select id="lockbox-delay">(.*?)</select>""", RegexOption.DOT_MATCHES_ALL)
            .find(inTheProject("extension/lockbox.html"))!!.groupValues[1]
        val options = Regex("""<option value="(\d+)"[^>]*>([^<]+)</option>""").findAll(menu)
            .map { it.groupValues[1].toLong() to it.groupValues[2].trim() }.toList()
        assertEquals(7, options.size)
        assertEquals("the same waits, in the same order", options.map { it.first }, Words.waits)

        val array = Regex("""<string-array name="lock_waits">(.*?)</string-array>""", RegexOption.DOT_MATCHES_ALL)
            .find(inTheProject("android/app/src/main/res/values/strings.xml"))!!.groupValues[1]
        val names = Regex("<item>([^<]+)</item>").findAll(array).map { it.groupValues[1].trim() }.toList()
        assertEquals("under the same names", options.map { it.second }, names)

        // And each name is how the wait reads everywhere else on the page ("1 minute, to try it out" aside).
        assertTrue(names.first().startsWith(Words.duration(Words.waits.first())))
        assertEquals(names.drop(1), Words.waits.drop(1).map { Words.duration(it) })
    }

    @Test
    fun `a wait reads as on the computer`() {
        assertEquals("1 second", Words.duration(0))
        assertEquals("45 seconds", Words.duration(45))
        assertEquals("1 minute", Words.duration(60))
        assertEquals("10 minutes", Words.duration(600))
        assertEquals("1 hour", Words.duration(3599))
        assertEquals("1 hour", Words.duration(3600))
        assertEquals("3 hours 20 minutes", Words.duration(12_000))
        assertEquals("4 hours", Words.duration(4 * 3600))
        assertEquals("12 hours", Words.duration(12 * 3600))
        assertEquals("1 day", Words.duration(24 * 3600))
        assertEquals("25 hours", Words.duration(25 * 3600))
        assertEquals("2 days", Words.duration(48 * 3600))
        assertEquals("2 days 1 hour", Words.duration(49 * 3600))
        assertEquals("50%", Words.percent(5, 10))
        assertEquals("0%", Words.percent(5, 0))
        assertEquals("100%", Words.percent(11, 10))
    }

    @Test
    fun `a sealed wait stands for the wait that was chosen`() {
        assertEquals(3600, Words.nominal(3599.9997)) // sealed by the first build, the fraction cut off
        assertEquals(3600, Words.nominal(3600.0001))
        assertEquals(3600, Words.nominal(3600.9995)) // the first build's "1 hour to 1 hour"
        assertEquals(3603, Words.nominal(3603.0))
        assertEquals(7200, Words.nominal(7200.2)) // not one of the seven: as it is, to the second
        assertEquals(86_400, Words.nominal(86_399.6))
        assertEquals(60, Words.nominal(60.0))
    }

    @Test
    fun `only waits that are really longer are offered`() {
        assertEquals(listOf(4 * 3600L, 12 * 3600L, 24 * 3600L, 48 * 3600L), Words.longerThan(3600))
        assertEquals(Words.waits, Words.longerThan(59))
        assertEquals(emptyList<Long>(), Words.longerThan(48 * 3600))
        Words.waits.forEach { wait -> assertFalse("${Words.duration(wait)} is not longer than itself", wait in Words.longerThan(wait)) }
        // The lock the first build left on the phone: 1 hour, measured as 3599 or 3601 seconds. 1 hour is not offered.
        listOf(3599.9997, 3600.9995).forEach { assertFalse(3600L in Words.longerThan(Words.nominal(it))) }
    }

    @Test
    fun `the record uses the computer's words`() {
        assertEquals("Lock turned on, with a wait of 1 hour", Words.describe(entry("on", "delay" to 3600)))
        assertEquals("Wait lengthened from 1 hour to 4 hours", Words.describe(entry("lengthened", "from" to 3600, "to" to 14_400)))
        assertEquals("Unlocking started: “To install an app”", Words.describe(entry("started", "why" to "To install an app")))
        assertEquals("Unlocking started", Words.describe(entry("started")))
        assertEquals("Unlocking paused at 40% done", Words.describe(entry("paused", "done" to 40, "steps" to 100)))
        assertEquals("Unlocking carried on, from 40% done", Words.describe(entry("resumed", "done" to 40, "steps" to 100)))
        assertEquals(
            "Unlocking stopped at 40% done; the work was thrown away",
            Words.describe(entry("stopped", "done" to 40, "steps" to 100, "discarded" to true)),
        )
        assertEquals(
            "Unlocking stopped at 40% done by a fault; the work was thrown away",
            Words.describe(entry("stopped", "done" to 40, "steps" to 100, "discarded" to true, "by" to "error")),
        )
        assertEquals("Lock off for 30 minutes", Words.describe(entry("off", "for" to 1800)))
        assertEquals("Accessibility service on", Words.describe(entry("watch-on")))
        assertEquals("Accessibility service off", Words.describe(entry("watch-off")))
        assertEquals("Device administrator on", Words.describe(entry("admin-on")))
        assertEquals("Example App was turned away", Words.describe(entry("blocked-browser", "app" to "Example App")))
        assertEquals("An app that opens web links was turned away", Words.describe(entry("blocked-browser")))
    }

    @Test
    fun `usage access goes by the name the phone's Settings give it`() {
        assertEquals("Usage access", Words.usageAccessName(28))
        assertEquals("Usage access", Words.usageAccessName(35))
        assertEquals("Android 16 renamed it", "App usage data", Words.usageAccessName(36))
        assertEquals("App usage data", Words.usageAccessName(37))
        assertEquals("Usage access on", Words.describe(entry("usage-on")))
        assertEquals("Usage access off", Words.describe(entry("usage-off")))
        assertEquals("App usage data on", Words.describe(entry("usage-on"), Words.usageAccessName(37)))
        assertEquals("App usage data off", Words.describe(entry("usage-off"), Words.usageAccessName(36)))
        // No other line of the record takes the name.
        assertEquals("Accessibility service off", Words.describe(entry("watch-off"), "App usage data"))
    }

    @Test
    fun `entries written by the first build read truthfully`() {
        // It offered 1 hour as longer than a wait of 1 hour, added a second, and wrote "from 1 hour to 1 hour".
        assertEquals("Wait lengthened by 1 second, to 1 hour", Words.describe(entry("lengthened", "from" to 3599, "to" to 3600)))
        // Its Stop unlocking kept the work: a pause, in today's words.
        assertEquals("Unlocking paused at 12% done", Words.describe(entry("stopped", "done" to 12, "steps" to 100)))
        // Its carrying on did not say from where.
        assertEquals("Unlocking carried on", Words.describe(entry("resumed")))
        // Work it had saved is thrown away by the update, and the record says so.
        assertEquals(
            "Unlocking stopped at 12% done by an update of the app; the work was thrown away",
            Words.describe(entry("stopped", "done" to 12, "steps" to 100, "discarded" to true, "by" to "update")),
        )
    }

    @Test
    fun `where the lock stands is read from the record`() {
        val day = { at: String -> at.take(10) }
        assertNull("nothing to go by", Words.standing(emptyList(), day))
        assertNull("the turning on is no longer in the record", Words.standing(listOf(entry("off", "at" to "2026-10-24T08:00:00Z")), day))

        val on = entry("on", "at" to "2026-10-11T12:00:00Z", "delay" to 3600)
        val off = entry("off", "at" to "2026-10-24T08:00:00Z", "for" to 1800)
        val again = entry("on-again-auto", "at" to "2026-10-24T08:30:00Z")
        val off2 = entry("off", "at" to "2026-11-02T19:00:00Z", "for" to 1800)
        assertEquals("On since 2026-10-11, never unlocked.", Words.standing(listOf(on), day))
        assertEquals("On since 2026-10-11, unlocked once, last on 2026-10-24.", Words.standing(listOf(on, off, again), day))
        assertEquals("On since 2026-10-11, unlocked twice, last on 2026-11-02.", Words.standing(listOf(on, off, again, off2, again), day))

        // Turned off for good and on afresh: the count starts over.
        val onAfresh = entry("on", "at" to "2026-11-05T09:00:00Z", "delay" to 14_400)
        assertEquals(
            "On since 2026-11-05, never unlocked.",
            Words.standing(listOf(on, off, entry("turned-off", "at" to "2026-10-24T08:10:00Z"), onAfresh), day),
        )
    }
}
