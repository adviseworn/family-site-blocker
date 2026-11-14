package io.gitlab.adviseworn.familysiteblocker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AddOnRulesTest {
    /** How often the add-on was installed again. */
    private var installs = 0

    /** What ends the installing under way, once called. */
    private var installOver: (() -> Unit)? = null

    /** What was put off, with its wait, in order: the waits before an installing, and the waits for a word. */
    private val putOff = mutableListOf<Pair<Long, () -> Unit>>()

    private val rules = AddOnRules(
        installAgain = { over ->
            installs += 1
            installOver = over
        },
        later = { wait, run -> putOff += wait to run },
    )

    /** The waits before the add-on is installed again that are running. */
    private fun mends() = putOff.map { it.first }.filter { it != AddOnRules.SILENCE_MS }

    /** Lets the wait before an installing pass. */
    private fun waitForTheInstall() {
        putOff.removeAt(putOff.indexOfFirst { it.first != AddOnRules.SILENCE_MS }).second()
    }

    /** Lets the wait that is running pass and the add-on be installed again. */
    private fun waitAndInstall() {
        waitForTheInstall()
        installOver!!()
        installOver = null
    }

    /** Lets every wait for a word of the add-on pass that has begun, the ones that are over among them. */
    private fun sayNothing() {
        val waits = putOff.filter { it.first == AddOnRules.SILENCE_MS }
        putOff.removeAll(waits)
        waits.forEach { it.second() }
    }

    @Test
    fun `nothing has started before the add-on says so`() {
        assertEquals(AddOnRules.State.STARTING, rules.state)
        assertFalse(rules.started)
        assertEquals(0, installs)
        assertTrue("no wait runs before Gecko has the add-on installed, however long that takes", putOff.isEmpty())

        rules.listening()
        assertEquals("from then on its word is waited for", listOf(AddOnRules.SILENCE_MS), putOff.map { it.first })
        assertEquals(AddOnRules.State.STARTING, rules.state)
    }

    @Test
    fun `what waits for the rules runs once they have started, and at once after that`() {
        val ran = mutableListOf<String>()
        rules.whenStarted { ran += "the tabs" }
        rules.whenStarted { ran += "a page" }
        assertEquals(emptyList<String>(), ran)

        assertTrue(rules.heard(true))
        assertTrue(rules.started)
        assertEquals(listOf("the tabs", "a page"), ran)

        rules.whenStarted { ran += "another page" }
        assertEquals(listOf("the tabs", "a page", "another page"), ran)
        assertTrue(rules.heard(true))
        assertEquals("nothing runs twice", 3, ran.size)
        assertEquals(0, installs)
    }

    @Test
    fun `rules that have not started get the add-on installed again, after a wait`() {
        assertTrue(rules.heard(false))
        assertEquals(0, installs)
        assertEquals(listOf(AddOnRules.WAITS_MS[0]), mends())

        waitAndInstall()
        assertEquals(1, installs)
        assertEquals(AddOnRules.State.STARTING, rules.state)

        assertTrue(rules.heard(true))
        assertTrue(rules.started)
        assertTrue(mends().isEmpty())
    }

    @Test
    fun `while the add-on is being installed again nothing it says is taken`() {
        rules.heard(false)
        // The wait: the add-on that is going says it again, as it does with every alarm.
        assertFalse(rules.heard(false))
        assertEquals("one wait, not two", 1, mends().size)

        // The installing itself: a yes now could be the old one's as well.
        waitForTheInstall()
        assertFalse(rules.heard(true))
        assertFalse(rules.started)

        installOver!!()
        assertTrue(rules.heard(true))
        assertTrue(rules.started)
        assertEquals(1, installs)
    }

    @Test
    fun `for as long as the answer is no it is tried again, less and less often`() {
        val waits = mutableListOf<Long>()
        repeat(AddOnRules.WAITS_MS.size + 2) {
            assertTrue(rules.heard(false))
            waits += mends()[0]
            waitAndInstall()
        }
        assertEquals(AddOnRules.WAITS_MS + List(2) { AddOnRules.WAITS_MS.last() }, waits)
        assertEquals(waits, waits.sorted())
        assertEquals(AddOnRules.WAITS_MS.size + 2, installs)
    }

    @Test
    fun `an add-on that says nothing is taken as one that said no, and the browser says so at once`() {
        rules.listening()
        sayNothing()
        assertEquals(AddOnRules.State.NOT_STARTED, rules.state)
        assertEquals(listOf(AddOnRules.WAITS_MS[0]), mends())
        assertEquals(0, installs)

        waitAndInstall()
        assertEquals(1, installs)
        assertEquals("it is still said while the new one has not spoken", AddOnRules.State.NOT_STARTED, rules.state)

        // The new one says no: that is no reason to say "starting" again.
        assertTrue(rules.heard(false))
        assertEquals(AddOnRules.State.NOT_STARTED, rules.state)
        assertEquals(listOf(AddOnRules.WAITS_MS[1]), mends())
        waitAndInstall()

        assertTrue(rules.heard(true))
        assertTrue(rules.started)
        sayNothing()
        assertTrue("a word in time ends the wait for it", rules.started)
        assertEquals(2, installs)
        assertTrue(mends().isEmpty())
    }

    @Test
    fun `a word in time ends the wait for it, and after each installing the add-on has the same time to speak`() {
        rules.listening()
        assertTrue(rules.heard(false))
        sayNothing()
        assertEquals("the no is being mended already: one wait, not two", listOf(AddOnRules.WAITS_MS[0]), mends())
        assertEquals(AddOnRules.State.STARTING, rules.state)

        waitForTheInstall()
        assertTrue("no wait for a word while the installing lasts", putOff.isEmpty())
        installOver!!()
        assertEquals(listOf(AddOnRules.SILENCE_MS), putOff.map { it.first })

        sayNothing()
        assertEquals(AddOnRules.State.NOT_STARTED, rules.state)
        assertEquals(listOf(AddOnRules.WAITS_MS[1]), mends())
        assertEquals(1, installs)
    }

    @Test
    fun `an add-on that has spoken, or is being installed again, is not waited for a second time`() {
        // Its word can come before the app has finished taking it up.
        assertTrue(rules.heard(true))
        rules.listening()
        assertTrue(putOff.isEmpty())

        assertTrue(rules.heard(false))
        rules.listening()
        assertEquals("only the wait before the installing", listOf(AddOnRules.WAITS_MS[0]), putOff.map { it.first })
    }

    @Test
    fun `the browser says the block list has not started only after several tries, and takes it back when it has`() {
        val said = mutableListOf<AddOnRules.State>()
        val stop = rules.watch { said += it }
        assertEquals(listOf(AddOnRules.State.STARTING), said)

        repeat(AddOnRules.SAY_SO_AFTER) {
            rules.heard(false)
            waitAndInstall()
        }
        assertEquals("still starting", listOf(AddOnRules.State.STARTING), said)

        rules.heard(false)
        assertEquals(listOf(AddOnRules.State.STARTING, AddOnRules.State.NOT_STARTED), said)
        waitAndInstall()

        rules.heard(true)
        assertEquals(AddOnRules.State.STARTED, said.last())

        stop()
        rules.heard(false)
        assertEquals("no longer watched", AddOnRules.State.STARTED, said.last())
    }

    @Test
    fun `rules that stop later close the pages again, and the count of tries starts over`() {
        rules.heard(true)
        var ran = 0
        assertTrue(rules.heard(false))
        assertFalse(rules.started)
        assertEquals(AddOnRules.State.STARTING, rules.state)
        assertEquals(AddOnRules.WAITS_MS[0], mends()[0])
        rules.whenStarted { ran += 1 }
        assertEquals(0, ran)

        waitAndInstall()
        rules.heard(true)
        assertEquals(1, ran)
    }

    @Test
    fun `every address waits for the rules but the app's own`() {
        for (address in listOf(
            "https://example.com/",
            "http://example.com/",
            "HTTPS://EXAMPLE.COM/",
            "view-source:https://example.com/",
            "data:text/html,<iframe src=https://example.com>",
            "javascript:location='https://example.com'",
            "file:///sdcard/Download/page.html",
            "about:config",
            "about:blank?https://example.com/",
            "resource://gre/",
        )) {
            assertTrue(address, AddOnRules.holds(address))
        }
        for (address in listOf(
            "about:blank",
            "moz-extension://36296723-aaf2-4202-80f0-707da62c78e8/options.html#working",
            "moz-extension://36296723-aaf2-4202-80f0-707da62c78e8/blocked.html",
            "resource://android/assets/low_and_medium_risk_error_pages.html?title=x",
        )) {
            assertFalse(address, AddOnRules.holds(address))
        }
    }
}
