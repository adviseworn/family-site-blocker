package io.gitlab.adviseworn.familysiteblocker.lock

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PuzzleTest {
    private val secret = "the lock's token".toByteArray()

    /** A rate that makes a one-second box a few thousand squarings: quick to open in a test, slow enough to count. */
    private val rate = 4000.0

    @Test
    fun `a sealed box opens after its squarings and not before`() {
        val box = Puzzle.seal(secret, 1, rate)
        assertEquals(4000, box.steps)
        assertNull("a wrong answer does not open it", Puzzle.open(box, java.math.BigInteger.TEN))

        var progress: Puzzle.Progress? = Puzzle.start(box)
        var opened: ByteArray? = null
        var rounds = 0
        while (progress != null) {
            progress = Puzzle.work(box, progress, 1000) { opened = it }
            rounds++
        }
        assertEquals(4, rounds)
        assertArrayEquals(secret, opened)
    }

    @Test
    fun `progress survives the round trip through JSON`() {
        val box = Puzzle.seal(secret, 1, rate)
        val progress = Puzzle.work(box, Puzzle.start(box), 1500) { }!!
        val back = Puzzle.Progress.fromJson(JSONObject(progress.toJson().toString()))
        assertEquals(progress.done, back.done)
        assertEquals(progress.x, back.x)
        assertEquals("the saved work says which box it was done on", box.n, back.box)
        val boxBack = Puzzle.Box.fromJson(JSONObject(box.toJson().toString()))
        assertEquals(box.n, boxBack.n)
        assertArrayEquals(box.ciphertext, boxBack.ciphertext)
        // The work goes on from the saved progress and opens the box.
        var p: Puzzle.Progress? = back
        var opened: ByteArray? = null
        while (p != null) p = Puzzle.work(boxBack, p, 1000) { opened = it }
        assertArrayEquals(secret, opened)
    }

    @Test
    fun `lengthening wraps the box in a longer puzzle that opens onto it`() {
        val box = Puzzle.seal(secret, 1, rate)
        val longer = Puzzle.lengthen(box, 1, rate)
        assertEquals(Puzzle.Holds.BOX, longer.holds)
        assertEquals(8000, Puzzle.stepsOf(longer))
        assertEquals(2.0, Puzzle.secondsOf(longer), 0.001)
        assertEquals(listOf(Puzzle.Layer(4000, rate), Puzzle.Layer(4000, rate)), Puzzle.layersOf(longer))

        var progress: Puzzle.Progress? = Puzzle.start(longer)
        var opened: ByteArray? = null
        var sawInner = false
        while (progress != null) {
            progress = Puzzle.work(longer, progress, 1000) { opened = it }
            if (progress?.inner != null) {
                sawInner = true
                assertEquals(4000, progress.before)
                assertEquals("work inside the box still counts for the box that is stored", longer.n, progress.box)
                // It survives being saved while inside, too.
                assertTrue(Puzzle.Progress.fromJson(JSONObject(progress.toJson().toString())).isFor(longer))
            }
        }
        assertTrue("the outer layer opened onto the inner box", sawInner)
        assertArrayEquals(secret, opened)
    }

    @Test
    fun `the time left counts the layers still closed`() {
        val box = Puzzle.lengthen(Puzzle.seal(secret, 10, rate), 5, rate)
        assertEquals(15, UnlockService.remainingSeconds(box, null))
        val halfway = Puzzle.Progress(java.math.BigInteger.valueOf(2), 10_000, 0, null) // half the outer layer (20 000 steps)
        assertEquals(12, UnlockService.remainingSeconds(box, halfway))
        val inner = Puzzle.Progress(java.math.BigInteger.valueOf(2), 20_000, 20_000, Puzzle.Box.fromJson(Puzzle.seal(secret, 10, rate).toJson()))
        assertEquals(5, UnlockService.remainingSeconds(box, inner))
    }

    @Test
    fun `the rate is measured as a positive number`() {
        assertTrue(Puzzle.measureRate(100) > 100)
    }

    @Test
    fun `a wait is sealed to the nearest squaring, so 1 hour measures back as 1 hour`() {
        // The first build to reach a phone cut the fraction off: at 2777.7777 squarings a second, 1 hour came
        // to 9999999 squarings, a hair under 3600 seconds, which read back as 3599 and let "1 hour" be offered
        // as a wait longer than the 1 hour the lock had.
        for (speed in listOf(2777.7777, 31234.56, 999.999, 54321.9)) {
            val box = Puzzle.seal(secret, 3600, speed)
            assertEquals(Math.round(3600 * speed), box.steps)
            assertEquals(3600.0, Puzzle.secondsOf(box), 0.001)
            assertEquals(3600, Words.nominal(Puzzle.secondsOf(box)))
            assertEquals(3600, UnlockService.remainingSeconds(box, null))
        }
    }

    @Test
    fun `a longer wait adds what is missing, whatever build sealed the box`() {
        val speed = 2777.7777
        // A box as the first build sealed it for 1 hour (the fraction cut off), and the same box after that
        // build "lengthened" it from 1 hour to 1 hour, which added a second. Both stand for a wait of 1 hour.
        val old = Puzzle.seal(secret, 3600, speed).copy(steps = (3600 * speed).toLong())
        assertEquals(3599, Puzzle.secondsOf(old).toLong())
        assertEquals(3600, Words.nominal(Puzzle.secondsOf(old)))
        val oldTwice = Puzzle.lengthen(old, 1, speed).copy(steps = speed.toLong())
        assertEquals(3601, Math.round(Puzzle.secondsOf(oldTwice)))
        assertEquals(3600, Words.nominal(Puzzle.secondsOf(oldTwice)))
        // Lengthened to 4 hours as LockState.lengthen does it: the new layer makes up the rest of the wait.
        for (box in listOf(old, oldTwice, Puzzle.seal(secret, 3600, speed))) {
            val extra = 4 * 3600 - Math.round(Puzzle.secondsOf(box))
            val longer = Puzzle.lengthen(box, extra, speed)
            assertEquals(4 * 3600L, Words.nominal(Puzzle.secondsOf(longer)))
            assertEquals(4 * 3600.0, Puzzle.secondsOf(longer), 0.01)
        }
    }

    @Test
    fun `work done on one box is refused on another`() {
        val box = Puzzle.seal(secret, 1, rate)
        val longer = Puzzle.lengthen(box, 1, rate)
        val onTheOld = Puzzle.work(box, Puzzle.start(box), 1500) { }!!
        assertTrue(onTheOld.isFor(box))
        assertFalse("lengthening stores a new box; the old work is not for it", onTheOld.isFor(longer))
        assertThrows(IllegalStateException::class.java) { Puzzle.work(longer, onTheOld, 1000) { } }
        // Work saved by the first build to reach a phone does not say whose it is, and counts for no box.
        val unsigned = Puzzle.Progress.fromJson(JSONObject(onTheOld.toJson().toString()).apply { remove("n") })
        assertNull(unsigned.box)
        assertFalse(unsigned.isFor(box))
        assertThrows(IllegalStateException::class.java) { Puzzle.work(box, unsigned, 1000) { } }
        // Nor does work that says it has done more squarings than the layer has.
        assertThrows(IllegalStateException::class.java) { Puzzle.work(box, onTheOld.copy(done = 4001), 1000) { } }
    }
}
