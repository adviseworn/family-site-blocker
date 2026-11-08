package io.gitlab.adviseworn.familysiteblocker.lock

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
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

        var progress: Puzzle.Progress? = Puzzle.start()
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
        val progress = Puzzle.work(box, Puzzle.start(), 1500) { }!!
        val back = Puzzle.Progress.fromJson(JSONObject(progress.toJson().toString()))
        assertEquals(progress.done, back.done)
        assertEquals(progress.x, back.x)
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

        var progress: Puzzle.Progress? = Puzzle.start()
        var opened: ByteArray? = null
        var sawInner = false
        while (progress != null) {
            progress = Puzzle.work(longer, progress, 1000) { opened = it }
            if (progress?.inner != null) {
                sawInner = true
                assertEquals(4000, progress.before)
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
    fun `waits read as words`() {
        assertEquals("1 minute", LockState.duration(60))
        assertEquals("10 minutes", LockState.duration(600))
        assertEquals("1 hour", LockState.duration(3600))
        assertEquals("4 hours", LockState.duration(4 * 3600))
        assertEquals("2 days", LockState.duration(48 * 3600))
        assertEquals("50%", LockState.percent(5, 10))
        assertNotNull(LockState.duration(1))
    }
}
