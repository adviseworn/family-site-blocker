package io.gitlab.adviseworn.familysiteblocker.lock

import org.junit.Assert.assertEquals
import org.junit.Test

/** Which of the screens in Android's record of app use is the one in front: the one brought forward last. */
class FrontTest {
    private val settings = Front.Screen("com.android.settings", "com.android.settings.Settings", 1_000)
    private val security = Front.Screen("com.google.android.permissioncontroller", "com.android.permissioncontroller.safetycenter.ui.SafetyCenterActivity", 2_000)

    @Test
    fun `the screen brought to the front last is the one in front`() {
        assertEquals(settings, Front.later(null, settings))
        assertEquals(security, Front.later(settings, security))
        assertEquals("the record is read oldest first, but need not be", security, Front.later(security, settings))
        // Two screens in the same millisecond: the record names them in order, and the second came last.
        val dialog = Front.Screen("com.google.android.permissioncontroller", "com.android.permissioncontroller.permission.ui.GrantPermissionsActivity", 2_000)
        assertEquals(dialog, Front.later(security, dialog))
    }
}
