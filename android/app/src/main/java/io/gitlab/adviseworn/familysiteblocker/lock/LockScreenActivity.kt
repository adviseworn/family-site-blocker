package io.gitlab.adviseworn.familysiteblocker.lock

import android.content.Intent
import android.os.Bundle
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import io.gitlab.adviseworn.familysiteblocker.BrowserActivity
import io.gitlab.adviseworn.familysiteblocker.R
import io.gitlab.adviseworn.familysiteblocker.databinding.ActivityLockScreenBinding

/**
 * The screen the lock puts in front of another browser, or of a Settings screen about Family Site Blocker.
 * It says what happened and offers Family Site Blocker; Back goes home, since behind it is the thing the lock
 * turned away.
 */
class LockScreenActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val binding = ActivityLockScreenBinding.inflate(layoutInflater)
        setContentView(binding.root)
        show(binding, intent)

        binding.openBrowser.setOnClickListener {
            startActivity(
                Intent(this, BrowserActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            )
            finish()
        }
        binding.goHome.setOnClickListener { goHome() }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = goHome()
        })
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        show(ActivityLockScreenBinding.bind(findViewById(R.id.lockScreenRoot)), intent)
    }

    private fun show(binding: ActivityLockScreenBinding, intent: Intent) {
        val app = intent.getStringExtra(EXTRA_APP) ?: ""
        if (intent.getStringExtra(EXTRA_REASON) == REASON_SETTINGS) {
            binding.title.text = getString(R.string.lock_screen_settings_title)
            binding.body.text = getString(R.string.lock_screen_settings_body)
        } else {
            binding.title.text = getString(R.string.lock_screen_browser_title)
            binding.body.text = getString(R.string.lock_screen_browser_body, app)
        }
    }

    private fun goHome() {
        startActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        finish()
    }

    companion object {
        const val EXTRA_REASON = "reason"
        const val EXTRA_APP = "app"
        const val REASON_BROWSER = "browser"
        const val REASON_SETTINGS = "settings"
    }
}
