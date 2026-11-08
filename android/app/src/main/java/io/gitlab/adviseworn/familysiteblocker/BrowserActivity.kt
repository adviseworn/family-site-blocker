package io.gitlab.adviseworn.familysiteblocker

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.util.AttributeSet
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import io.gitlab.adviseworn.familysiteblocker.ext.components
import io.gitlab.adviseworn.familysiteblocker.lock.LockFragment
import mozilla.components.concept.engine.EngineView
import mozilla.components.feature.contextmenu.ext.DefaultSelectionActionDelegate
import mozilla.components.support.base.feature.UserInteractionHandler
import mozilla.components.support.ktx.android.view.setupPersistentInsets

/** The one screen of the app. It holds the browser or the tabs list, and hands the back button to them first. */
class BrowserActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        WindowCompat.enableEdgeToEdge(window)
        window.setupPersistentInsets()

        if (savedInstanceState == null) {
            supportFragmentManager.beginTransaction()
                .replace(R.id.container, if (intent?.getBooleanExtra(EXTRA_OPEN_LOCK, false) == true) LockFragment() else BrowserFragment.create())
                .commit()
        }

        components.historyStorage.registerStorageMaintenanceWorker()
        components.notificationsDelegate.bindToActivity(this)
    }

    @Suppress("GestureBackNavigation", "MissingSuperCall", "OVERRIDE_DEPRECATION")
    override fun onBackPressed() {
        supportFragmentManager.fragments.forEach {
            if (it is UserInteractionHandler && it.onBackPressed()) {
                return
            }
        }
        onBackPressedDispatcher.onBackPressed()
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
        /** Opens the Lock page instead of the browser (the unlocking notification). */
        const val EXTRA_OPEN_LOCK = "openLock"
    }
}
