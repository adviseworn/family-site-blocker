package io.gitlab.adviseworn.familysiteblocker.lock

import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.view.KeyEvent
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import io.gitlab.adviseworn.familysiteblocker.BrowserActivity
import io.gitlab.adviseworn.familysiteblocker.R
import io.gitlab.adviseworn.familysiteblocker.databinding.ActivityLockScreenBinding
import io.gitlab.adviseworn.familysiteblocker.ext.matchBarIconsToTheScreen

/**
 * The screen the lock puts in front of another browser, of a Settings screen about Family Site Blocker or the
 * phone's clock, of Security & privacy, of a screen that opens a way round the lock, or, at bedtime, of any
 * other app.
 * It says what happened and offers Family Site Blocker; Back goes home, since behind it is the thing the lock
 * turned away.
 */
class LockScreenActivity : AppCompatActivity() {
    /** Since when this screen has been the one in front, on the clock that key presses are timed by. */
    private var inFrontSince = Long.MAX_VALUE

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        inFrontSince = if (hasFocus) SystemClock.uptimeMillis() else Long.MAX_VALUE
    }

    /**
     * A Back pressed before this screen was in front was not meant for it. The lock's watch closes the screen
     * it turns away with Back, and Android hands a key to whichever window is in front when it gets round to
     * it: on a slow phone that can be this screen, which would then leave at once.
     */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode == KeyEvent.KEYCODE_BACK && event.downTime < inFrontSince) return true
        return super.dispatchKeyEvent(event)
    }

    /**
     * The same for an Android that does not show this screen the key: from Android 16 on, Back reaches an
     * app as a call that says nothing of when it was pressed. A Back that comes in the first moment this
     * screen is in front ([Guard.backWasForAnotherScreen]) is the one sent to the screen being closed.
     */
    private fun backIsStale(): Boolean = Guard.backWasForAnotherScreen(SystemClock.uptimeMillis() - inFrontSince)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val binding = ActivityLockScreenBinding.inflate(layoutInflater)
        setContentView(binding.root)
        matchBarIconsToTheScreen()
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
            override fun handleOnBackPressed() { if (!backIsStale()) goHome() }
        })
    }

    /** When this screen came onto the phone's screen, on the clock the watch counts by ([upSince]). */
    private var startedAt = 0L

    override fun onStart() {
        super.onStart()
        startedAt = SystemClock.elapsedRealtime()
        upSince = startedAt
    }

    override fun onStop() {
        if (upSince == startedAt) upSince = 0
        super.onStop()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        show(ActivityLockScreenBinding.bind(findViewById(R.id.lockScreenRoot)), intent)
    }

    private fun show(binding: ActivityLockScreenBinding, intent: Intent) {
        val app = intent.getStringExtra(EXTRA_APP) ?: ""
        when (intent.getStringExtra(EXTRA_REASON)) {
            REASON_SETTINGS -> {
                binding.title.text = getString(R.string.lock_screen_settings_title)
                binding.body.text = getString(R.string.lock_screen_settings_body)
            }
            REASON_SECURITY -> {
                binding.title.text = getString(R.string.lock_screen_security_title)
                binding.body.text = getString(R.string.lock_screen_security_body)
            }
            REASON_WAY_ROUND -> {
                binding.title.text = getString(R.string.lock_screen_settings_title)
                binding.body.text = getString(R.string.lock_screen_way_round_body)
            }
            REASON_DISPLAY_OVER -> {
                binding.title.text = getString(R.string.lock_screen_settings_title)
                binding.body.text = getString(R.string.lock_screen_display_over_body)
            }
            REASON_CLOCK -> {
                binding.title.text = getString(R.string.lock_screen_clock_title)
                binding.body.text = getString(R.string.lock_screen_clock_body)
            }
            REASON_BEDTIME -> {
                val until = intent.getStringExtra(EXTRA_UNTIL)
                binding.title.text = getString(R.string.lock_screen_bedtime_title)
                binding.body.text = if (until != null) getString(R.string.lock_screen_bedtime_body, app, until) else getString(R.string.lock_screen_bedtime_body_over, app)
            }
            else -> {
                binding.title.text = getString(R.string.lock_screen_browser_title)
                binding.body.text = getString(R.string.lock_screen_browser_body, app)
            }
        }
    }

    /** Goes to the phone's home screen. A phone that has none to go to keeps this screen: nothing here may stop the app, and with it the lock's watch. */
    private fun goHome() {
        runCatching {
            startActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            finish()
        }
    }

    companion object {
        /**
         * Since when the lock screen has been on a screen, 0 while it is not. The lock's watch reads it: a
         * window of another browser that still shows while this screen is up was not hidden by it
         * ([Guard.againstWhatShows]).
         */
        @Volatile
        var upSince = 0L
            private set

        const val EXTRA_REASON = "reason"
        const val EXTRA_APP = "app"
        const val EXTRA_UNTIL = "until"
        const val REASON_BROWSER = "browser"
        const val REASON_SETTINGS = "settings"
        const val REASON_SECURITY = "security"
        const val REASON_WAY_ROUND = "way-round"
        const val REASON_DISPLAY_OVER = "display-over"
        const val REASON_CLOCK = "clock"
        const val REASON_BEDTIME = "bedtime"
    }
}
