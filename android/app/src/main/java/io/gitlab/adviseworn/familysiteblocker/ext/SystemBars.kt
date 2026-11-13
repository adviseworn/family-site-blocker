package io.gitlab.adviseworn.familysiteblocker.ext

import android.app.Activity
import android.content.res.Configuration
import androidx.core.view.WindowCompat

/**
 * Dark icons in the status bar and the navigation bar over the app's light screens, light ones at night.
 * Android draws the app under both bars and leaves their icons light unless told: on Android 17 the clock and
 * the battery were white on the app's white.
 */
fun Activity.matchBarIconsToTheScreen() {
    val night = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
    WindowCompat.getInsetsController(window, window.decorView).apply {
        isAppearanceLightStatusBars = !night
        isAppearanceLightNavigationBars = !night
    }
}
