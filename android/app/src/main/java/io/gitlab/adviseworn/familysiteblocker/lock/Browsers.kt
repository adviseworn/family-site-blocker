package io.gitlab.adviseworn.familysiteblocker.lock

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import android.net.Uri
import android.os.Build

/** The other browsers on this phone: every app that offers to open web links, found afresh each time it is asked. */
object Browsers {
    private val probes = listOf("https://example.com/", "http://example.com/")

    /**
     * Package names of the browsers on the phone, this one left out: the apps that take every web address
     * (the test Android itself uses when it offers a default browser: a filter for http or https links with
     * no host of its own, or the browser category) and have an icon to launch them by. Apps that open only
     * their own site's links (YouTube, say), and system helpers without an icon (the carrier's sign-in page),
     * are not browsers.
     */
    fun packages(context: Context): Set<String> {
        val pm = context.packageManager
        val found = mutableSetOf<String>()
        for (url in probes) {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE)
            // Not MATCH_DISABLED_COMPONENTS: on Android 9 it answers with only the disabled handlers (the carrier's
            // captive-portal page) and leaves the live browsers out.
            @Suppress("DEPRECATION")
            val flags = PackageManager.MATCH_ALL or PackageManager.GET_RESOLVED_FILTER
            val activities = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                pm.queryIntentActivities(intent, PackageManager.ResolveInfoFlags.of(flags.toLong()))
            } else {
                @Suppress("DEPRECATION")
                pm.queryIntentActivities(intent, flags)
            }
            activities.filter { takesEveryWebAddress(it) }.mapNotNullTo(found) { it.activityInfo?.packageName }
        }
        found.remove(context.packageName)
        return found.filterTo(mutableSetOf()) { pm.getLaunchIntentForPackage(it) != null }
    }

    /** Android's own test for a browser, done on the matched filter: web links with no host named, or the browser category. */
    private fun takesEveryWebAddress(info: ResolveInfo): Boolean {
        val filter = info.filter ?: return false
        if (filter.hasCategory(Intent.CATEGORY_APP_BROWSER)) return true
        val web = filter.hasDataScheme("http") || filter.hasDataScheme("https")
        return web && filter.countDataAuthorities() == 0
    }

    /**
     * Browsers known by the name of their package, with what they are called. Android shows an app only the
     * apps of its own part of the phone: a browser installed in a Private space or a work profile and nowhere
     * else is not among [packages], though the watch is told when it comes to the front. One on this list is
     * turned away there all the same. A browser that is not on it, installed only in such a place, is out of
     * the lock's reach.
     */
    val knownByName: Map<String, String> = mapOf(
        "com.android.chrome" to "Chrome",
        "com.chrome.beta" to "Chrome Beta",
        "com.chrome.dev" to "Chrome Dev",
        "com.chrome.canary" to "Chrome Canary",
        "org.chromium.chrome" to "Chromium",
        "org.mozilla.firefox" to "Firefox",
        "org.mozilla.firefox_beta" to "Firefox Beta",
        "org.mozilla.fenix" to "Firefox Nightly",
        "org.mozilla.focus" to "Firefox Focus",
        "org.mozilla.klar" to "Firefox Klar",
        "org.mozilla.fennec_fdroid" to "Fennec",
        "com.brave.browser" to "Brave",
        "com.brave.browser_beta" to "Brave Beta",
        "com.brave.browser_nightly" to "Brave Nightly",
        "com.microsoft.emmx" to "Edge",
        "com.microsoft.emmx.beta" to "Edge Beta",
        "com.microsoft.emmx.dev" to "Edge Dev",
        "com.microsoft.emmx.canary" to "Edge Canary",
        "com.opera.browser" to "Opera",
        "com.opera.browser.beta" to "Opera Beta",
        "com.opera.mini.native" to "Opera Mini",
        "com.opera.gx" to "Opera GX",
        "com.duckduckgo.mobile.android" to "DuckDuckGo",
        "com.sec.android.app.sbrowser" to "Samsung Internet",
        "com.sec.android.app.sbrowser.beta" to "Samsung Internet Beta",
        "com.vivaldi.browser" to "Vivaldi",
        "com.vivaldi.browser.snapshot" to "Vivaldi Snapshot",
        "com.kiwibrowser.browser" to "Kiwi Browser",
        "org.torproject.torbrowser" to "Tor Browser",
        "org.torproject.torbrowser_alpha" to "Tor Browser Alpha",
        "com.UCMobile.intl" to "UC Browser",
        "com.yandex.browser" to "Yandex Browser",
        "com.ecosia.android" to "Ecosia",
        "com.qwant.liberty" to "Qwant",
        "org.bromite.bromite" to "Bromite",
        "org.cromite.cromite" to "Cromite",
        "app.vanadium.browser" to "Vanadium",
        "com.mi.globalbrowser" to "Mi Browser",
        "com.android.browser" to "Browser",
        "com.huawei.browser" to "Huawei Browser",
        "com.amazon.cloud9" to "Silk",
        "mark.via.gp" to "Via",
        "com.cloudmosa.puffinFree" to "Puffin",
        "org.adblockplus.browser" to "Adblock Browser",
        "com.ghostery.android.ghostery" to "Ghostery",
        "com.naver.whale" to "Whale",
        "org.lineageos.jelly" to "Jelly",
        "us.spotco.fennec_dos" to "Mull",
        "io.github.forkmaintainers.iceraven" to "Iceraven",
        "org.ironfoxoss.ironfox" to "IronFox",
    )

    /**
     * The app's name for a package; for one this app is not shown, what it is known as ([knownByName]) or,
     * failing that, the package name.
     */
    fun label(context: Context, packageName: String): String = runCatching {
        val pm = context.packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(packageName, 0)).toString()
    }.getOrDefault(knownByName[packageName] ?: packageName)

    /** The apps whose screens the lock guards while on: Settings, the package installer, the permission manager. */
    val guarded: Set<String> = setOf(
        "com.android.settings",
        "com.android.packageinstaller",
        "com.google.android.packageinstaller",
        "com.samsung.android.packageinstaller",
        "com.miui.packageinstaller",
        "com.android.permissioncontroller",
        "com.google.android.permissioncontroller",
    )

    /**
     * Android's own app for setting up a work profile, which an app from the store can ask for. A work profile
     * is a part of the phone of its own, like a Private space: a browser installed only in there is out of
     * the lock's reach unless it is known by name ([knownByName]). While the lock is on, that app is covered
     * whenever it comes to the front, so the setting up cannot be agreed to.
     */
    val setUpOfAWorkProfile: Set<String> = setOf("com.android.managedprovisioning")

    /**
     * Apps that open a screen of Settings at a tap: Settings' search, an app of its own, and the home screen,
     * whose search finds settings too. Nothing on their screens is read; only a tap on something that opens
     * Security & privacy is acted on ([Guard.opensSecurityAndPrivacy]).
     */
    val leadIntoSettings: Set<String> = setOf(
        "com.android.settings.intelligence",
        "com.google.android.settings.intelligence",
        "com.android.launcher3",
        "com.google.android.apps.nexuslauncher",
    )
}
