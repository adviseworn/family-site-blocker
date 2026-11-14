package io.gitlab.adviseworn.familysiteblocker

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AddOnPagesTest {
    private val ours = "moz-extension://6e67d57a-fffb-4b66-9318-f4abb489aacc/"
    private val adBlockers = "moz-extension://c8facaf9-56ff-4074-8c0f-65ce1d687792/"

    private fun opens(url: String) = AddOnPages.opens(url, ours, adBlockers)

    @Test
    fun `the web opens as ever`() {
        for (url in listOf(
            "https://alternativeto.net/software/apk-mirror/about/",
            "http://example.com/moz-extension://c8facaf9-56ff-4074-8c0f-65ce1d687792/dashboard.html",
            "about:blank",
            "example.com",
            "what is moz-extension:",
            "",
        )) {
            assertTrue(url, opens(url))
        }
    }

    @Test
    fun `Family Site Blocker's own pages open`() {
        for (page in listOf("options.html", "tries.html", "check.html", "lockbox.html", "blocked.html?site=example.com", "bedtime.html#why", "")) {
            assertTrue(page, opens(ours + page))
        }
        assertTrue("typed in capitals", opens(ours.uppercase() + "options.html"))
    }

    @Test
    fun `uBlock Origin's stopped page opens, with what follows it`() {
        assertTrue(opens(adBlockers + "document-blocked.html"))
        assertTrue(opens(adBlockers + "document-blocked.html?details=%7B%22url%22%3A%22https%3A%2F%2Fexample.com%2F%22%7D"))
        assertTrue(opens(adBlockers + "document-blocked.html#top"))
    }

    @Test
    fun `none of uBlock Origin's other pages opens`() {
        for (page in listOf(
            "dashboard.html",
            "dashboard.html#1p-filters.html",
            "1p-filters.html",
            "3p-filters.html",
            "dyna-rules.html",
            "whitelist.html",
            "settings.html",
            "advanced-settings.html",
            "asset-viewer.html?url=https%3A%2F%2Fexample.com%2Flist.txt&subscribe=1",
            "logger-ui.html",
            "popup-fenix.html",
            "support.html",
            "about.html",
            "background.html",
            "web_accessible_resources/epicker-ui.html",
            "",
        )) {
            assertFalse(page, opens(adBlockers + page))
        }
    }

    @Test
    fun `an address dressed up as the stopped page does not open`() {
        for (url in listOf(
            adBlockers + "document-blocked.html/../dashboard.html",
            adBlockers + "document-blocked.htmlx",
            adBlockers + "document-blocked.html.bak",
            adBlockers + "./document-blocked.html/../dashboard.html",
            adBlockers + "x/../dashboard.html",
            adBlockers + "document-blocked.html%2F..%2Fdashboard.html",
            adBlockers + "document-blocked.html;dashboard.html",
        )) {
            assertFalse(url, opens(url))
        }
    }

    @Test
    fun `however the address is typed, it is the same address`() {
        val settings = adBlockers + "dashboard.html"
        for (url in listOf(
            settings.uppercase(),
            "MOZ-EXTENSION" + settings.removePrefix("moz-extension"),
            "  $settings",
            "\t$settings\n",
            settings.replace("moz-ext", "moz-ext\t"),
            settings.replace("moz-extension:", "moz-exten\nsion:"),
            settings.replace("://", ":"),
            settings.replace("://", ":/"),
            settings.replace("://", ":///"),
            "\u0000$settings",
        )) {
            assertFalse(url.replace("\t", "\\t").replace("\n", "\\n"), opens(url))
        }
    }

    @Test
    fun `what Gecko drops from around a typed address does not hide the address`() {
        val settings = adBlockers + "dashboard.html"
        // A no-break space, a byte-order mark, a line and a paragraph separator, a wide space, a thin one,
        // a next-line control, and two marks that take no room.
        for (around in listOf("\u00A0", "\uFEFF", "\u2028", "\u2029", "\u3000", "\u2009", "\u0085", "\u200B", "\u2060")) {
            val name = "U+%04X".format(around[0].code)
            assertFalse("$name before", opens(around + settings))
            assertFalse("$name after", opens(settings + around))
            assertFalse("$name and a space before", opens("$around $around$settings"))
            assertTrue("$name before one of ours", opens(around + ours + "options.html"))
        }
    }

    @Test
    fun `no address reaches uBlock Origin by naming Family Site Blocker first`() {
        val oursHost = ours.removePrefix("moz-extension://").removeSuffix("/")
        val theirHost = adBlockers.removePrefix("moz-extension://").removeSuffix("/")
        for (url in listOf(
            "moz-extension://$oursHost@$theirHost/dashboard.html",
            "moz-extension://$oursHost:x@$theirHost/dashboard.html",
            "moz-extension://$oursHost.$theirHost/dashboard.html",
            "moz-extension://$oursHost\\@$theirHost/dashboard.html",
            "moz-extension://$oursHost%2F@$theirHost/dashboard.html",
        )) {
            assertFalse(url, opens(url))
        }
    }

    @Test
    fun `another add-on's page does not open`() {
        assertFalse(opens("moz-extension://9a310967-e580-48bf-b3e8-4eafebbc122d/about-compat/aboutCompat.html"))
        assertFalse(opens("moz-extension://not-an-add-on/"))
    }

    @Test
    fun `while uBlock Origin has not said where it is, only Family Site Blocker's pages open`() {
        assertTrue(AddOnPages.opens(ours + "options.html", ours = ours, adBlockers = null))
        assertFalse(AddOnPages.opens(adBlockers + "dashboard.html", ours = ours, adBlockers = null))
        assertFalse(AddOnPages.opens(adBlockers + "document-blocked.html", ours = ours, adBlockers = null))
        assertTrue(AddOnPages.opens("https://example.com/", ours = ours, adBlockers = null))
    }

    @Test
    fun `in the first moments of the first start, what is not known to be uBlock Origin's opens`() {
        // "This site is blocked" and the bedtime page, before Family Site Blocker has said where it is.
        assertTrue(AddOnPages.opens(ours + "blocked.html?site=example.com", ours = null, adBlockers = adBlockers))
        assertTrue(AddOnPages.opens(ours + "bedtime.html", ours = null, adBlockers = null))
        // uBlock Origin's settings stay shut from the moment it has said where it is.
        assertFalse(AddOnPages.opens(adBlockers + "dashboard.html", ours = null, adBlockers = adBlockers))
        assertFalse(AddOnPages.opens(adBlockers + "settings.html", ours = null, adBlockers = adBlockers))
        assertTrue(AddOnPages.opens(adBlockers + "document-blocked.html", ours = null, adBlockers = adBlockers))
        assertTrue(AddOnPages.opens("https://example.com/", ours = null, adBlockers = null))
    }

    @Test
    fun `an address without its last slash is still the add-on's own`() {
        assertTrue(AddOnPages.opens(ours + "options.html", ours = ours.removeSuffix("/"), adBlockers = adBlockers.removeSuffix("/")))
        assertFalse(AddOnPages.opens(adBlockers + "dashboard.html", ours = ours.removeSuffix("/"), adBlockers = adBlockers.removeSuffix("/")))
        // Without the slash a longer name would pass for the same add-on.
        assertFalse(AddOnPages.opens(ours.removeSuffix("/") + "0/options.html", ours = ours.removeSuffix("/"), adBlockers = adBlockers))
    }
}
