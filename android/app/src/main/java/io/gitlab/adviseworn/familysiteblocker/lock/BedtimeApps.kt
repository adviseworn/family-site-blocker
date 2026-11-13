package io.gitlab.adviseworn.familysiteblocker.lock

import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.AlarmClock
import android.telecom.TelecomManager
import android.view.inputmethod.InputMethodManager

/**
 * Which apps the lock turns away at bedtime: every app with an icon to open it by, but for the few a phone
 * is for at night. Found afresh each time it is asked, as [Browsers] finds the browsers.
 *
 * Left open: this app (its add-on blocks every site then); the home screen; the phone app, for calls; the
 * clock, for the alarm that ends the night; Settings, which the lock guards in its own way; the keyboard;
 * and the phone's safety and emergency apps. Anything without an icon is left alone too: that is the phone
 * itself (the lock screen, the notification shade, the screen of a call under way, permission questions).
 */
object BedtimeApps {
    /** Package names of the apps turned away at bedtime. */
    fun turnedAway(context: Context): Set<String> = withAnIcon(context) - leftOpen(context)

    /** The names of the apps with an icon that stay open at bedtime, this one left out, for the Lock page. */
    fun leftOpenNames(context: Context): List<String> =
        (withAnIcon(context) intersect leftOpen(context)).minus(context.packageName).map { Browsers.label(context, it) }.distinct().sorted()

    private fun withAnIcon(context: Context): Set<String> =
        packagesFor(context.packageManager, Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER))

    private fun leftOpen(context: Context): Set<String> {
        val pm = context.packageManager
        val open = mutableSetOf(context.packageName)
        open += Browsers.guarded
        open += always
        open += packagesFor(pm, Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME))
        // The phone app: the one the person chose for calls, and the one the phone came with.
        (context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager)?.let { telecom ->
            telecom.defaultDialerPackage?.let { open += it }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) telecom.systemDialerPackage?.let { open += it }
        }
        // Dialers and clocks that came with the phone. An app installed later doesn't get to stay open by
        // saying it shows alarms or dials numbers.
        open += packagesFor(pm, Intent(Intent.ACTION_DIAL, Uri.parse("tel:"))).filter { cameWithThePhone(pm, it) }
        open += packagesFor(pm, Intent(AlarmClock.ACTION_SHOW_ALARMS)).filter { cameWithThePhone(pm, it) }
        (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.let { keyboards ->
            runCatching { keyboards.inputMethodList.mapTo(open) { it.packageName } }
        }
        return open
    }

    private fun packagesFor(pm: PackageManager, intent: Intent): Set<String> {
        val activities = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            pm.queryIntentActivities(intent, PackageManager.ResolveInfoFlags.of(0))
        } else {
            @Suppress("DEPRECATION")
            pm.queryIntentActivities(intent, 0)
        }
        return activities.mapNotNullTo(mutableSetOf()) { it.activityInfo?.packageName }
    }

    private fun cameWithThePhone(pm: PackageManager, packageName: String): Boolean = runCatching {
        pm.getApplicationInfo(packageName, 0).flags and (ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0
    }.getOrDefault(false)

    /** Left open by name wherever they are installed: the parts of the phone that make and take calls, and its safety apps. */
    private val always: Set<String> = setOf(
        "android",
        "com.android.systemui",
        "com.android.phone",
        "com.android.server.telecom",
        "com.android.incallui",
        "com.android.emergency",
        "com.google.android.apps.safetyhub",
        "com.samsung.android.incallui",
    )
}
