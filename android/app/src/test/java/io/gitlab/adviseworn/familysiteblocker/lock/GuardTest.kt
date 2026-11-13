package io.gitlab.adviseworn.familysiteblocker.lock

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * What the lock's watch turns away, pinned on the words of the screens themselves: each list below is what
 * such a screen shows. The first real phone found the way past it: Remove access under Security & privacy's
 * "Review app with full device access" switched the watch off. Android 14 and later keep that whole screen
 * from the watch, so it is told by Android's record of app use and closed whatever it shows.
 */
class GuardTest {
    private val app = "Family Site Blocker"

    private fun inTheProject(path: String): String =
        generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, path) }.first { it.isFile }.readText()

    private fun string(name: String): String =
        Regex("""<string name="$name">(.*?)</string>""", RegexOption.DOT_MATCHES_ALL)
            .find(inTheProject("android/app/src/main/res/values/strings.xml"))!!.groupValues[1].replace("\\'", "'")

    @Test
    fun `a screen that offers to undo the lock is turned away`() {
        // The app's App info.
        assertTrue(Guard.undoesTheLock(listOf("App info", app, "Open", "Uninstall", "Force stop", "Notifications", "Permissions"), app))
        // Its accessibility switch.
        assertTrue(Guard.undoesTheLock(listOf(app, "Use $app", "$app shortcut", "Settings"), app))
        // Security & privacy's card, as the first real phone showed it.
        assertTrue(Guard.undoesTheLock(listOf("Privacy controls", "Review app with full device access", app, "Remove access"), app))
        // The same card when Android keeps its button from the watch: its title is enough.
        assertTrue(Guard.undoesTheLock(listOf("Review app with full device access", "$app can view and control your screen"), app))
        // The device administrator's screen while it is one, and the uninstall dialog.
        assertTrue(Guard.undoesTheLock(listOf(app, "This admin app is active and allows the app $app to perform the following operations:", "Deactivate this device admin app"), app))
        assertTrue(Guard.undoesTheLock(listOf(app, "Do you want to uninstall this app?", "Cancel", "OK"), app))
        assertTrue(Guard.undoesTheLock(listOf("Turn off $app?", "Cancel", "Turn off"), app))
        // The same question as an older Android words it.
        assertTrue(Guard.undoesTheLock(listOf("Stop $app?", "Tapping OK will stop $app.", "Cancel", "OK"), app))
        // The screen that sets the accessibility shortcut to the app: the shortcut switches the watch off.
        assertTrue(Guard.undoesTheLock(listOf("$app shortcuts", "Volume keys", "Press and hold both volume keys", "Accessibility button"), app))
    }

    @Test
    fun `the question that resets every app's preferences is turned away, though it names no app`() {
        val question = listOf(
            "Reset app preferences?",
            "This will reset all preferences for:\n\nDisabled apps\nDisabled app notifications\nDefault applications for actions\nBackground data restrictions for apps\nAny permission restrictions\nBattery usage settings\n\nYou won't lose any app data.",
            "Cancel", "Reset apps",
        )
        assertTrue(Guard.undoesTheLock(question, app))
        assertTrue("with its button kept from the watch", Guard.undoesTheLock(question.dropLast(1), app))
        // The page that leads to it only lists it.
        assertFalse(Guard.undoesTheLock(listOf("Reset options", "Reset Mobile Network Settings", "Reset Bluetooth & Wi‑Fi", "Reset app preferences", "Erase all data (factory reset)"), app))
    }

    @Test
    fun `a screen that only names the app, or does not name it, is left alone`() {
        // The list of accessibility services names every app.
        assertFalse(Guard.undoesTheLock(listOf("Accessibility", "Downloaded apps", app, "On", "Screen reader", "TalkBack", "Off", "Display size and text", "Accessibility shortcuts"), app))
        // Android asking whether the unlocking may show its notification.
        assertFalse(Guard.undoesTheLock(listOf("Allow $app to send you notifications?", "Allow", "Don’t allow"), app))
        // Another app's App info, and Settings' first page.
        assertFalse(Guard.undoesTheLock(listOf("App info", "Chrome", "Uninstall", "Force stop"), app))
        assertFalse(Guard.undoesTheLock(listOf("Settings", "Network & internet", "Apps", "Security & privacy"), app))
        assertFalse(Guard.undoesTheLock(emptyList(), app))
    }

    @Test
    fun `a list that names the app is not closed for a word in another row`() {
        // Android 17's list of accessibility settings, as the watch read it. An earlier build closed it for the
        // "remove" in "remove animations".
        val accessibility = listOf(
            "Accessibility", "Navigate up", "Accessibility", "Downloaded apps", app, "On / ${string("lock_accessibility_summary")}",
            "Display", "Display size & text", "Font size, display size, bold text, outline text", "Color & motion",
            "Dark theme, color correction, remove animations", "Magnification", "Off / Zoom in to make content larger on your screen",
            "Interaction controls", "Accessibility Menu", "Off / Control volume, brightness, and more with a large menu",
            "Timing controls", "Touch & hold delay, time to take action", "System controls", "Navigation mode, screen rotation",
            "Vibration & haptics", "On / Control vibration levels for calls, notifications, and alarms",
        )
        assertFalse(Guard.undoesTheLock(accessibility, app, own))
        // The words of a control count where a label begins, not in the middle of a sentence.
        assertFalse(Guard.undoesTheLock(listOf(app, "Saves battery when you turn off the screen", "Apps you disable are listed here"), app, own))
        assertTrue(Guard.undoesTheLock(listOf(app, "Remove access"), app, own))
        assertTrue(Guard.undoesTheLock(listOf(app, "  Force stop"), app, own))
        assertTrue(Guard.undoesTheLock(listOf(app, "Disable"), app, own))
        assertTrue("wherever it stands", Guard.undoesTheLock(listOf(app, "Deactivate & uninstall"), app, own))
        // Other screens of Android 17 that name the app, as the watch read them.
        assertFalse(Guard.undoesTheLock(listOf("Android Keyboard (AOSP)", "184 kB", "Calendar", "123 kB", app, "286 MB", "Files", "229 kB", "Navigate up", "All apps", "Search", "More options"), app, own))
        assertFalse(Guard.undoesTheLock(listOf(app, "Navigate up", app, app, "All $app notifications", "You haven't allowed notifications from this app"), app, own))
        assertFalse(Guard.undoesTheLock(listOf("Set $app as your default browser app?", "No permissions needed", "Cancel", "Set as default"), app, own))
    }

    @Test
    fun `Settings' own Security and privacy is told by its title`() {
        // What the window is called, on Android 17.
        assertTrue(Guard.namesSecurityAndPrivacy("Security & privacy"))
        assertTrue(Guard.namesSecurityAndPrivacy("Privacy controls"))
        assertTrue("however it is written", Guard.namesSecurityAndPrivacy(" security and Privacy "))
        assertFalse(Guard.namesSecurityAndPrivacy("More security & privacy"))
        assertFalse(Guard.namesSecurityAndPrivacy("Settings"))
        assertFalse(Guard.namesSecurityAndPrivacy("Privacy dashboard"))
        assertFalse(Guard.namesSecurityAndPrivacy(""))
        assertFalse(Guard.namesSecurityAndPrivacy(null))

        // Its first page, as the watch read it with no alert about the app on it.
        val firstPage = listOf(
            "Security & privacy", "Navigate up", "Security & privacy", "Device may be at risk", "See alerts", "Device unlock",
            "Set a screen lock", "Dismiss", "For added security, set a PIN, pattern, or password for this device.", "Set screen lock",
            "Security", "Device unlock", "Add PIN, pattern, password, or swipe", "Privacy", "Privacy controls",
            "Review app with full device access", "Privacy dashboard", "App & AI assistant activity",
        )
        assertTrue(Guard.isSecurityAndPrivacyScreen("Security & privacy", firstPage))
        assertTrue("a window that gives no title", Guard.isSecurityAndPrivacyScreen(null, firstPage))
        assertTrue("before anything is on it", Guard.isSecurityAndPrivacyScreen("Privacy controls", emptyList()))
        assertFalse("nothing on it names the app, so only its title tells", Guard.undoesTheLock(firstPage, app, own))

        // Settings' first page names it too, in its list, and stays open.
        val settings = listOf("Search Settings", "Network & internet", "Mobile, Wi‑Fi, hotspot", "Apps", "Security & privacy", "App security, device lock, permissions", "Location")
        assertFalse(Guard.isSecurityAndPrivacyScreen("Settings", settings))
        assertFalse(Guard.isSecurityAndPrivacyScreen(null, settings))
        assertFalse("scrolled until that row is the first", Guard.isSecurityAndPrivacyScreen(null, settings.drop(4)))
        assertTrue("the page's own heading", Guard.isSecurityAndPrivacyScreen(null, listOf("Privacy controls", "Navigate up", "Privacy controls")))
        assertFalse(Guard.isSecurityAndPrivacyScreen("More security & privacy", listOf("More security & privacy", "Navigate up", "Security", "Device admin")))
        assertFalse(Guard.isSecurityAndPrivacyScreen(null, emptyList()))

        // The alert itself, as Android 17 shows it once More alerts has been tapped: turned away by what it says,
        // should the page ever be up without its title.
        val alert = listOf(
            "Privacy controls", "Review app with full device access", app, "Dismiss",
            "This app can view your screen and perform actions on your device. Accessibility apps need this type of access to function as intended, but check the app and make sure you trust it.",
            "Remove access", "View apps with full access",
        )
        assertTrue(Guard.undoesTheLock(listOf("Lost device protection", "View details") + alert, app, own))
        assertTrue("with its buttons kept from the watch", Guard.undoesTheLock(alert.take(3), app, own))
    }

    @Test
    fun `a tap on the row that opens Security and privacy puts the shield up`() {
        // The row on Settings' first page, and the one on Security & privacy: title first, then what is under it.
        assertTrue(Guard.opensSecurityAndPrivacy(listOf("Security & privacy", "App security, device lock, permissions")))
        assertTrue(Guard.opensSecurityAndPrivacy(listOf("Privacy controls", "Review app with full device access")))
        assertTrue("a search result", Guard.opensSecurityAndPrivacy(listOf("Privacy controls", "Security & privacy")))
        // The row under More security & privacy that opens the list of apps with full access.
        assertTrue(Guard.opensSecurityAndPrivacy(listOf("Accessibility usage", "1 app has full access to your device")))
        assertFalse("that row's name is no screen's title", Guard.namesSecurityAndPrivacy("Accessibility usage"))
        assertFalse(Guard.opensSecurityAndPrivacy(listOf("Accessibility", "Display, interaction, audio")))
        // No shield at the tap for a result that is only found under it (the page it opens is closed by its
        // title), for another row, or for a tap that says nothing.
        assertFalse(Guard.opensSecurityAndPrivacy(listOf("Device unlock", "Security & privacy")))
        assertFalse(Guard.opensSecurityAndPrivacy(listOf("Location", "On / 0 apps have access to location")))
        assertFalse(Guard.opensSecurityAndPrivacy(listOf("More security & privacy", "Autofill, notifications, and more")))
        assertFalse(Guard.opensSecurityAndPrivacy(emptyList()))
        assertFalse(Guard.opensSecurityAndPrivacy(listOf(null, "Security & privacy")))
    }

    private val own get() = Guard.OwnWords(string("lock_accessibility_description"), string("lock_admin_description"))

    @Test
    fun `the app's own sentences tell its screens, whatever the phone's language and whatever Android hides`() {
        // The accessibility service's screen on a phone that speaks German, its switch kept from the watch.
        assertTrue(Guard.undoesTheLock(listOf(app, "Verknüpfung", own.accessibility, "Einstellungen"), app, own))
        // The device administrator's screen with its buttons kept from the watch.
        assertTrue(Guard.undoesTheLock(listOf(app, own.administrator, "Diese Admin-App ist aktiv"), app, own, administrator = { true }))
        // The same sentence on the screen that makes it an administrator: the way back stays open.
        assertFalse(Guard.undoesTheLock(listOf(app, own.administrator, "Diese Admin-App aktivieren"), app, own, administrator = { false }))
        // The list of accessibility services shows the short summary, not the description.
        assertFalse(Guard.undoesTheLock(listOf("Bedienungshilfen", app, string("lock_accessibility_summary"), "An"), app, own))
    }

    @Test
    fun `the screen that makes the app a device administrator is left alone until it is one`() {
        val activating = listOf(
            app, string("lock_admin_description"),
            "Activating this admin app will allow the app $app to perform the following operations:",
            "Cancel", "Uninstall app", "Activate this device admin app",
        )
        assertFalse("the way to put the lock back stays open", Guard.undoesTheLock(activating, app, administrator = { false }))
        val active = listOf(
            app, string("lock_admin_description"),
            "This admin app is active and allows the app $app to perform the following operations:",
            "Deactivate this device admin app",
        )
        assertTrue(Guard.undoesTheLock(active, app, administrator = { true }))
        // Android may keep the screen's buttons from the watch; the app's own sentence on it is then what tells.
        assertTrue(Guard.undoesTheLock(active.dropLast(1), app, administrator = { true }))
    }

    @Test
    fun `Android 17 keeps the device administrator's row and buttons from the watch`() {
        // The list of device admin apps: its rows are kept from the watch, so nothing on it is turned away.
        assertFalse(Guard.undoesTheLock(listOf("Device admin", "Navigate up", "Device admin"), app, own, administrator = { true }))
        // The administrator's own screen, opened from the row: the app's sentence and Android's tell it.
        val active = listOf(
            "Device admin app", "Navigate up", "Device admin app", app, own.administrator,
            "This admin app is active and allows the app $app to perform the following operations:",
        )
        assertTrue(Guard.undoesTheLock(active, app, own, administrator = { true }))
        assertTrue("without the app's sentence", Guard.undoesTheLock(active - own.administrator, app, own, administrator = { true }))
        // The same screen before it is one, with the sentence shown twice: as its description and as the
        // explanation the Lock page's button sends along.
        val activating = listOf(
            "Device admin app", "Navigate up", "Device admin app", app, own.administrator, own.administrator,
            "Activating this admin app will allow the app $app to perform the following operations:",
        )
        assertFalse(Guard.undoesTheLock(activating, app, own, administrator = { false }))
        // The question Deactivate asks, in the app's own words.
        assertTrue(Guard.undoesTheLock(listOf(string("lock_admin_disable_warning"), "Cancel", "OK"), app, own, administrator = { true }))
    }

    @Test
    fun `while the lock still lacks something, App info stays open for Allow restricted settings`() {
        val appInfo = listOf("App info", app, "Open", "Uninstall", "Force stop", "Notifications", "Permissions", "Storage & cache")
        assertTrue("nothing is missing: closed as ever", Guard.undoesTheLock(appInfo, app, own, mayNeedAllowing = { false }))
        assertFalse(Guard.undoesTheLock(appInfo, app, own, mayNeedAllowing = { true }))
        // Its menu, where Allow restricted settings is, names no app.
        assertFalse(Guard.undoesTheLock(listOf("Allow restricted settings"), app, own, mayNeedAllowing = { true }))
        // Force stop asks first, and its question names no app: turned away for as long as App info is open.
        val question = listOf("Force stop?", "If you force stop an app, it may misbehave.", "Cancel", "OK")
        assertTrue(Guard.undoesTheLock(question, app, own, mayNeedAllowing = { true }))
        assertFalse("another app's, while this app's App info is closed anyway", Guard.undoesTheLock(question, app, own, mayNeedAllowing = { false }))
        // What else App info leads to is turned away as ever: the uninstall dialog, the page that clears the
        // app's storage, and the device administrator's screen that Uninstall opens for an app that is one.
        assertTrue(Guard.undoesTheLock(listOf(app, "Do you want to uninstall this app?", "Cancel", "OK"), app, own, mayNeedAllowing = { true }))
        assertTrue(Guard.undoesTheLock(listOf("Storage", app, "Clear storage", "Clear cache"), app, own, mayNeedAllowing = { true }))
        assertTrue(Guard.undoesTheLock(listOf(app, own.administrator, "Deactivate & uninstall"), app, own, administrator = { true }, mayNeedAllowing = { true }))
        // And so is another screen of the app's that only shares a word with App info.
        assertTrue(Guard.undoesTheLock(listOf("Review app with full device access", app, "Remove access"), app, own, mayNeedAllowing = { true }))
    }

    @Test
    fun `while the accessibility shortcut is set to the app, the screen that takes it off stays open`() {
        val page = listOf(app, "Use $app", "$app shortcut", "Volume keys", "Settings", own.accessibility)
        assertTrue("no shortcut: closed as ever", Guard.undoesTheLock(page, app, own))
        assertFalse(Guard.undoesTheLock(page, app, own, shortcutSet = { true }))
        assertFalse(Guard.undoesTheLock(listOf("$app shortcuts", "Volume keys", "Accessibility button"), app, own, shortcutSet = { true }))
        // The question that switches the watch off is turned away all the same, in either wording.
        assertTrue(Guard.undoesTheLock(listOf("Stop $app?", "Cancel", "Stop"), app, own, shortcutSet = { true }))
        assertTrue(Guard.undoesTheLock(listOf("Turn off $app?", "Cancel", "Turn off"), app, own, shortcutSet = { true }))
        // App info does not open for a shortcut.
        assertTrue(Guard.undoesTheLock(listOf("App info", app, "Uninstall", "Force stop"), app, own, shortcutSet = { true }))
    }

    @Test
    fun `the lock's own screens are not taken for a way to undo it`() {
        val lockScreen = listOf(
            string("lock_screen_settings_title"), string("lock_screen_settings_body"), string("lock_screen_open"),
            string("lock_screen_home"), string("lock_screen_footnote"),
        )
        assertFalse(Guard.undoesTheLock(lockScreen, app))
    }

    @Test
    fun `the last change on a screen is always looked at`() {
        assertEquals("a look when none was made lately", 0, Guard.waitBeforeLook(Guard.LOOK_EVERY))
        assertEquals(0, Guard.waitBeforeLook(10_000))
        assertEquals("a change right after a look waits its turn, it is not dropped", Guard.LOOK_EVERY, Guard.waitBeforeLook(0))
        assertEquals(1, Guard.waitBeforeLook(Guard.LOOK_EVERY - 1))
        assertEquals("a clock that went back does not hold the look up", 0, Guard.waitBeforeLook(-5))
        // A window that has just come to the front is looked at closely while its page fills in.
        assertEquals(Guard.fillInLooks.sorted(), Guard.fillInLooks)
        assertTrue(Guard.fillInLooks.first() <= 50)
        assertTrue(Guard.fillInLooks.last() >= 1000)
    }

    @Test
    fun `a guarded app's screen that stays in front is looked at steadily, a slow phone's less often`() {
        assertEquals(Guard.STEADY_LOOK_EVERY, Guard.steadyLookIn(0))
        assertEquals(Guard.STEADY_LOOK_EVERY, Guard.steadyLookIn(20))
        assertTrue("sooner than a person taps what a page has just shown", Guard.STEADY_LOOK_EVERY <= 300)
        assertEquals("a look of 0.6 seconds is followed by 1.2 without one", 1200L, Guard.steadyLookIn(600))
        assertEquals("a look that an app kept waiting for 7 seconds does not leave its screen unread for 14", Guard.STEADY_LOOK_AT_LATEST, Guard.steadyLookIn(7000))
    }

    @Test
    fun `the app's row in the list of all apps does not make another app's App info its own`() {
        // Settings shows the list and an app's App info in one window. While one changes into the other the
        // watch is shown both: seen on the Android 15 test phone, going back from an app's App info.
        val list = listOf("All apps", "Calendar", "65.54 kB\nDisabled", "Camera", "111 kB", app, "288 MB", "Files", "172 kB", "Navigate up", "All apps", "Search", "More options")
        val cameras = listOf("Camera", "Archive", "Disable", "Force stop", "Notifications", "Off", "Navigate up", "Open", "App info")
        val itsOwn = listOf(app, "Archive", "Uninstall", "Force stop", "Notifications", "Off", "Navigate up", "Open", "App info")
        assertFalse(Guard.undoesTheLock(list, app))
        assertFalse(Guard.undoesTheLock(cameras, app))
        assertFalse("the list, and the Camera's App info coming", Guard.undoesTheLock(list + cameras, app))
        assertFalse("the Camera's App info, and the list coming back", Guard.undoesTheLock(cameras + list, app))
        // The list as it comes back, before it has the room each app takes: as the test phone showed it.
        val early = listOf(
            "All apps", "Digital Wellbeing", "Disabled", "Drive", "Disabled", app, "Files", "Float Browser", "Gboard", "Gmail", "Disabled",
            "Navigate up", "All apps", "Search", "More options",
        )
        val files = listOf("Files", "Archive", "Disable", "Force stop", "Notifications", "About 0 notifications per week", "Navigate up", "Open", "App info")
        assertFalse("\"Disabled\" under another app is no Disable button", Guard.undoesTheLock(early, app))
        assertFalse(Guard.undoesTheLock(early + files, app))
        assertFalse(Guard.undoesTheLock(files + early, app))
        // The app's own App info is closed as ever, alone and while it comes or goes.
        assertTrue(Guard.undoesTheLock(itsOwn, app))
        assertTrue(Guard.undoesTheLock(list + itsOwn, app))
        assertTrue(Guard.undoesTheLock(itsOwn + list, app))
        assertTrue(Guard.undoesTheLock(early + itsOwn, app))
        assertTrue(Guard.undoesTheLock(itsOwn + early, app))
        // Only the room an app takes makes its name a row of a list. What a page says of storage does not,
        // nor what another list says under a name.
        assertTrue(Guard.undoesTheLock(listOf(app, "288 MB used in internal storage", "Uninstall"), app))
        assertTrue(Guard.undoesTheLock(listOf("Storage", app, "Clear storage", "Clear cache", "App size", "288 MB"), app))
        assertTrue(Guard.undoesTheLock(listOf("Usage access", app, "Allowed", "Phone", "Not allowed"), app))
        assertTrue(Guard.undoesTheLock(listOf(app, "Do you want to uninstall this app?", "Cancel", "OK"), app))
        // A button's whole word counts, not a word that only begins like it.
        assertTrue(Guard.undoesTheLock(listOf(app, "Disable"), app))
        assertTrue(Guard.undoesTheLock(listOf(app, "Disable app?"), app))
        assertFalse(Guard.undoesTheLock(listOf(app, "Disabled"), app))
    }

    @Test
    fun `the app's name in a row that can be tapped is not the heading of its own page`() {
        // What can be tapped, as the Android 17 test phone has it: every row of the list, every button and
        // row of App info, and the arrow back. The heading of App info, which is the app's name, cannot be
        // tapped, nor can a page's title.
        fun rows(texts: List<String>, vararg headings: String) = texts.indices.filter { texts[it] !in headings }.toSet()
        // The list as the watch was shown it there with animations on: seven rows, their sizes not there yet,
        // the list's own top gone already, and the Contacts' App info.
        val rowsOnly = listOf("Android Keyboard (AOSP)", "Calendar", "Camera", "Clock", "Contacts", app, "Files")
        val contacts = listOf("Contacts", "Archive", "Disable", "Force stop", "Notifications", "Off", "Navigate up", "App info", "Open")
        val both = rowsOnly + contacts
        assertTrue("by its words alone this is taken for the app's own App info", Guard.undoesTheLock(both, app))
        assertFalse(Guard.undoesTheLock(both, app, rows = rows(both, "Contacts", "App info")))
        assertFalse(Guard.undoesTheLock(contacts + rowsOnly, app, rows = rows(contacts + rowsOnly, "Contacts", "App info")))
        // The app's own App info: its name is the heading. Alone, and with the list still there.
        val itsOwn = listOf(app, "Archive", "Uninstall", "Force stop", "Notifications", "Off", "Navigate up", "App info", "Open")
        assertTrue(Guard.undoesTheLock(itsOwn, app, rows = rows(itsOwn, app, "App info")))
        val listThenItsOwn = rowsOnly.indices.toSet() + rows(itsOwn, app, "App info").map { it + rowsOnly.size }
        assertTrue(Guard.undoesTheLock(rowsOnly + itsOwn, app, rows = listThenItsOwn))
        // The question before the app is uninstalled, and the page that clears its storage.
        assertTrue(Guard.undoesTheLock(listOf(app, "Do you want to uninstall this app?", "Cancel", "OK"), app, rows = setOf(2, 3)))
        assertTrue(Guard.undoesTheLock(listOf("Storage", app, "Clear storage", "Clear cache", "App size", "288 MB"), app, rows = setOf(2, 3)))
        // A row is drawn by Compose and says it is a plain view. The heading of the storage page can be
        // tapped as well, it leads to App info, and says it is a LinearLayout: that is no row.
        assertTrue(Guard.isRow(true, "android.view.View"))
        assertFalse(Guard.isRow(true, "android.widget.LinearLayout"))
        assertFalse(Guard.isRow(true, "android.widget.Button"))
        assertFalse(Guard.isRow(true, null))
        assertFalse(Guard.isRow(false, "android.view.View"))
        // The list of the apps with usage access is closed as ever: the app's row there is one tap from the switch.
        val usage = listOf(app, "Allowed", "Navigate up", "App usage data", "Search", "More options")
        assertTrue(Guard.undoesTheLock(usage, app, rows = setOf(0, 1, 2, 4, 5)))
        assertFalse("not while the app has no usage access yet", Guard.undoesTheLock(usage, app, rows = setOf(0, 1, 2, 4, 5), usageAccess = { false }))
        // Rows that name the app and say Uninstall are no page of the app's.
        val found = listOf(app, "App info", "Uninstall unused apps", "Navigate up")
        assertTrue(Guard.undoesTheLock(found, app))
        assertFalse(Guard.undoesTheLock(found, app, rows = setOf(0, 1, 2, 3)))
    }

    @Test
    fun `the page that clears the app's storage is told by what it lists, its buttons kept from the watch`() {
        // Settings, Storage, Apps, then the app's row, on the Android 17 test phone: the page comes without
        // passing App info, and the watch is shown neither Clear storage nor Clear cache.
        val page = listOf("Storage", "Navigate up", "Storage", app, "1.30.0", "Space used", "App size", "274 MB", "User data", "14.84 MB", "Cache", "205 kB", "Total", "289 MB")
        assertTrue(Guard.undoesTheLock(page, app))
        // Its heading can be tapped. Should a phone's Settings draw it as a row, the page is closed all the same.
        assertTrue(Guard.undoesTheLock(page, app, rows = setOf(1, 3, 4)))
        assertTrue("whatever the lock still lacks", Guard.undoesTheLock(page, app, mayNeedAllowing = { true }, usageAccess = { false }))
        // Another app's storage page, and the list that leads to them, each app named twice there.
        assertFalse(Guard.undoesTheLock(listOf("Storage", "Navigate up", "Storage", "Phone", "17", "Space used", "App size", "139 kB", "User data", "0 B", "Cache", "0 B", "Total", "139 kB"), app))
        val list = listOf("Apps storage", "Navigate up", "Apps storage", "Search", "More options", app, app, "289 MB", "WebView Shell", "WebView Shell", "4.64 MB", "Float Browser", "Float Browser", "0.92 MB")
        assertFalse(Guard.undoesTheLock(list, app))
        // The same list sorted by size under the title "All apps", and the older App info its rows lead to,
        // which Android 17 shows the watch without Open, Disable and Force stop.
        assertFalse(Guard.undoesTheLock(listOf("All apps", "Navigate up", "All apps", "Search", "More options", app, app, "289 MB", "Phone", "Phone", "139 kB"), app))
        assertTrue(Guard.undoesTheLock(listOf("App info", "Navigate up", "App info", app, "Notifications", "About 1 notification per week", "Permissions", "Storage & cache", "289 MB used in internal storage"), app))
        assertFalse(Guard.undoesTheLock(listOf("App info", "Navigate up", "App info", "Phone", "Notifications", "About 0 notifications per week", "Permissions", "Storage & cache", "274 kB used in internal storage"), app))
        // App info's own line on storage is no storage page.
        assertFalse(Guard.undoesTheLock(listOf("Phone", "Storage & cache", "274 kB used in internal storage", "App size"), app))
    }

    @Test
    fun `a window that has come to the front is looked at while it fills in, and once more at the end`() {
        assertEquals("the first look took 4 milliseconds: the next is at 30", 26L, Guard.nextFillInLook(4, 0))
        assertEquals(1L, Guard.nextFillInLook(119, 70))
        assertEquals("a look that ends on a time waits for the one after it", 60L, Guard.nextFillInLook(120, 120))
        assertEquals("a slow look skips the times that have passed", 250L, Guard.nextFillInLook(550, 30))
        assertEquals("and the last look is always made", 0L, Guard.nextFillInLook(2500, 0))
        assertNull("looked at after the last time: left to its changes", Guard.nextFillInLook(5000, 2500))
        assertNull(Guard.nextFillInLook(1805, 1800))
    }

    @Test
    fun `a Back that reaches the lock screen in its first moment was sent to the screen under it`() {
        assertTrue(Guard.backWasForAnotherScreen(0))
        assertTrue(Guard.backWasForAnotherScreen(Guard.BACK_NOT_FOR_THE_LOCK_SCREEN - 1))
        assertFalse("a person's own Back", Guard.backWasForAnotherScreen(Guard.BACK_NOT_FOR_THE_LOCK_SCREEN))
        assertFalse(Guard.backWasForAnotherScreen(60_000))
        // Not in front: its time in front is counted from the end of time, so it comes out before 0.
        assertTrue(Guard.backWasForAnotherScreen(1_000 - Long.MAX_VALUE))
    }

    @Test
    fun `a screen gets one Back each time it is brought to the front`() {
        assertTrue("the first Back", Guard.sendsBack(Long.MAX_VALUE / 2, 1000, null))
        assertFalse("the lock screen is on its way behind the last Back", Guard.sendsBack(300, 2000, 1000))
        assertFalse("the same screen, slow to close", Guard.sendsBack(5000, 1000, 1000))
        assertTrue("brought to the front again", Guard.sendsBack(5000, 2000, 1000))
        // Where the record of app use says nothing, by time alone.
        assertTrue(Guard.sendsBack(Guard.BACK_ONCE_IN + 1, null, null))
        assertFalse(Guard.sendsBack(Guard.BACK_ONCE_IN, null, null))
        assertTrue(Guard.sendsBack(Guard.BACK_ONCE_IN + 1, null, 1000))
        assertTrue("a clock that went back does not hold Back up", Guard.sendsBack(-5, null, null))
    }

    @Test
    fun `Back waits for the window of a screen the record names`() {
        // The page the screen was opened from still has the focus.
        assertTrue(Guard.waitsForItsWindow(onTheWindowBefore = true, onAWindow = true, sinceNamed = 0, sinceItLeft = 0))
        assertTrue(Guard.waitsForItsWindow(true, true, Guard.WINDOW_COMES_WITHIN - 1, 0))
        assertFalse("it does not wait for ever", Guard.waitsForItsWindow(true, true, Guard.WINDOW_COMES_WITHIN, 0))
        // Another window has it, the screen's own: a moment more, then Back.
        assertTrue(Guard.waitsForItsWindow(false, true, 300, 0))
        assertTrue(Guard.waitsForItsWindow(false, true, 300, Guard.WINDOW_SETTLES_IN - 1))
        assertFalse(Guard.waitsForItsWindow(false, true, 300, Guard.WINDOW_SETTLES_IN))
        // No window has it: Android may still be giving keys to the page before, so longer.
        assertTrue(Guard.waitsForItsWindow(false, false, 300, Guard.WINDOW_SETTLES_IN))
        assertTrue(Guard.waitsForItsWindow(false, false, 700, Guard.NO_WINDOW_FOR - 1))
        assertFalse(Guard.waitsForItsWindow(false, false, 700, Guard.NO_WINDOW_FOR))
        assertFalse("nor for ever", Guard.waitsForItsWindow(false, false, Guard.WINDOW_COMES_WITHIN, 10))
        assertFalse("a clock that went back does not hold Back up", Guard.waitsForItsWindow(true, true, -5, 0))
        assertFalse(Guard.waitsForItsWindow(false, false, 300, -5))
    }

    @Test
    fun `the lock screen follows Back once the screen has closed`() {
        assertFalse("still the screen Back went to", Guard.coverFollows(50, 1000, 1000))
        assertTrue("another screen has been brought to the front", Guard.coverFollows(50, 1000, 2000))
        assertFalse(Guard.coverFollows(Guard.COVER_AT_LATEST - 1, 1000, 1000))
        assertTrue("it does not wait for ever", Guard.coverFollows(Guard.COVER_AT_LATEST, 1000, 1000))
        // Where the record of app use says nothing, a fixed moment after Back.
        assertFalse(Guard.coverFollows(Guard.COVER_AFTER - 1, null, null))
        assertTrue(Guard.coverFollows(Guard.COVER_AFTER, null, null))
        assertTrue(Guard.coverFollows(Guard.COVER_AFTER, 1000, null))
        assertTrue("a clock that went back does not hold it up", Guard.coverFollows(-5, 1000, 1000))
        // A screen Android keeps from the watch may not be up yet when Back is sent, and Android holds Back
        // for the window that comes next: the lock screen waits longer, so that it is not that window.
        assertFalse(Guard.coverFollows(Guard.COVER_AT_LATEST, 1000, 1000, seen = false))
        assertTrue("it has closed", Guard.coverFollows(50, 1000, 2000, seen = false))
        assertFalse(Guard.coverFollows(Guard.COVER_AT_LATEST_UNSEEN - 1, 1000, 1000, seen = false))
        assertTrue("it does not wait for ever", Guard.coverFollows(Guard.COVER_AT_LATEST_UNSEEN, 1000, 1000, seen = false))
        assertTrue("where the record says nothing, as ever", Guard.coverFollows(Guard.COVER_AFTER, null, null, seen = false))
    }

    @Test
    fun `Security and privacy is told by its class, whichever of its pages it is`() {
        assertTrue(Guard.isSecurityAndPrivacy("com.android.permissioncontroller.safetycenter.ui.SafetyCenterActivity"))
        assertTrue(Guard.isSecurityAndPrivacy("com.android.permissioncontroller.safetycenter.ui.SafetyCenterQsActivity"))
        // The list of apps with full access, which the alert's other button opens.
        assertTrue(Guard.isSecurityAndPrivacy("com.android.permissioncontroller.permission.ui.ReviewAccessibilityServicesActivity"))
        assertFalse(Guard.isSecurityAndPrivacy("com.android.permissioncontroller.permission.ui.GrantPermissionsActivity"))
        assertFalse(Guard.isSecurityAndPrivacy("com.android.settings.SubSettings"))
        assertFalse(Guard.isSecurityAndPrivacy(null))
    }

    private val ownPackage = "io.gitlab.adviseworn.familysiteblocker"
    private val browsers = setOf("com.android.chrome")
    private val controller = "com.google.android.permissioncontroller"
    private fun byTheRecord(packageName: String?, className: String?) = Guard.byTheRecord(packageName, className, ownPackage, browsers, Browsers.guarded)

    @Test
    fun `the record of app use tells Security and privacy, and a window Android keeps from the watch`() {
        // Security & privacy, as the first real phone's Android names it: closed, whichever of its pages it is.
        assertEquals(Guard.ByTheRecord.CLOSE, byTheRecord(controller, "com.android.permissioncontroller.safetycenter.ui.SafetyCenterActivity"))
        assertEquals(Guard.ByTheRecord.CLOSE, byTheRecord("com.android.permissioncontroller", "com.android.permissioncontroller.safetycenter.ui.SafetyCenterQsActivity"))
        assertEquals(Guard.ByTheRecord.CLOSE, byTheRecord(controller, "com.android.permissioncontroller.permission.ui.ReviewAccessibilityServicesActivity"))
        // Android asking for a permission is kept from the watch too, and is nothing to close.
        assertEquals(Guard.ByTheRecord.LEAVE, byTheRecord(controller, "com.android.permissioncontroller.permission.ui.GrantPermissionsActivity"))
        // Another app that happens to call a screen of its own a safety centre.
        assertEquals(Guard.ByTheRecord.LEAVE, byTheRecord("com.example.bank", "com.example.bank.safetycenter.Main"))
        assertEquals(Guard.ByTheRecord.COVER_IF_HIDDEN, byTheRecord("com.android.chrome", "org.chromium.chrome.browser.ChromeTabbedActivity"))
        // The app's own screens, and a record that says nothing (no usage access).
        assertEquals(Guard.ByTheRecord.LEAVE, byTheRecord(ownPackage, "$ownPackage.lock.LockScreenActivity"))
        assertEquals(Guard.ByTheRecord.LEAVE, byTheRecord(null, null))
    }

    @Test
    fun `the app's usage access is held once it has been given, and can be given while it has not`() {
        val page = listOf("Usage access", app, "Usage access allows an app to track what other apps you're using and how often.")
        assertTrue(Guard.undoesTheLock(page, app, own = null, usageAccess = { true }))
        assertFalse("the way to give it stays open", Guard.undoesTheLock(page, app, own = null, usageAccess = { false }))
        // The list of special access names no app.
        assertFalse(Guard.undoesTheLock(listOf("Special app access", "Usage access", "Device admin apps"), app, own = null, usageAccess = { true }))
        // A screen that undoes the lock another way is turned away whether or not usage access was given.
        assertTrue(Guard.undoesTheLock(listOf("App info", app, "Force stop"), app, own = null, usageAccess = { false }))
    }

    @Test
    fun `Android 16 and later call usage access App usage data`() {
        // The app's page as Android 17 shows it to the watch: the switch's own label is not among it.
        val page = listOf(
            "App usage data", "Navigate up", "App usage data", app, "1.30.0",
            "App usage data allows an app to track what other apps you’re using and how often, as well as your carrier, language settings, and other details.",
        )
        assertTrue(Guard.undoesTheLock(page, app, own, usageAccess = { true }))
        assertFalse("the way to give it stays open", Guard.undoesTheLock(page, app, own, usageAccess = { false }))
        assertTrue("its title is enough", Guard.undoesTheLock(page.dropLast(1), app, own, usageAccess = { true }))
        assertTrue(Guard.undoesTheLock(page + "Permit access to app usage data", app, own, usageAccess = { true }))
        // The list of the apps that have it leads nowhere else, and is closed with it.
        val list = listOf(app, "Allowed", "Navigate up", "App usage data", "Search", "More options")
        assertTrue(Guard.undoesTheLock(list, app, own, usageAccess = { true }))
        assertFalse(Guard.undoesTheLock(list, app, own, usageAccess = { false }))
        // Special app access lists the permission and names no app; another kind of usage is not it.
        assertFalse(Guard.undoesTheLock(listOf("Special app access", "All files access", "App usage data", "Device admin"), app, own, usageAccess = { true }))
        assertFalse(Guard.undoesTheLock(listOf(app, "Mobile data usage", "77.25 kB used since Nov 12", "App battery usage"), app, own, usageAccess = { true }))
    }

    @Test
    fun `a change to the windows is looked at when it can bring another window to the front`() {
        assertTrue("an Android before 9 names no change", Guard.bringsAWindowForward(0))
        assertTrue("added", Guard.bringsAWindowForward(0x1))
        assertTrue("taken away, which shows the one under it", Guard.bringsAWindowForward(0x2))
        assertTrue("title", Guard.bringsAWindowForward(0x4))
        assertTrue("made the active one", Guard.bringsAWindowForward(0x20))
        assertTrue("given the focus", Guard.bringsAWindowForward(0x40))
        assertTrue(Guard.bringsAWindowForward(0x8 or 0x40))
        assertFalse("only moved or resized", Guard.bringsAWindowForward(0x8))
        assertFalse("only its layer", Guard.bringsAWindowForward(0x10))
        assertFalse("only the accessibility focus", Guard.bringsAWindowForward(0x80))
    }

    @Test
    fun `the accessibility shortcut set to the app's service is found`() {
        val service = "$ownPackage/$ownPackage.lock.LockAccessibilityService"
        assertTrue(Guard.shortcutSetTo(ownPackage, listOf(service, null)))
        assertTrue(Guard.shortcutSetTo(ownPackage, listOf(null, "com.google.android.marvin.talkback/.TalkBackService:$service")))
        assertTrue(Guard.shortcutSetTo(ownPackage, listOf("$ownPackage/.lock.LockAccessibilityService")))
        assertFalse(Guard.shortcutSetTo(ownPackage, listOf("com.google.android.marvin.talkback/.TalkBackService", "")))
        assertFalse(Guard.shortcutSetTo(ownPackage, listOf(null, null)))
        assertFalse("another app whose name begins the same", Guard.shortcutSetTo(ownPackage, listOf("${ownPackage}two/.Service")))
    }

    @Test
    fun `Developer options, Users and the setting up of a Private space are closed, each a way round the lock`() {
        // By the class each has when it is opened from outside Settings, as an Android 17 emulator named them.
        assertEquals(Guard.WayRound.DEVELOPER_OPTIONS, Guard.wayRound("com.android.settings.Settings\$DevelopmentSettingsActivity", null, emptyList()))
        assertEquals(Guard.WayRound.DEVELOPER_OPTIONS, Guard.wayRound("com.android.settings.Settings\$DevelopmentSettingsDashboardActivity", null, emptyList()))
        assertEquals(Guard.WayRound.USERS, Guard.wayRound("com.android.settings.Settings\$UserSettingsActivity", "Users", emptyList()))
        // The setting up of a Private space shows the watch nothing but its class.
        assertEquals(Guard.WayRound.PRIVATE_SPACE, Guard.wayRound("com.android.settings.privatespace.PrivateSpaceSetupActivity", "Settings", emptyList()))
        // By the heading, where Settings draws the page under a class that tells nothing.
        val sub = "com.android.settings.SubSettings"
        assertEquals(
            Guard.WayRound.DEVELOPER_OPTIONS,
            Guard.wayRound(sub, null, listOf("Developer options", "Navigate up", "Developer options", "Search settings", "Use developer options", "Memory")),
        )
        assertEquals(Guard.WayRound.USERS, Guard.wayRound(sub, null, listOf("Users", "Navigate up", "Users", "Allow user switch", "Users", "You (Owner)", "Add user", "Add guest")))
        assertEquals(Guard.WayRound.USERS, Guard.wayRound(sub, null, listOf("Multiple users", "Navigate up", "Multiple users", "Allow multiple users")))
        // By the window's title, which is there before the page is.
        assertEquals(Guard.WayRound.DEVELOPER_OPTIONS, Guard.wayRound(null, "Developer options", emptyList()))
        assertEquals(Guard.WayRound.DEVELOPER_OPTIONS, Guard.wayRound(null, "Wireless debugging", emptyList()))
    }

    @Test
    fun `a page that only lists such a screen, or leads on from it, is left alone`() {
        val sub = "com.android.settings.SubSettings"
        // Settings' System page lists two of them.
        assertNull(Guard.wayRound(sub, "System", listOf("System", "Navigate up", "System", "Languages", "Users", "Signed in as Owner", "Developer options", "Reset options")))
        // The same page scrolled until the row is at the top: its heading is still System.
        assertNull(Guard.wayRound(sub, null, listOf("System", "Navigate up", "Users", "Signed in as Owner", "Developer options")))
        // A row named once at the top, with nothing to say it is the heading.
        assertNull(Guard.wayRound(sub, null, listOf("Users", "Signed in as Owner", "Developer options", "Reset options")))
        // Running services, which Developer options leads to, has no way to stop the watch on it.
        assertNull(Guard.wayRound(sub, "Running services", listOf("Running services", "Navigate up", "Running services", "Device memory")))
        // The screen that asks for the phone's PIN before a Private space: closed, it stayed on top of Settings
        // with the PIN's answer still to come, and Settings then opened to the lock screen once more. And the
        // page of a Private space that is there already, which is where it is deleted.
        assertNull(Guard.wayRound("com.android.settings.privatespace.PrivateSpaceAuthenticationActivity", "Settings", emptyList()))
        assertNull(Guard.wayRound("com.android.settings.password.ConfirmDeviceCredentialActivity", "Settings", emptyList()))
        assertNull(Guard.wayRound(sub, "Private space", listOf("Private space", "Navigate up", "Private space", "Lock", "Private space lock", "Delete private space")))
        // The first page of Settings, and a screen of another kind.
        assertNull(Guard.wayRound("com.android.settings.Settings", "Settings", listOf("Search Settings", "Network & internet", "Apps", "System")))
        assertNull(Guard.wayRound("com.android.settings.Settings\$UserDictionarySettingsActivity", "Personal dictionary", emptyList()))
        assertNull(Guard.wayRound(null, null, emptyList()))
    }

    @Test
    fun `the screen that switches a way round the lock off again stays open while that way is open`() {
        val developerOptions = "com.android.settings.Settings\$DevelopmentSettingsActivity"
        val users = listOf("Users", "Navigate up", "Users", "Allow user switch")
        // USB debugging is on: Developer options is where it is switched off.
        assertNull(Guard.wayRound(developerOptions, "Developer options", emptyList(), debugging = { true }))
        assertEquals(Guard.WayRound.DEVELOPER_OPTIONS, Guard.wayRound(developerOptions, "Developer options", emptyList(), debugging = { false }))
        // The phone lets its user be switched: Users is where that is switched off.
        assertNull(Guard.wayRound(null, null, users, userSwitching = { true }))
        assertEquals(Guard.WayRound.USERS, Guard.wayRound(null, null, users, userSwitching = { false }))
        // Neither opens the other, and nothing opens the setting up of a Private space.
        assertEquals(Guard.WayRound.USERS, Guard.wayRound(null, null, users, debugging = { true }))
        assertEquals(Guard.WayRound.DEVELOPER_OPTIONS, Guard.wayRound(developerOptions, null, emptyList(), userSwitching = { true }))
        assertEquals(
            Guard.WayRound.PRIVATE_SPACE,
            Guard.wayRound("com.android.settings.privatespace.PrivateSpaceSetupActivity", null, emptyList(), debugging = { true }, userSwitching = { true }),
        )
    }

    @Test
    fun `the page whose switch lets another browser display over other apps is told, and whose it is`() {
        val browsers = setOf("Chrome", "Float Browser")
        // As Settings shows it to the watch on Android 17: the page's own things first, its bar last.
        val page = listOf(
            "Float Browser", "1", "Allow display over other apps",
            "Allow this app to display on top of other apps you’re using. This app will be able to see where you tap or change what’s displayed on the screen.",
            "Navigate up", "Display over other apps",
        )
        assertEquals("Float Browser", Guard.letsDisplayOver(page, browsers))
        // An older Settings puts the bar first and words the switch its own way.
        assertEquals("Chrome", Guard.letsDisplayOver(listOf("Display over other apps", "Navigate up", "Chrome", "Version 142.0", "Allow display over other apps"), browsers))
        assertEquals("Chrome", Guard.letsDisplayOver(listOf("Draw over other apps", "Chrome ", "Permit drawing over other apps"), browsers))
        // The same page for an app that is no browser is left alone.
        assertNull(Guard.letsDisplayOver(page, setOf("Chrome")))
        assertNull(Guard.letsDisplayOver(listOf("Phone", "17", "Allow display over other apps", "Navigate up", "Display over other apps"), browsers))
        assertNull(Guard.letsDisplayOver(page, emptySet()))
    }

    @Test
    fun `the list of the apps that may display over other apps, and App info, are left alone`() {
        val browsers = setOf("Chrome", "Float Browser")
        // The list names the browser and says whether it may: it has no switch.
        assertNull(Guard.letsDisplayOver(listOf("Float Browser", "Not allowed", "Phone", "Allowed", "Navigate up", "Display over other apps", "Search", "More options"), browsers))
        // The browser's App info names the row that opens the page.
        assertNull(
            Guard.letsDisplayOver(
                listOf("Float Browser", "Archive", "Uninstall", "Force stop", "Notifications", "Off", "Advanced", "Display over other apps", "Not allowed", "Navigate up", "App info", "Open"),
                browsers,
            ),
        )
        // A page that is still filling in, and one that says nothing.
        assertNull(Guard.letsDisplayOver(listOf("Navigate up", "Display over other apps"), browsers))
        assertNull(Guard.letsDisplayOver(emptyList(), browsers))
        // The explanation under the switch names no switch by itself.
        assertNull(Guard.letsDisplayOver(listOf("Float Browser", "Allow this app to display on top of other apps you’re using."), browsers))
        // While the list changes into the page of an app that is no browser, the watch is shown both: the
        // switch is the Phone app's, whatever browser the list names.
        val list = listOf("Float Browser", "Not allowed", "Phone", "Allowed", "Navigate up", "Display over other apps", "Search", "More options")
        val phones = listOf("Phone", "127.0.620688474", "Allow display over other apps", "Allow this app to display on top of other apps you’re using.", "Navigate up", "Display over other apps")
        val floats = listOf("Float Browser", "1", "Allow display over other apps", "Navigate up", "Display over other apps")
        assertNull(Guard.letsDisplayOver(list + phones, browsers))
        assertNull(Guard.letsDisplayOver(phones + list, browsers))
        assertEquals("the browser's own page, coming and going", "Float Browser", Guard.letsDisplayOver(list + floats, browsers))
        assertEquals("Float Browser", Guard.letsDisplayOver(floats + list, browsers))
    }

    @Test
    fun `the record of app use closes a way round the lock that has a class of its own`() {
        val settings = "com.android.settings"
        val closes: (String) -> Boolean = { Guard.wayRound(it, null, emptyList()) != null }
        fun byTheRecord(packageName: String?, className: String?, wayRound: (String) -> Boolean = closes) =
            Guard.byTheRecord(packageName, className, ownPackage, browsers, Browsers.guarded, wayRound)
        assertEquals(Guard.ByTheRecord.CLOSE, byTheRecord(settings, "com.android.settings.privatespace.PrivateSpaceSetupActivity"))
        assertEquals(Guard.ByTheRecord.CLOSE, byTheRecord(settings, "com.android.settings.Settings\$UserSettingsActivity"))
        assertEquals(Guard.ByTheRecord.CLOSE, byTheRecord(settings, "com.android.settings.Settings\$DevelopmentSettingsActivity"))
        // What leads up to the setting up of a Private space, and any other page of Settings.
        assertEquals(Guard.ByTheRecord.LEAVE, byTheRecord(settings, "com.android.settings.privatespace.PrivateSpaceAuthenticationActivity"))
        assertEquals(Guard.ByTheRecord.LEAVE, byTheRecord(settings, "com.android.settings.SubSettings"))
        assertEquals(Guard.ByTheRecord.LEAVE, byTheRecord(settings, null))
        // A way that is open already: its screen is where it is closed.
        assertEquals(Guard.ByTheRecord.LEAVE, byTheRecord(settings, "com.android.settings.Settings\$UserSettingsActivity") { false })
        // Only a guarded app's screen is asked about, and Security & privacy is closed whatever the answer.
        assertEquals(Guard.ByTheRecord.LEAVE, byTheRecord("com.example.notes", "com.example.notes.UserSettingsActivity"))
        assertEquals(Guard.ByTheRecord.CLOSE, byTheRecord(controller, "com.android.permissioncontroller.safetycenter.ui.SafetyCenterActivity") { false })
    }

    @Test
    fun `the setting up of a work profile is an app of its own, and no browser`() {
        assertTrue("com.android.managedprovisioning" in Browsers.setUpOfAWorkProfile)
        assertTrue(Browsers.setUpOfAWorkProfile.none { it in Browsers.guarded || it in Browsers.knownByName || it == ownPackage })
    }

    @Test
    fun `a window of another browser that the lock screen does not hide is found`() {
        val covered: (String) -> Boolean = { it != ownPackage && (it in browsers || it in Browsers.setUpOfAWorkProfile) }
        var next = 0
        fun at(app: String?, left: Int, top: Int, right: Int, bottom: Int, layer: Int = 1, display: Int = 0, floats: Boolean = false) =
            Guard.Shown(++next, display, app, left, top, right, bottom, layer, floats)
        fun top(app: String?, layer: Int = 1) = at(app, 0, 0, 1080, 1170, layer)
        fun bottom(app: String?, layer: Int = 1) = at(app, 0, 1230, 1080, 2400, layer)
        fun whole(app: String?, layer: Int = 1, display: Int = 0) = at(app, 0, 0, 1080, 2400, layer, display)
        fun found(vararg windows: Guard.Shown) = Guard.showing(windows.toList(), covered)
        val browser = browsers.first()
        val clock = "com.google.android.deskclock"

        // Two apps side by side: the browser in either half shows.
        val inTheLowerHalf = bottom(browser)
        assertEquals(Guard.Showing(listOf(inTheLowerHalf), false), found(top(clock), inTheLowerHalf))
        val inTheUpperHalf = top(browser)
        assertEquals(Guard.Showing(listOf(inTheUpperHalf), false), found(inTheUpperHalf, bottom(ownPackage)))
        // Two apps that are no browsers, one app alone, and the app's own browser.
        assertEquals(Guard.Showing(emptyList(), false), found(top(clock), bottom("com.example.notes")))
        assertEquals(Guard.Showing(emptyList(), false), found())
        assertEquals(Guard.Showing(emptyList(), false), found(whole(ownPackage)))
        // A browser that fills the screen shows until the lock screen has come up over it.
        val alone = whole(browser)
        assertEquals(Guard.Showing(listOf(alone), false), found(alone))
        assertEquals(Guard.Showing(emptyList(), false), found(whole(ownPackage, layer = 2), whole(browser, layer = 1)))
        // The lock screen over a pair hides both halves.
        assertEquals(Guard.Showing(emptyList(), false), found(whole(ownPackage, layer = 3), top(clock), bottom(browser)))
        // A bubble opened over the lock screen: as Android 17 lists it, the browser's window lies above.
        val inABubble = at(browser, 42, 296, 1038, 2092, layer = 1)
        assertEquals(Guard.Showing(listOf(inABubble), false), found(inABubble, whole(ownPackage, layer = 0)))
        // A desktop of free windows on a second screen: the lock screen's window lies over the browser's, a little to the side.
        val free = at(browser, 741, 77, 1180, 955, layer = 1, display = 2)
        assertEquals(
            Guard.Showing(listOf(free), false),
            found(whole("com.android.launcher3"), at(ownPackage, 861, 144, 1300, 1022, layer = 2, display = 2), free, at("com.android.launcher3", 0, 0, 1920, 1080, layer = 0, display = 2)),
        )
        // A window on one screen is not hidden by one on another.
        val onTheSecond = whole(browser, layer = 1, display = 2)
        assertEquals(Guard.Showing(listOf(onTheSecond), false), found(whole(ownPackage, layer = 5, display = 0), onTheSecond))
        // A window the browser floats over the other apps shows over the lock screen, and is under no app's window.
        val floating = at(browser, 190, 663, 890, 1563, layer = 1, floats = true)
        assertEquals(Guard.Showing(listOf(floating), false), found(floating, whole(ownPackage, layer = 0)))
        val floatingLower = floating.copy(layer = 2)
        assertEquals(Guard.Showing(listOf(floatingLower), false), found(whole(ownPackage, layer = 4), floatingLower))
        // The system's own bars float too and are no one's to cover; neither hides anything.
        val bar = at("com.android.systemui", 0, 0, 1080, 2400, layer = 9, floats = true)
        assertEquals(Guard.Showing(listOf(inTheLowerHalf), false), found(bar, top(clock), inTheLowerHalf))
        // An app's window that does not say whose it is yet is worth another look; a bar that says nothing is not.
        assertEquals(Guard.Showing(emptyList(), true), found(top(clock), bottom(null)))
        assertEquals(Guard.Showing(emptyList(), false), found(top(clock), at(null, 0, 0, 1080, 63, floats = true)))
        // Every window to cover is found, not only the first.
        val second = at(browser, 100, 100, 500, 500, layer = 7, floats = true)
        assertEquals(Guard.Showing(listOf(inTheLowerHalf, second), false), found(top(clock), inTheLowerHalf, second))
        // The setting up of a work profile is covered the same way.
        val setUp = bottom("com.android.managedprovisioning")
        assertEquals(Guard.Showing(listOf(setUp), false), found(top(clock), setUp))
    }

    @Test
    fun `a window that still shows gets the lock screen first, then Home`() {
        fun next(sinceLockScreen: Long?, lockScreenUpFor: Long?, sinceHome: Long? = null, homes: Int = 0, homeCanHelp: Boolean = true) =
            Guard.againstWhatShows(sinceLockScreen, lockScreenUpFor, sinceHome, homes, homeCanHelp)
        // First the lock screen, whatever else is so.
        assertEquals(Guard.Against.LOCK_SCREEN, next(null, null))
        assertEquals(Guard.Against.LOCK_SCREEN, next(null, 60_000, homeCanHelp = false))
        // It is given its time to come up and hide the window.
        assertEquals(Guard.Against.WAIT, next(200, null))
        assertEquals(Guard.Against.WAIT, next(400, 100))
        assertEquals(Guard.Against.WAIT, next(Guard.HOME_AFTER - 1, Guard.HOME_AFTER - 1))
        // A bubble opened over a lock screen that was up already: the lock screen is still given its time.
        assertEquals(Guard.Against.WAIT, next(200, 60_000))
        assertEquals(Guard.Against.HOME, next(Guard.HOME_AFTER, 60_000))
        // Up for long enough with the window still showing: Home.
        assertEquals(Guard.Against.HOME, next(Guard.HOME_AFTER + 300, Guard.HOME_AFTER))
        // The lock screen did not come at all.
        assertEquals(Guard.Against.WAIT, next(Guard.LOCK_SCREEN_COMES_WITHIN - 1, null))
        assertEquals(Guard.Against.HOME, next(Guard.LOCK_SCREEN_COMES_WITHIN, null))
        // Home once in a while, and three times at most.
        assertEquals(Guard.Against.WAIT, next(3000, null, sinceHome = Guard.HOME_ONCE_IN - 1, homes = 1))
        assertEquals(Guard.Against.HOME, next(3000, null, sinceHome = Guard.HOME_ONCE_IN, homes = 1))
        assertEquals(Guard.Against.HOME, next(9000, 5000, sinceHome = 4000, homes = Guard.HOMES_AT_MOST - 1))
        assertEquals(Guard.Against.WAIT, next(9000, 5000, sinceHome = 4000, homes = Guard.HOMES_AT_MOST))
        // Home does nothing about a window an app floats, or one on a screen that does not have the focus.
        assertEquals(Guard.Against.WAIT, next(9000, 5000, homeCanHelp = false))
    }

    @Test
    fun `a cover put up at a window's first sign waits for the window to be listed`() {
        // A window has said it is there and is not listed yet: its cover stays.
        assertTrue(Guard.unlistedCoverStays(0, lockScreenListedSince = false))
        assertTrue(Guard.unlistedCoverStays(400, lockScreenListedSince = false))
        assertTrue(Guard.unlistedCoverStays(Guard.UNLISTED_COVER_FOR - 1, lockScreenListedSince = false))
        // The lock screen was started since and is listed without the window: the window is under it.
        assertFalse(Guard.unlistedCoverStays(300, lockScreenListedSince = true))
        // Never listed: the cover does not stay for good.
        assertFalse(Guard.unlistedCoverStays(Guard.UNLISTED_COVER_FOR, lockScreenListedSince = false))
        // A clock that was set back does not keep a cover.
        assertFalse(Guard.unlistedCoverStays(-5, lockScreenListedSince = false))
        // A word that was long on its way is no first sign any more.
        assertTrue(Guard.wordIsFresh(0))
        assertTrue(Guard.wordIsFresh(40))
        assertTrue(Guard.wordIsFresh(Guard.UNLISTED_COVER_FOR - 1))
        assertFalse(Guard.wordIsFresh(Guard.UNLISTED_COVER_FOR))
        assertFalse(Guard.wordIsFresh(18_000))
    }

    @Test
    fun `the record of app use is a first sign only of a screen brought forward just now`() {
        assertTrue(Guard.freshlyBroughtForward(0))
        assertTrue(Guard.freshlyBroughtForward(350))
        assertTrue(Guard.freshlyBroughtForward(Guard.BROUGHT_FORWARD_FRESH_FOR - 1))
        // A bubble that closed minutes ago is still the last screen the record names.
        assertFalse(Guard.freshlyBroughtForward(Guard.BROUGHT_FORWARD_FRESH_FOR))
        assertFalse(Guard.freshlyBroughtForward(10 * 60_000L))
        // The two clocks are read at different moments.
        assertTrue(Guard.freshlyBroughtForward(-40))
        assertFalse(Guard.freshlyBroughtForward(-60_000))
    }

    @Test
    fun `a cover leaves the navigation bar within reach`() {
        fun area(window: Guard.Shown, left: Int = 0, right: Int = 0, bottom: Int = 126) =
            Guard.coverArea(window, 1080, 2400, left, right, bottom)?.toList()
        // A window that fills the screen: everything but the bar at the bottom.
        assertEquals(listOf(0, 0, 1080, 2274), area(Guard.Shown(1, 0, "a", 0, 0, 1080, 2400, 1)))
        // A bubble and a floating window lie clear of the bar: covered as they are.
        assertEquals(listOf(42, 296, 1038, 2092), area(Guard.Shown(1, 0, "a", 42, 296, 1038, 2092, 1)))
        // The lower half of a pair ends at the bar.
        assertEquals(listOf(0, 1230, 1080, 2274), area(Guard.Shown(1, 0, "a", 0, 1230, 1080, 2400, 1)))
        // A phone on its side with the bar at the right or the left edge.
        assertEquals(listOf(0, 0, 954, 2400), area(Guard.Shown(1, 0, "a", 0, 0, 1080, 2400, 1), right = 126, bottom = 0))
        assertEquals(listOf(126, 0, 1080, 2400), area(Guard.Shown(1, 0, "a", 0, 0, 1080, 2400, 1), left = 126, bottom = 0))
        // A window that hangs over the edge of the screen is covered as far as the screen goes.
        assertEquals(listOf(0, 100, 300, 2274), area(Guard.Shown(1, 0, "a", -200, 100, 300, 2600, 1)))
        // Nothing of the window is left outside the bar: no cover.
        assertNull(area(Guard.Shown(1, 0, "a", 0, 2274, 1080, 2400, 1)))
    }

    @Test
    fun `a browser known by name is told where the phone does not show it, and is not this app`() {
        assertTrue("com.brave.browser" in Browsers.knownByName)
        assertEquals("Firefox", Browsers.knownByName["org.mozilla.firefox"])
        assertFalse(ownPackage in Browsers.knownByName)
        assertTrue("every one has a name", Browsers.knownByName.values.none { it.isBlank() })
    }

    @Test
    fun `a window that does not say whose it is, is asked less and less often`() {
        assertEquals(1000L, Guard.asksAgainAfter(1))
        assertEquals(2000L, Guard.asksAgainAfter(2))
        assertEquals(8000L, Guard.asksAgainAfter(4))
        assertEquals(32000L, Guard.asksAgainAfter(6))
        assertEquals(32000L, Guard.asksAgainAfter(40))
        assertEquals(1000L, Guard.asksAgainAfter(0))
    }
}
