package io.gitlab.adviseworn.familysiteblocker

import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.edit

/** Android's default-browser role: whether the app holds it, and how to ask for it. */
object DefaultBrowser {
    private const val PREF_ASKED = "asked_default_browser"

    fun isDefault(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val roleManager = context.getSystemService(RoleManager::class.java)
            return roleManager?.isRoleHeld(RoleManager.ROLE_BROWSER) == true
        }
        val probe = Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com/"))
        val handler = context.packageManager.resolveActivity(probe, PackageManager.MATCH_DEFAULT_ONLY)
        return handler?.activityInfo?.packageName == context.packageName
    }

    /** The system's own request (Android 10 and later), or null when there is none to show. */
    fun requestIntent(context: Context): Intent? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
        val roleManager = context.getSystemService(RoleManager::class.java) ?: return null
        if (!roleManager.isRoleAvailable(RoleManager.ROLE_BROWSER) || roleManager.isRoleHeld(RoleManager.ROLE_BROWSER)) {
            return null
        }
        return roleManager.createRequestRoleIntent(RoleManager.ROLE_BROWSER)
    }

    /** Android's default apps screen, for when the system request is not available. */
    fun openSettings(context: Context) {
        context.startActivity(Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    /** Asks once, on the first start; after that the menu item stays. Returns true when a request was shown. */
    fun askOnce(context: Context, preferences: SharedPreferences, launch: (Intent) -> Unit): Boolean {
        if (isDefault(context) || preferences.getBoolean(PREF_ASKED, false)) return false
        preferences.edit { putBoolean(PREF_ASKED, true) }
        val intent = requestIntent(context) ?: return false
        launch(intent)
        return true
    }
}
