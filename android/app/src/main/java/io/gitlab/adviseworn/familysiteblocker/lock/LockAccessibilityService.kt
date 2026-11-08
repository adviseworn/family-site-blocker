package io.gitlab.adviseworn.familysiteblocker.lock

import android.accessibilityservice.AccessibilityService
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.SystemClock
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.core.content.ContextCompat
import io.gitlab.adviseworn.familysiteblocker.R
import org.json.JSONObject

/**
 * The lock's watch. Android tells an accessibility service which window has come to the front; while the
 * lock is on, this one turns two things away:
 *  - another browser (any app that opens web links, [Browsers.packages]): its screen is covered by
 *    [LockScreenActivity], which offers Family Site Blocker instead;
 *  - a Settings screen about Family Site Blocker (its App info with Uninstall, Force stop and Disable, the
 *    device administrator's deactivation, the accessibility switch, the uninstall dialog): the phone goes
 *    home and the same screen says the lock holds it.
 * It reads nothing else: the only text it looks for is the app's own name, and only on Settings screens.
 */
class LockAccessibilityService : AccessibilityService() {
    private lateinit var state: LockState
    @Volatile private var browsers: Set<String> = emptySet()
    private var lastBlockAt = 0L
    private var lastBlockedPackage: String? = null

    private val packagesChanged = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) { rescanBrowsers() }
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        state = LockState(this)
        rescanBrowsers()
        ContextCompat.registerReceiver(
            this,
            packagesChanged,
            IntentFilter().apply {
                addAction(Intent.ACTION_PACKAGE_ADDED)
                addAction(Intent.ACTION_PACKAGE_REMOVED)
                addAction(Intent.ACTION_PACKAGE_CHANGED)
                addDataScheme("package")
            },
            ContextCompat.RECEIVER_EXPORTED, // only the system sends these
        )
        state.record("watch-on", JSONObject())
    }

    /** Re-reads the phone's other browsers off the main thread; the field is volatile, read on the event thread. */
    private fun rescanBrowsers() {
        val app = applicationContext
        Thread { browsers = Browsers.packages(app) }.start()
    }

    override fun onDestroy() {
        runCatching { unregisterReceiver(packagesChanged) }
        if (::state.isInitialized) state.record("watch-off", JSONObject())
        super.onDestroy()
    }

    override fun onInterrupt() = Unit

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
            event.eventType != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
        ) return
        val packageName = event.packageName?.toString() ?: return
        if (packageName == this.packageName) return
        state.relockIfDue()
        if (!state.isOn) return

        if (packageName in browsers) {
            if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) block(packageName, LockScreenActivity.REASON_BROWSER)
            return
        }
        if (packageName in Browsers.guarded) {
            val now = SystemClock.elapsedRealtime()
            if (now - lastLookAt < 400) return // Settings screens change often while scrolling; one look at a time
            lastLookAt = now
            // Cover the Settings screen with the lock screen, the same way a browser is covered. An earlier
            // version also sent the phone home, but that home action and the lock screen's start raced, and
            // home could land last and leave the Settings screen a tap away; covering it is enough.
            if (isAboutThisApp()) block(packageName, LockScreenActivity.REASON_SETTINGS)
        }
    }

    private var lastLookAt = 0L

    /**
     * Whether the Settings screen in front is about Family Site Blocker and offers to undo the lock: it names
     * the app and shows one of the actions (Uninstall, Force stop, Disable, Deactivate, the accessibility
     * switch). The list of accessibility services, which names every app, is left alone.
     */
    private fun isAboutThisApp(): Boolean {
        val root: AccessibilityNodeInfo = rootInActiveWindow ?: return false
        val texts = mutableListOf<String>()
        collectTexts(root, texts, 0)
        val name = getString(R.string.app_name)
        if (texts.none { it.contains(name, ignoreCase = true) }) return false
        val actions = listOf("uninstall", "force stop", "disable", "deactivate", "turn off", "remove", "use $name", "clear data", "clear storage", "app info")
        return texts.any { text -> actions.any { text.contains(it, ignoreCase = true) } }
    }

    private fun collectTexts(node: AccessibilityNodeInfo, into: MutableList<String>, depth: Int) {
        if (depth > 40 || into.size > 600) return
        node.text?.let { if (it.isNotBlank()) into += it.toString() }
        node.contentDescription?.let { if (it.isNotBlank()) into += it.toString() }
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            collectTexts(child, into, depth + 1)
        }
    }

    private fun block(packageName: String, reason: String) {
        val now = SystemClock.elapsedRealtime()
        if (packageName == lastBlockedPackage && now - lastBlockAt < 1500) return
        lastBlockAt = now
        lastBlockedPackage = packageName
        state.record(
            if (reason == LockScreenActivity.REASON_BROWSER) "blocked-browser" else "blocked-settings",
            JSONObject().put("app", Browsers.label(this, packageName)).put("package", packageName),
        )
        startActivity(
            Intent(this, LockScreenActivity::class.java)
                .putExtra(LockScreenActivity.EXTRA_REASON, reason)
                .putExtra(LockScreenActivity.EXTRA_APP, Browsers.label(this, packageName))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
        )
    }
}
