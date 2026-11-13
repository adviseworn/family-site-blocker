package io.gitlab.adviseworn.familysiteblocker

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AddOnBridgeTest {
    @Test
    fun `the add-on's bedtime is heard and answered`() {
        val heard = mutableListOf<String>()
        val answer = AddOnBridge.answer(JSONObject().put("type", "bedtime").put("bedtime", """{"on":true,"from":1260,"to":300}""")) { heard += it }
        assertTrue(answer)
        assertEquals(listOf("""{"on":true,"from":1260,"to":300}"""), heard)
    }

    @Test
    fun `no bedtime stored is heard too`() {
        val heard = mutableListOf<String>()
        assertTrue(AddOnBridge.answer(JSONObject().put("type", "bedtime").put("bedtime", "null")) { heard += it })
        assertEquals(listOf("null"), heard)
    }

    @Test
    fun `anything else changes nothing and is answered false`() {
        val heard = mutableListOf<String>()
        for (message in listOf<Any>(
            "bedtime",
            JSONObject(),
            JSONObject().put("type", "bedtime"),
            JSONObject().put("type", "bedtime").put("bedtime", JSONObject().put("on", false)),
            JSONObject().put("type", "something else").put("bedtime", "null"),
        )) {
            assertFalse("for $message", AddOnBridge.answer(message) { heard += it })
        }
        assertEquals(emptyList<String>(), heard)
    }
}
