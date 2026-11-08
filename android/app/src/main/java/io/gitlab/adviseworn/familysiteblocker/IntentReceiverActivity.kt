package io.gitlab.adviseworn.familysiteblocker

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import io.gitlab.adviseworn.familysiteblocker.ext.components
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Links from other apps and shared text land here. The link becomes a tab, and the browser opens on it.
 * Android also looks at this activity's http and https filter when it offers the app as the default browser.
 */
class IntentReceiverActivity : Activity() {
    private val scope = MainScope()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        scope.launch {
            val intent = intent?.let { Intent(it) } ?: Intent()
            intent.flags = intent.flags and Intent.FLAG_ACTIVITY_NEW_TASK.inv()
            intent.flags = intent.flags and Intent.FLAG_ACTIVITY_CLEAR_TASK.inv()
            intent.flags = intent.flags and Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS.inv()

            components.tabIntentProcessor.process(intent)

            intent.setClassName(applicationContext, BrowserActivity::class.java.name)
            finish()
            startActivity(intent)
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        scope.cancel()
    }
}
