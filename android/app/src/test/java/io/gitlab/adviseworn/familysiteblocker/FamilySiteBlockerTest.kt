package io.gitlab.adviseworn.familysiteblocker

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The pages of the add-on that the app's menu opens, held against the add-on's own files (extension/, the
 * folder the add-on is packed from): a page the add-on renames or gives another use must not stay in the menu
 * under its old name.
 */
class FamilySiteBlockerTest {
    private val extension: File = run {
        var folder: File? = File("").absoluteFile
        while (folder != null && !File(folder, "extension/manifest.json").isFile) folder = folder.parentFile
        File(requireNotNull(folder) { "extension/manifest.json is in no folder above ${File("").absolutePath}" }, "extension")
    }

    private fun page(name: String) = File(extension, name).also { assertTrue("$name is a page of the add-on", it.isFile) }.readText()

    /** The words of a string in the app's strings.xml. */
    private fun appString(name: String): String {
        var folder: File? = File("").absoluteFile
        while (folder != null && !File(folder, STRINGS).isFile) folder = folder.parentFile
        val text = File(requireNotNull(folder) { "$STRINGS is in no folder above ${File("").absolutePath}" }, STRINGS).readText()
        return requireNotNull(Regex("""<string name="$name">([^<]*)</string>""").find(text)) { "no string $name" }.groupValues[1]
    }

    @Test
    fun `Settings in the menu opens a page of the add-on`() {
        page(FamilySiteBlocker.SETTINGS_PAGE)
    }

    @Test
    fun `Every try in the menu opens the page headed Every try`() {
        assertTrue(Regex("""<h1[^>]*>${Regex.escape(appString("menu_every_try"))}</h1>""").containsMatchIn(page(FamilySiteBlocker.EVERY_TRY_PAGE)))
    }

    @Test
    fun `Is it working in the menu opens the part of the settings page with that heading`() {
        val settings = page(FamilySiteBlocker.SETTINGS_PAGE)
        val part = Regex("""<section id="${FamilySiteBlocker.IS_IT_WORKING}" aria-labelledby="([^"]+)">""").find(settings)
        val heading = requireNotNull(part) { "the settings page has no part ${FamilySiteBlocker.IS_IT_WORKING}" }.groupValues[1]
        val words = Regex("""<h2 id="${Regex.escape(heading)}">([^<]*)</h2>""").find(settings)?.groupValues?.get(1)
        assertEquals(appString("menu_is_it_working"), words)
    }

    private companion object {
        const val STRINGS = "app/src/main/res/values/strings.xml"
    }
}
