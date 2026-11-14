package io.gitlab.adviseworn.familysiteblocker

import java.io.File
import java.net.URLEncoder
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The address the browser searches with, held against the add-on's own safe search rules
 * (extension/rules/safe-search.json, the file the add-on is packed with).
 */
class SearchTest {
    private val rules: List<JSONObject> = run {
        var folder: File? = File("").absoluteFile
        while (folder != null && !File(folder, RULES).isFile) folder = folder.parentFile
        val text = File(requireNotNull(folder) { "$RULES is in no folder above ${File("").absolutePath}" }, RULES).readText()
        JSONArray(text).let { all -> (0 until all.length()).map { all.getJSONObject(it) } }
    }

    /** The address for these words, with the words encoded as Mozilla's SearchUrlBuilder encodes them. */
    private fun addressFor(words: String) =
        Search.TEMPLATE.replace("{searchTerms}", URLEncoder.encode(words, "UTF-8").replace("+", "%20"))

    /** The add-on's rules that apply to an address. A rule's pattern may match anywhere and takes no note of case. */
    private fun rulesFor(address: String, type: String) = rules.filter { rule ->
        rule.getJSONObject("action").getString("type") == type &&
            Regex(rule.getJSONObject("condition").getString("regexFilter"), RegexOption.IGNORE_CASE).containsMatchIn(address)
    }

    @Test
    fun `a search goes to Google over https and asks for the strict filter`() {
        assertEquals("https://www.google.com/search?q=example&safe=active", addressFor("example"))
    }

    @Test
    fun `the add-on's safe search knows the address and lets it through as it is`() {
        assertEquals(1, rulesFor(addressFor("example"), "allow").size)
    }

    @Test
    fun `the setting is the one the add-on would add itself`() {
        val setting = "&safe=active"
        assertTrue(Search.TEMPLATE.endsWith(setting))
        val without = addressFor("example").removeSuffix(setting)
        assertEquals(emptyList<JSONObject>(), rulesFor(without, "allow"))
        val adds = rulesFor(without, "redirect").single()
            .getJSONObject("action").getJSONObject("redirect").getJSONObject("transform")
            .getJSONObject("queryTransform").getJSONArray("addOrReplaceParams")
        assertEquals(1, adds.length())
        assertEquals("safe", adds.getJSONObject(0).getString("key"))
        assertEquals("active", adds.getJSONObject(0).getString("value"))
    }

    @Test
    fun `the words searched for cannot take the setting away`() {
        for (words in listOf("cats&safe=off", "cats#", "cats?safe=off&", "two words", "50% + 1", "söka")) {
            val address = addressFor(words)
            assertEquals("for $words", 1, rulesFor(address, "allow").size)
            assertEquals("for $words", 1, Regex("[?&]safe=").findAll(address).count())
            assertFalse("for $words", address.contains('#') || address.contains(' '))
        }
    }

    private companion object {
        const val RULES = "extension/rules/safe-search.json"
    }
}
