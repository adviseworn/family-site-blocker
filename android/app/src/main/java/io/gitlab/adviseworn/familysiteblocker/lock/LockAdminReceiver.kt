package io.gitlab.adviseworn.familysiteblocker.lock

import android.app.admin.DeviceAdminReceiver
import android.content.Context
import android.content.Intent
import io.gitlab.adviseworn.familysiteblocker.R

/**
 * Family Site Blocker as a device administrator, with no policies: Android then refuses to uninstall the app
 * until the administrator is deactivated, and deactivating happens on a Settings screen the lock watches
 * ([LockAccessibilityService]) while it is on. The record notes it going on and off.
 */
class LockAdminReceiver : DeviceAdminReceiver() {
    override fun onEnabled(context: Context, intent: Intent) {
        LockState(context).record("admin-on", org.json.JSONObject())
    }

    override fun onDisableRequested(context: Context, intent: Intent): CharSequence =
        context.getString(R.string.lock_admin_disable_warning)

    override fun onDisabled(context: Context, intent: Intent) {
        LockState(context).record("admin-off", org.json.JSONObject())
    }
}
