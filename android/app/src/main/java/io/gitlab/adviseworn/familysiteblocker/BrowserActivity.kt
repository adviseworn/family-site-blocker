package io.gitlab.adviseworn.familysiteblocker

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.util.AttributeSet
import android.view.View
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import io.gitlab.adviseworn.familysiteblocker.ext.components
import io.gitlab.adviseworn.familysiteblocker.ext.matchBarIconsToTheScreen
import io.gitlab.adviseworn.familysiteblocker.lock.Guard
import io.gitlab.adviseworn.familysiteblocker.lock.LockFragment
import mozilla.components.concept.engine.EngineView
import mozilla.components.feature.contextmenu.ext.DefaultSelectionActionDelegate
import mozilla.components.support.base.feature.UserInteractionHandler
import mozilla.components.support.ktx.android.view.setupPersistentInsets

/** The one screen of the app. It holds the browser, the tabs list or the Lock page, and hands the back button to them first. */
class BrowserActivity : AppCompatActivity() {
    /**
     * Since when a Lock page that was asked for from outside the app ([EXTRA_OPEN_LOCK]) has been in front, on
     * the clock that key presses are timed by: [Long.MAX_VALUE] while it is not there yet, 0 when none was
     * asked for.
     */
    private var lockPageInFrontSince = 0L

    /**
     * Back goes to the browser, the tabs list or the Lock page first, and leaves the app when none of them
     * takes it. From Android 16 on, an app made for that Android hears of Back only through a callback like
     * this one: the older `onBackPressed` is not called there any more, and Back closed the app from every
     * page.
     *
     * A Back that comes in the first moment of a Lock page asked for from outside is not for that page
     * ([Guard.backWasForAnotherScreen]): the lock's watch closes a Settings screen with Back before it brings
     * the page up, and Android hands a key to whichever window is in front when it gets round to it.
     */
    private val back = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
            if (Guard.backWasForAnotherScreen(SystemClock.uptimeMillis() - lockPageInFrontSince)) return
            if (supportFragmentManager.fragments.any { it is UserInteractionHandler && it.onBackPressed() }) return
            // Nobody took it: Android's own Back, which leaves the app.
            isEnabled = false
            onBackPressedDispatcher.onBackPressed()
            isEnabled = true
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        WindowCompat.enableEdgeToEdge(window)
        matchBarIconsToTheScreen()
        window.setupPersistentInsets()

        if (savedInstanceState == null) {
            val lockPage = intent?.getBooleanExtra(EXTRA_OPEN_LOCK, false) == true
            if (lockPage) lockPageAskedFor()
            supportFragmentManager.beginTransaction()
                .replace(R.id.container, if (lockPage) LockFragment() else BrowserFragment.create())
                .commit()
        }
        onBackPressedDispatcher.addCallback(this, back)

        components.historyStorage.registerStorageMaintenanceWorker()
        components.notificationsDelegate.bindToActivity(this)
    }

    private fun lockPageAskedFor() {
        lockPageInFrontSince = if (hasWindowFocus()) SystemClock.uptimeMillis() else Long.MAX_VALUE
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && lockPageInFrontSince == Long.MAX_VALUE) lockPageInFrontSince = SystemClock.uptimeMillis()
    }

    /** Layouts name [EngineView]; Gecko supplies the real view. */
    override fun onCreateView(parent: View?, name: String, context: Context, attrs: AttributeSet): View? =
        when (name) {
            EngineView::class.java.name -> components.engine.createView(context, attrs).apply {
                selectionActionDelegate = DefaultSelectionActionDelegate(store = components.store, context = context)
            }.asView()
            else -> super.onCreateView(parent, name, context, attrs)
        }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.getBooleanExtra(EXTRA_OPEN_LOCK, false)) {
            lockPageAskedFor()
            supportFragmentManager.beginTransaction()
                .replace(R.id.container, LockFragment())
                .commit()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        components.notificationsDelegate.unBindActivity(this)
    }

    companion object {
        /** Opens the Lock page instead of the browser: the unlocking notification, and the lock's watch where the lock was given something. */
        const val EXTRA_OPEN_LOCK = "openLock"
    }
}
