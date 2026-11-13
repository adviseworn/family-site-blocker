package io.gitlab.adviseworn.familysiteblocker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** What the page in front may tell the address bar, and when (the first rule inside AddressBar). */
class AddressBarTest {
    private val reached = mutableListOf<String>()
    private val words = WordsHeldWhileTyping { reached += it }

    @Test
    fun `with nobody typing the bar is told at once, every time`() {
        words.told("")
        words.told("kittens")
        words.told("kittens")
        assertEquals(listOf("", "kittens", "kittens"), reached)
    }

    @Test
    fun `while someone types the bar is told nothing`() {
        words.typingStarted()
        words.told("")
        words.told("kittens")
        words.told("")
        assertEquals(emptyList<String>(), reached)
    }

    @Test
    fun `when the typing is over the bar is told the last of it, once`() {
        words.typingStarted()
        words.told("kittens")
        words.told("")
        words.typingOver()
        words.typingOver()
        assertEquals(listOf(""), reached)
        words.told("puppies")
        assertEquals(listOf("", "puppies"), reached)
    }

    @Test
    fun `typing with nothing said in between tells the bar nothing afterwards`() {
        words.told("kittens")
        words.typingStarted()
        words.typingOver()
        assertEquals(listOf("kittens"), reached)
    }

    /** The keyboard goes by this: Mozilla's toolbar says the typing is over far more often than it was on. */
    @Test
    fun `the end of typing counts once, and only after typing`() {
        assertFalse(words.typingOver())
        words.typingStarted()
        assertTrue(words.typingOver())
        assertFalse(words.typingOver())
    }
}
