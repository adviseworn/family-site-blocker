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

    /** The app's name for a package, or the package name when the app is gone. */
    fun label(context: Context, packageName: String): String = runCatching {
        val pm = context.packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(packageName, 0)).toString()
    }.getOrDefault(packageName)

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
}
