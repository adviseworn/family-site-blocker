package io.gitlab.adviseworn.familysiteblocker.lock

/**
 * What the lock's watch goes by on the screens it guards (Settings, the installer, Security & privacy), and
 * when it looks at them. No phone is needed to work any of it out, so the unit tests pin it.
 */
object Guard {
    /**
     * Words that begin the label of a control that undoes the lock, the question it asks, or what its screen
     * says first: "Force stop", "Deactivate this device admin app", "Turn off …?", "Remove access", "Clear
     * storage", and "This admin app is active and allows the app … to perform the following operations:",
     * which is what Android 17 shows the watch of the administrator's screen, with its buttons kept back. They
     * count at the start of a text only. A page that lists the app among other things says such words in
     * passing: Android 17's list of accessibility settings has "Dark theme, color correction, remove
     * animations" on it, and an earlier build closed that list for the one word.
     */
    private val undoingLabels = listOf(
        "force stop", "disable", "deactivate", "turn off", "remove access", "clear data", "clear storage", "app info",
        "this admin app is active",
    )

    /** Words that give such a control, question or screen away wherever they stand in a text. */
    private val undoingAnywhere = listOf("uninstall", "full device access")

    private fun undoes(text: String): Boolean {
        if (undoingAnywhere.any { text.contains(it, ignoreCase = true) }) return true
        // The whole word: the list of all apps says "Disabled" under an app that is, and that is no Disable button.
        val label = text.trimStart()
        return undoingLabels.any { label.startsWith(it, ignoreCase = true) && label.getOrNull(it.length)?.isLetter() != true }
    }

    /**
     * What Android calls the permission to read its record of app use, on the screen that gives and takes it:
     * "Usage access" up to Android 15, "App usage data" from Android 16 on. Android 17 shows the watch that
     * screen's title and the sentence under its switch, not the switch's own label, so the name is enough
     * wherever it stands beside the app's. That closes the list of the apps that have it as well, which leads
     * nowhere else.
     */
    private val usageAccessNames = listOf("usage access", "app usage data")

    /**
     * Words of Android's question "Reset app preferences?" and of its button. Saying yes takes away, for every
     * app on the phone at once, what was allowed by hand, the lock's usage access with the rest; the question
     * names no app.
     */
    private val forEveryApp = listOf("reset app preferences?", "reset apps")

    /**
     * The app's own sentences that Android shows on two of its screens: the accessibility service's
     * description, beside the switch that turns the service off, and the device administrator's, on the screen
     * that deactivates it. They tell those screens whatever language the phone speaks, and when Android keeps
     * the buttons themselves from the watch (it does so with some, for an app that is not an accessibility
     * tool).
     */
    class OwnWords(val accessibility: String, val administrator: String)

    /**
     * Whether a screen showing [texts] offers to undo the lock of the app called [appName]: it shows one of
     * the app's [own] sentences, or it names the app and shows a way to remove it, stop it or take away what
     * the phone lets it do (Uninstall, Force stop, Disable, Deactivate, the accessibility switch "Use …" and
     * its question "Stop …?", Remove access on Security & privacy's "Review app with full device access", its
     * usage access). A screen that only lists the app among others, such as the list of accessibility
     * services, is left alone, and so is Android's question whether the app may send notifications. The screen
     * that sets the accessibility shortcut to the app is turned away too ("… shortcut"): used on the lock's
     * watch, the shortcut switches it off. So is the question "Reset app preferences?", which names no app
     * ([forEveryApp]).
     *
     * The lock must not shut out its own setting up. Where the phone has taken something away, or has not
     * given it yet, the screen that puts it right is left alone for as long as that lasts, and each of these is
     * asked only when its screen is the one shown:
     *  - the screen that makes the app a device administrator, while it is not one ([administrator]);
     *  - its usage access, while it has none ([usageAccess]);
     *  - its App info, while the phone may want "Allow restricted settings" before it gives the lock what it
     *    still lacks ([mayNeedAllowing]): that is in App info's menu. Force stop is on App info too, and its
     *    question names no app, so for that long the question is turned away whichever app it is about. What
     *    else App info leads to (the uninstall dialog, the page that clears the app's storage) names the app
     *    and is turned away as ever, the storage page by what it lists where its buttons are kept from the
     *    watch ([storagePage]);
     *  - the accessibility service's own screen and the one that sets the shortcut, while the shortcut is set
     *    to the app ([shortcutSet]): that is where it is taken off again. The question that switches the watch
     *    off ("Stop …?") is turned away all the same.
     */
    fun undoesTheLock(
        texts: List<String>,
        appName: String,
        own: OwnWords? = null,
        administrator: () -> Boolean = { true },
        usageAccess: () -> Boolean = { true },
        mayNeedAllowing: () -> Boolean = { false },
        shortcutSet: () -> Boolean = { false },
        rows: Set<Int> = emptySet(),
    ): Boolean {
        val administratorScreen = own != null && texts.any { it.contains(own.administrator) }
        val activating = texts.any { it.contains("activat", ignoreCase = true) && it.contains("admin", ignoreCase = true) }
        if ((administratorScreen || activating) && !administrator()) return false
        if (administratorScreen) return true
        if (texts.any { text -> forEveryApp.any { text.contains(it, ignoreCase = true) } }) return true
        if (texts.any { it.equals(FORCE_STOP_QUESTION, ignoreCase = true) } && mayNeedAllowing()) return true
        if (texts.any { it.contains("stop $appName", ignoreCase = true) }) return true
        val serviceScreen = (own != null && texts.any { it.contains(own.accessibility) }) ||
            texts.any { text -> listOf("use $appName", "$appName shortcut").any { text.contains(it, ignoreCase = true) } }
        if (serviceScreen) return !shortcutSet()
        val listed = texts.any { it.trim().equals(ALL_APPS, ignoreCase = true) }
        if (!names(texts, appName, listed, emptySet())) return false
        // The page that clears the app's storage, with or without its buttons ([storagePage]).
        if (storagePage.all { line -> texts.any { it.trim().equals(line, ignoreCase = true) } }) return true
        // A way to undo the lock counts beside the app's name as a page's own heading, not beside its row in
        // a list: the row only leads to the app's page, and the way may be on another app's ([names]).
        if (names(texts, appName, listed, rows)) {
            if (texts.any { text -> appInfo.any { text.equals(it, ignoreCase = true) } }) return !mayNeedAllowing()
            if (texts.any { undoes(it) }) return true
        }
        return texts.any { text -> usageAccessNames.any { text.contains(it, ignoreCase = true) } } && usageAccess()
    }

    /** What tells an app's App info from the screens it leads to: its title, and its Force stop button. */
    private val appInfo = listOf("App info", "Force stop")

    /**
     * Two lines that the page that clears an app's storage has under its buttons, and no other screen that
     * names an app has both. Android 17 keeps that page's buttons from the watch, as it does the device
     * administrator's, so "Clear storage" is not there to go by: seen on the Android 17 test phone, where
     * Settings, Storage, Apps leads to the page without passing App info. Android greys Clear storage out
     * while the app is a device administrator, and not before.
     */
    private val storagePage = listOf("App size", "User data")

    /** How Settings' list of all apps says the room an app takes, under its name: "288 MB", and "65.54 kB" with "Disabled" on a line below. */
    private val roomItTakes = Regex("""\s*\d+([.,]\d+)?\s?(B|kB|KB|MB|GB|TB)(\n.*)?""", RegexOption.DOT_MATCHES_ALL)

    /** The title of Settings' list of all apps, which the list also has on the menu that picks which apps it shows. */
    private const val ALL_APPS = "All apps"

    /** The buttons under an app's name on its App info, beside Force stop. */
    private val appInfoButtons = listOf("Open", "Archive", "Restore", "Uninstall", "Uninstall updates", "Disable", "Enable", "Install", "Force stop")

    /**
     * Whether a screen showing [texts] names the app called [appName] as more than a row in a list of apps.
     * Settings shows its list of all apps and each app's App info in one window, and while the one changes
     * into the other the watch is shown both: the app's row from the list, and another app's Force stop. An
     * earlier build closed that as the app's own App info, and closed the list itself when it said "Disabled"
     * under another app: both seen on the Android 15 test phone, going back from an app's App info to the
     * list. A phone that draws the change shows the two together for longer than the test phones do. So:
     *  - a name that stands in a row of that list ([rows], the places of such texts, see [isRow]) leads to
     *    the app's page and is not that page. The heading of App info cannot be tapped. This is the rule
     *    that holds however little of either page the watch was shown;
     *  - a name with the room the app takes under it is a row of such a list, and does not count;
     *  - on a screen that has the list of all apps on it ([listed]), the app's name counts only where it
     *    stands over App info's buttons, which is what tells its own App info. The list's rows come before
     *    their sizes do, so the size alone does not tell a row every time.
     * The last two need nothing but the words, and stand for where the watch was not told what can be tapped.
     */
    private fun names(texts: List<String>, appName: String, listed: Boolean, rows: Set<Int>): Boolean = texts.indices.any { i ->
        i !in rows && texts[i].contains(appName, ignoreCase = true) && texts.getOrNull(i + 1)?.let { roomItTakes.matches(it) } != true &&
            (!listed || texts.getOrNull(i + 1)?.trim().let { next -> appInfoButtons.any { it.equals(next, ignoreCase = true) } })
    }

    /**
     * Whether something on a screen is a row of one of Settings' newer lists: it can be tapped, and it says
     * it is a plain "android.view.View", which is what a row drawn by Jetpack Compose says. Those lists and
     * the pages their rows lead to share one window, and they are what the watch is shown two of at once.
     * Settings' older pages are each a window of their own, and something that can be tapped there is not
     * always a row: the heading of the page that clears an app's storage can be, and leads to its App info.
     * Such a thing says what it is made of ("android.widget.LinearLayout"), and its name counts as a
     * heading, as it did before the watch noted rows.
     */
    fun isRow(canBeTapped: Boolean, className: CharSequence?): Boolean = canBeTapped && className?.toString() == COMPOSE_NODE

    private const val COMPOSE_NODE = "android.view.View"

    /** The title of the question Force stop asks before it stops an app. */
    private const val FORCE_STOP_QUESTION = "Force stop?"

    /**
     * How long after a window has come to the front the watch looks at it again, in milliseconds. A page fills
     * in after its window is up, Android reports a change up to a tenth of a second late, and its record of
     * which screen is in front ([Front]) can trail the window, so the first second is looked at closely.
     */
    val fillInLooks: List<Long> = listOf(30, 70, 120, 180, 260, 380, 550, 800, 1200, 1800)

    /**
     * How long to wait for the next look at a window that came to the front [sinceFront] milliseconds ago and
     * has shown nothing to turn away yet; null when it is now left to its changes. [lookedAt] is when, counted
     * the same way, the look just made began. A phone whose looks are slow skips the times that have passed,
     * but the window is always looked at once more after the last of [fillInLooks].
     */
    fun nextFillInLook(sinceFront: Long, lookedAt: Long): Long? {
        val next = fillInLooks.firstOrNull { it > sinceFront }
        return when {
            next != null -> next - sinceFront
            lookedAt < fillInLooks.last() -> 0
            else -> null
        }
    }

    /** The least time between two looks that follow a change on the screen, in milliseconds. */
    const val LOOK_EVERY = 150L

    /**
     * How long after one look at a guarded app's screen the next is made for as long as that screen stays in
     * front, in milliseconds, whether the screen has said that it changed or not. A screen is not always
     * heard from. Settings' newer pages (the list of all apps, each app's App info, the pages under Special
     * app access) send their changes only to a watch that was running when the page was made: one that was
     * open while the watch started again, after the app was updated, goes from page to page without a word,
     * and the app's own App info is one tap from the list.
     */
    const val STEADY_LOOK_EVERY = 250L

    /** The longest a guarded app's screen that stays in front goes without a look, in milliseconds, however slow the phone's looks are. */
    const val STEADY_LOOK_AT_LATEST = 1500L

    /**
     * The wait before the next steady look, after a look that took [took] milliseconds. A phone whose looks
     * are slow is left twice a look's time between two, since reading a screen keeps its app busy as well,
     * but never more than [STEADY_LOOK_AT_LATEST]: one look that an app kept waiting must not leave its
     * screen unread for long.
     */
    fun steadyLookIn(took: Long): Long = (2 * took).coerceIn(STEADY_LOOK_EVERY, STEADY_LOOK_AT_LATEST)

    /**
     * When to look after a change on the screen, [sinceLastLook] milliseconds after the last look: 0 for now,
     * otherwise the wait until [LOOK_EVERY] has passed. The last change is always looked at; an earlier build
     * skipped a change that came within 400 milliseconds of a look, and a page that settled in that time was
     * never seen.
     */
    fun waitBeforeLook(sinceLastLook: Long): Long = if (sinceLastLook >= LOOK_EVERY || sinceLastLook < 0) 0 else LOOK_EVERY - sinceLastLook

    /** Back is sent at most once in this long, in milliseconds: the lock screen is on its way behind it. */
    const val BACK_ONCE_IN = 1000L

    /**
     * Whether turning a screen away sends Back, [sinceBack] milliseconds after the last Back. Back closes the
     * screen, which takes it off the top of Settings; the lock screen covers what is left either way. A screen
     * gets one Back each time it is brought to the front, so that a second look at a screen that is slow to
     * close does not close the one under it as well: [broughtForwardAt] is when Android's record of app use
     * says this screen was brought to the front, [backWentTo] the same for the screen the last Back went to,
     * each null where the record says nothing.
     */
    fun sendsBack(sinceBack: Long, broughtForwardAt: Long?, backWentTo: Long?): Boolean =
        sinceBack !in 0..BACK_ONCE_IN && (broughtForwardAt == null || broughtForwardAt != backWentTo)

    /**
     * The same screen gets a new line in the record at the earliest this long after its last one, and after
     * [RECORD_AT_LATEST] whatever has been in front since, in milliseconds.
     */
    const val RECORD_ONCE_IN = 3000L
    const val RECORD_AT_LATEST = 30_000L

    /**
     * Whether a turning away is written into the record. One turning away is one line, however many looks
     * find the screen before the lock screen is up. So a screen that is the same as the last one written down
     * ([sameAsLast], [sinceLast] milliseconds ago) gets a new line only after [RECORD_ONCE_IN], and only when
     * one of the app's own screens has come to the front in between ([ownScreenSince]): that is the lock screen
     * having come up, and the screen having been opened again. A slow phone takes seconds to bring the lock
     * screen up, and every look in that time finds the same screen and sends for it again; an earlier build
     * wrote down each of those that came three seconds after the last line, two lines for one try. After
     * [RECORD_AT_LATEST] the screen is written down whatever has been in front: a lock screen that cannot come
     * up must not hide the tries that follow.
     */
    fun writesDown(sameAsLast: Boolean, sinceLast: Long, ownScreenSince: Boolean): Boolean = when {
        !sameAsLast || sinceLast < 0 || sinceLast > RECORD_AT_LATEST -> true
        else -> sinceLast > RECORD_ONCE_IN && ownScreenSince
    }

    /**
     * How long after Back the lock screen follows it, in milliseconds, where the record of app use does not
     * tell when the screen has closed; and the longest it waits where the record does, for a screen whose
     * window the watch has seen, and for one it has not ([COVER_AT_LATEST_UNSEEN]).
     */
    const val COVER_AFTER = 120L
    const val COVER_AT_LATEST = 600L

    /**
     * The same for a screen Android keeps from the watch, which is closed on the record's word, perhaps before
     * its window is up. Android holds Back for the window that is coming, and a lock screen that came first
     * took it: the closed screen then stayed on top of Settings, to be met again the next time Settings was
     * opened. So the lock screen gives such a screen longer to come up and close.
     */
    const val COVER_AT_LATEST_UNSEEN = 2500L

    /**
     * Whether the lock screen is brought up now, [sinceBack] milliseconds after Back was sent to a screen. It
     * waits for the screen to close, so that Back lands on that screen and not on the lock screen: Android
     * gives a key to whichever window is in front when it gets round to it. The screen has closed when the
     * record of app use names another one as brought to the front ([inFrontNow]) than the one Back went to
     * ([backWentTo]); each is null where the record says nothing. [seen] is whether the watch has seen the
     * screen's window. The shield is up all the while.
     */
    fun coverFollows(sinceBack: Long, backWentTo: Long?, inFrontNow: Long?, seen: Boolean = true): Boolean = when {
        sinceBack < 0 || sinceBack >= (if (seen) COVER_AT_LATEST else COVER_AT_LATEST_UNSEEN) -> true
        backWentTo == null || inFrontNow == null -> sinceBack >= COVER_AFTER
        else -> inFrontNow != backWentTo
    }

    /**
     * How long Back waits for the window of a screen the record of app use names, in milliseconds: after
     * another window has taken the focus, after the focus has left the window before and no window has it,
     * and at most.
     */
    const val WINDOW_SETTLES_IN = 100L
    const val NO_WINDOW_FOR = 500L
    const val WINDOW_COMES_WITHIN = 3000L

    /**
     * Whether Back waits a little longer for a screen the record of app use names. The record names a screen
     * as soon as Android starts to bring it forward. The window it was opened from then still has the focus,
     * and a Back sent now would close that one and leave the new screen on top of it, to be met again the
     * next time Settings is opened. So Back waits for as long as the focus is on a window that had it
     * before the screen was named ([onTheWindowBefore]: the last one, or the one before that, which is what
     * comes back when a notification's shade closes). Once the watch has found the focus gone from there
     * ([sinceItLeft] milliseconds ago), Back waits [WINDOW_SETTLES_IN] more if another window has it
     * ([onAWindow]): that is the screen's own, which Android lists even when it shows nothing of it. If no
     * window has it, Back waits [NO_WINDOW_FOR]: Android tells the watch that the focus has gone a moment
     * before it stops giving keys to the window before. In all, it waits [WINDOW_COMES_WITHIN] at most from
     * the first look that found the screen named ([sinceNamed]). The shield is up all the while.
     */
    fun waitsForItsWindow(onTheWindowBefore: Boolean, onAWindow: Boolean, sinceNamed: Long, sinceItLeft: Long): Boolean = when {
        sinceNamed !in 0 until WINDOW_COMES_WITHIN -> false
        onTheWindowBefore -> true
        onAWindow -> sinceItLeft in 0 until WINDOW_SETTLES_IN
        else -> sinceItLeft in 0 until NO_WINDOW_FOR
    }

    /** How long after the lock screen has come to the front a Back still counts as sent to the screen under it, in milliseconds. */
    const val BACK_NOT_FOR_THE_LOCK_SCREEN = 500L

    /**
     * Whether a Back that reaches the lock screen [sinceInFront] milliseconds after it came to the front was
     * meant for the screen being closed under it. Android keeps a key for the window that comes to the front
     * next and hands it over at once, so such a Back arrives in the lock screen's first moment; a person's own
     * Back comes later, and one lost in that moment is pressed again. A lock screen that is not in front
     * (a time before 0) takes no Back at all.
     */
    fun backWasForAnotherScreen(sinceInFront: Long): Boolean = sinceInFront < BACK_NOT_FOR_THE_LOCK_SCREEN

    /**
     * A screen of Security & privacy (Android's Safety Center), by its class. While the lock is on it is
     * closed on sight, all of it: its "Review app with full device access" alert has a Remove access button
     * that switches the lock's watch off at one tap, and since Android 14 the whole of it is kept from the
     * watch, so there is no telling which of its pages shows the alert. The alert's other button opens a list
     * of the apps with full access, a screen of its own, which is closed the same way.
     */
    fun isSecurityAndPrivacy(className: String?): Boolean =
        className != null && closedOnSight.any { className.contains(it, ignoreCase = true) }

    private val closedOnSight = listOf("safetycenter", "ReviewAccessibilityServices")

    /**
     * The titles of Settings' own Security & privacy and of its Privacy controls page. From Android 16's
     * later releases on, Settings draws these two itself when they are opened from its first page or from its
     * search, under a class that tells nothing (SubSettings), and it shows the watch what is on them. Both
     * show the "Review app with full device access" alert, so both are closed by their title: on sight, before
     * the alert and its Remove access have been drawn, and whether or not the alert is on the page.
     */
    private val securityAndPrivacyTitles = listOf("security & privacy", "privacy controls")

    /** Whether [title], a window's or a row's, is one of [securityAndPrivacyTitles]. */
    fun namesSecurityAndPrivacy(title: CharSequence?): Boolean =
        title != null && title.toString().trim().lowercase().replace(" and ", " & ") in securityAndPrivacyTitles

    /**
     * Whether a screen of a guarded app is Settings' own Security & privacy or its Privacy controls page: its
     * window carries that title ([windowTitle]), or the page is headed by it ([texts]: the title stands first
     * and again within the next three, as a page's heading does, once for the bar and once in it). Settings'
     * first page names Security & privacy too, once, in its list, and is left alone, also when it has been
     * scrolled until that row is the first; so is "More security & privacy", which has neither the alert nor
     * that title.
     */
    fun isSecurityAndPrivacyScreen(windowTitle: CharSequence?, texts: List<String>): Boolean =
        namesSecurityAndPrivacy(windowTitle) ||
            (namesSecurityAndPrivacy(texts.firstOrNull()) && texts.drop(1).take(3).any { namesSecurityAndPrivacy(it) })

    /**
     * Whether a tap on something that says [texts], its title first, opens a screen with Remove access on it:
     * one of those two (the row on Settings' first page, the Privacy controls row, a search result), or the
     * list of apps with full access, which "Accessibility usage" under More security & privacy opens. The
     * shield goes up at the tap, so that the screen comes up under it. A result that only says where it is
     * found ("Device unlock", under Security & privacy) names it second and gets no shield at the tap: where
     * such a result opens Security & privacy itself, as on Android 17, that page is closed by its title once
     * it is up ([isSecurityAndPrivacyScreen]).
     */
    fun opensSecurityAndPrivacy(texts: List<CharSequence?>): Boolean {
        val title = texts.firstOrNull()
        return namesSecurityAndPrivacy(title) || title?.toString()?.trim().equals(FULL_ACCESS_LIST_ROW, ignoreCase = true)
    }

    private const val FULL_ACCESS_LIST_ROW = "Accessibility usage"

    /**
     * Screens of Settings that undo nothing of the lock but open a way round it. They are closed while the
     * lock is on:
     *  - Developer options, where USB debugging is switched on: through it a computer can stop the app, and
     *    with the app its watch;
     *  - Users, where another user or a guest is added and switched to: the lock is not there for them;
     *  - the setting up of a Private space: a browser installed only in there is an app the lock cannot tell
     *    from any other. Only the setting up is closed. The screen that asks for the phone's PIN before it is
     *    left alone, and so is the page of a Private space that is there already, which is where it is
     *    deleted.
     */
    enum class WayRound { DEVELOPER_OPTIONS, USERS, PRIVATE_SPACE }

    /**
     * What tells such a screen in the name of its class, when it has one of its own: Developer options and
     * Users opened from outside Settings, and the setting up of a Private space always. That last one shows
     * the watch nothing else.
     */
    private val wayRoundClasses = listOf(
        "DevelopmentSettings" to WayRound.DEVELOPER_OPTIONS,
        "WirelessDebugging" to WayRound.DEVELOPER_OPTIONS,
        "UserSettings" to WayRound.USERS,
        "PrivateSpaceSetup" to WayRound.PRIVATE_SPACE,
    )

    /** Their titles, for a screen that Settings draws under a class that tells nothing (SubSettings). */
    private val wayRoundTitles = mapOf(
        "developer options" to WayRound.DEVELOPER_OPTIONS,
        "wireless debugging" to WayRound.DEVELOPER_OPTIONS,
        "users" to WayRound.USERS,
        "multiple users" to WayRound.USERS,
    )

    private fun wayRoundNamed(title: CharSequence?): WayRound? = title?.let { wayRoundTitles[it.toString().trim().lowercase()] }

    /**
     * Which way round the lock a screen of a guarded app opens, if it is to be closed; null for any other
     * screen. It is told by its class ([className], as the record of app use names it), by its window's title
     * ([windowTitle]), or by its heading ([texts]: the title first and again within the next three, as with
     * [isSecurityAndPrivacyScreen]). The page of Settings that only lists such a screen names it once and is
     * left alone.
     *
     * As with what undoes the lock, a screen that puts something right stays open for as long as that lasts:
     * Developer options while a computer can already give the phone commands ([debugging]), which is where
     * that is switched off, and Users while the phone already lets users be switched ([userSwitching]).
     * The setting up of a Private space has nothing of the kind.
     */
    fun wayRound(
        className: String?,
        windowTitle: CharSequence?,
        texts: List<String>,
        debugging: () -> Boolean = { false },
        userSwitching: () -> Boolean = { false },
    ): WayRound? {
        val way = className?.let { name -> wayRoundClasses.firstOrNull { name.contains(it.first, ignoreCase = true) }?.second }
            ?: wayRoundNamed(windowTitle)
            ?: wayRoundNamed(texts.firstOrNull())?.takeIf { headed -> texts.drop(1).take(3).any { wayRoundNamed(it) == headed } }
        return when (way) {
            WayRound.DEVELOPER_OPTIONS -> way.takeUnless { debugging() }
            WayRound.USERS -> way.takeUnless { userSwitching() }
            else -> way
        }
    }

    /**
     * The words of the switch on Settings' page for one app's leave to display over other apps, as Android
     * words it, and as its early versions did.
     */
    private val displayOverSwitch = listOf("allow display over other apps", "permit drawing over other apps")

    /**
     * Which of the phone's other browsers a screen of Settings would let display over other apps: the name
     * among [browsers] that stands on the page of that switch ([texts]), null for any other screen. An app
     * with that leave floats a window over every other app, and one it makes take no touches is a window
     * Android never tells the watch about: nothing says where it lies, so it gets no cover. So while the lock
     * is on, the page stays closed for another browser that does not have the leave. For one that has it the
     * watch leaves the page open, which is where the leave is taken away, as with the other ways round the
     * lock ([wayRound]).
     *
     * The page is told by the words of its switch, wherever on it Settings puts its title. The list of the
     * apps that may ask for the leave has no such switch and is left alone, and so are the page of an app that
     * is no browser and an app's App info, which only names the row.
     *
     * The app the switch is for stands right over it, with its version between them at most. A browser named
     * anywhere else is not the one: for the moment in which the list changes into an app's page the watch is
     * shown both, the browser's row from the list and the switch of the app that was tapped.
     */
    fun letsDisplayOver(texts: List<String>, browsers: Collection<String>): String? {
        val switch = texts.indexOfFirst { it.trim().lowercase() in displayOverSwitch }
        if (switch < 0) return null
        return texts.subList(maxOf(0, switch - 2), switch).map { it.trim() }.lastOrNull { it in browsers }
    }

    /** What the watch does about the screen that Android's record of app use names as the one in front. */
    enum class ByTheRecord { CLOSE, COVER_IF_HIDDEN, LEAVE }

    /**
     * What to do about the screen the record of app use names as the last one brought to the front
     * ([packageName] and [className], null when the record says nothing). Security & privacy is closed,
     * whatever the watch is shown of the window in front: the record names it before its window is up. So is
     * a screen whose class tells that it opens a way round the lock ([wayRound], which is asked about the
     * class and answers for now: see [Guard.wayRound]). Another browser is covered when the window in front
     * is one the watch cannot read. Anything else is left alone, the app's [own] screens first of all.
     */
    fun byTheRecord(
        packageName: String?,
        className: String?,
        own: String,
        browsers: Set<String>,
        guarded: Set<String>,
        wayRound: (String) -> Boolean = { false },
    ): ByTheRecord = when {
        packageName == null || packageName == own -> ByTheRecord.LEAVE
        packageName in guarded && isSecurityAndPrivacy(className) -> ByTheRecord.CLOSE
        packageName in guarded && className != null && wayRound(className) -> ByTheRecord.CLOSE
        packageName in browsers -> ByTheRecord.COVER_IF_HIDDEN
        else -> ByTheRecord.LEAVE
    }

    /**
     * A window on a screen, as the watch is shown it: its number ([id]) and the screen it is on ([display]),
     * whose it is ([packageName], null while the window shows nothing of that), where it lies, how far up
     * ([layer]), and whether it is one an app floats over the other apps ([floats]) and not a screen of its own.
     */
    data class Shown(
        val id: Int,
        val display: Int,
        val packageName: String?,
        val left: Int,
        val top: Int,
        val right: Int,
        val bottom: Int,
        val layer: Int,
        val floats: Boolean = false,
    ) {
        fun liesWithin(other: Shown): Boolean =
            left >= other.left && top >= other.top && right <= other.right && bottom <= other.bottom
    }

    /** The windows to cover ([showing]), and whether a window that may be one of them does not say whose it is yet. */
    data class Showing(val windows: List<Shown>, val unread: Boolean)

    /**
     * The windows of the apps to be covered ([covered]: another browser, the setting up of a work profile)
     * that are on a screen, among [windows], which are all the apps' windows there. The lock screen takes the
     * place of such an app when it comes to the front, and that hides a window which fills the screen. It
     * does not hide one that is only shown: in the other half when two apps are side by side, in a bubble
     * that opens over whatever is in front, on a desktop of free windows on a second screen, or in a window
     * the app floats over the other apps. The watch covers each of those where it lies.
     *
     * A window that lies under another app's window and within it does not count: the lock screen has just
     * come up over it. A window an app floats is under none. [Showing.unread] says that an app's window shows
     * nothing of whose it is yet, which is worth another look.
     */
    fun showing(windows: List<Shown>, covered: (String) -> Boolean): Showing {
        var unread = false
        val found = ArrayList<Shown>()
        for (window in windows) {
            val app = window.packageName
            if (app == null) {
                if (!window.floats) unread = true
                continue
            }
            if (!covered(app)) continue
            val hidden = !window.floats && windows.any { above ->
                !above.floats && above.display == window.display && above.layer > window.layer && window.liesWithin(above)
            }
            if (!hidden) found += window
        }
        return Showing(found, unread)
    }

    /** How long a window that did not say whose it is, is left alone before it is asked a second time, in milliseconds. */
    const val ASK_AGAIN_AFTER = 1000L

    /**
     * How long a window that has been asked whose it is [times] times without an answer is left alone before
     * it is asked again, in milliseconds: twice as long each time, up to half a minute. The watch waits for
     * each answer, and a window that never gives one must not keep it waiting again and again.
     */
    fun asksAgainAfter(times: Int): Long = ASK_AGAIN_AFTER shl (times - 1).coerceIn(0, 5)

    /** What the watch does next about a window to be covered that is still on a screen ([againstWhatShows]). */
    enum class Against { LOCK_SCREEN, HOME, WAIT }

    /** How long the lock screen is given to hide such a window before Home is sent, in milliseconds: it comes up well within that. */
    const val HOME_AFTER = 700L

    /** The longest the lock screen is waited for before Home is sent without it, in milliseconds. */
    const val LOCK_SCREEN_COMES_WITHIN = 2000L

    /** Home is sent at most once in this long, in milliseconds, and at most [HOMES_AT_MOST] times for one window that stays. */
    const val HOME_ONCE_IN = 1500L
    const val HOMES_AT_MOST = 3

    /**
     * What to do next about a window to be covered that is on a screen. Its cover is on it already. First the
     * lock screen is sent for, which says what happened, and which takes a bubble off the screen when it
     * comes to the front from behind. A bubble that was opened over the lock screen itself stays, and so does
     * a free window beside it: when the lock screen was sent for [HOME_AFTER] ago, has been up that long and
     * the window still shows, or the lock screen has not come within [LOCK_SCREEN_COMES_WITHIN], Home is
     * sent, which closes a bubble and puts a free window away. Home goes to the screen that has the focus and
     * does nothing about a window an app floats, so it is sent only when [homeCanHelp]. After [HOMES_AT_MOST]
     * the window keeps its cover and nothing more is sent.
     *
     * [sinceLockScreen] is how long ago the lock screen was sent for this window, null when it has not been;
     * [lockScreenUpFor] how long the lock screen has been on a screen, null while it is not; [sinceHome] how
     * long ago Home was sent for it, null when it has not been; [homes] how many times.
     */
    fun againstWhatShows(sinceLockScreen: Long?, lockScreenUpFor: Long?, sinceHome: Long?, homes: Int, homeCanHelp: Boolean): Against = when {
        sinceLockScreen == null -> Against.LOCK_SCREEN
        !homeCanHelp || homes >= HOMES_AT_MOST -> Against.WAIT
        sinceHome != null && sinceHome < HOME_ONCE_IN -> Against.WAIT
        lockScreenUpFor != null -> if (lockScreenUpFor >= HOME_AFTER && sinceLockScreen >= HOME_AFTER) Against.HOME else Against.WAIT
        sinceLockScreen >= LOCK_SCREEN_COMES_WITHIN -> Against.HOME
        else -> Against.WAIT
    }

    /**
     * Where the cover over a window goes: the window's own place, less the edges of the screen that hold the
     * navigation bar ([barLeft], [barRight] and [barBottom] wide, on a screen [screenWidth] by [screenHeight]).
     * Home and Back stay within reach under any cover, so no cover can keep the phone. Null when nothing of
     * the window is left to cover.
     */
    fun coverArea(window: Shown, screenWidth: Int, screenHeight: Int, barLeft: Int, barRight: Int, barBottom: Int): IntArray? {
        val left = maxOf(window.left, barLeft)
        val top = maxOf(window.top, 0)
        val right = minOf(window.right, screenWidth - barRight)
        val bottom = minOf(window.bottom, screenHeight - barBottom)
        return if (right > left && bottom > top) intArrayOf(left, top, right, bottom) else null
    }

    /** For how long after a screen was brought to the front the record of app use counts as a first sign of it, in milliseconds. */
    const val BROUGHT_FORWARD_FRESH_FOR = 2000L

    /**
     * Whether a screen that Android's record of app use names as the last one brought to the front,
     * [sinceBroughtForward] milliseconds ago, has only just come: then it is in front now, or about to be.
     * The record goes on naming a screen after it has left the front without another one coming, as a
     * bubble does when it closes, so an older entry says nothing. The record's clock and the watch's are read
     * at different moments, so a little ahead of now still counts.
     */
    fun freshlyBroughtForward(sinceBroughtForward: Long): Boolean = sinceBroughtForward in -5_000L until BROUGHT_FORWARD_FRESH_FOR

    /**
     * Whether a window's own word that it is there, sent [sentAgo] milliseconds ago, is still a first sign of
     * it. A word that was that long on its way to the watch tells nothing new: Android has listed the
     * window by now, or the window has gone, and a cover put up for it would lie over nothing.
     */
    fun wordIsFresh(sentAgo: Long): Boolean = sentAgo < UNLISTED_COVER_FOR

    /** The longest a cover that was put up at a window's first sign stays while Android does not list the window, in milliseconds. */
    const val UNLISTED_COVER_FOR = 1500L

    /**
     * Whether a cover that was put up at a window's first sign stays, [sinceItsSign] milliseconds after it,
     * while Android still does not list the window. The first sign is the window's own word that it is there,
     * or a look that finds it in front. It comes as the window starts to show, and Android lists the window,
     * with where it lies, only when its opening has come to rest: a bubble's page would be on show for that
     * long. Until then nobody can say where the window lies, so its cover takes the whole screen. The cover
     * comes off when the lock screen has been started since and Android lists the lock screen and not this
     * window ([lockScreenListedSince]): the window is under it. It comes off after [UNLISTED_COVER_FOR] at
     * the latest, so that a sign no window followed leaves nothing on the screen.
     */
    fun unlistedCoverStays(sinceItsSign: Long, lockScreenListedSince: Boolean): Boolean =
        sinceItsSign in 0 until UNLISTED_COVER_FOR && !lockScreenListedSince

    /**
     * Whether a change to the windows on the screen, as AccessibilityEvent.getWindowChanges tells it, can mean
     * that another window is in front now: one was added or taken away, made the active one or given the
     * focus, or its title changed. A window that only moved or was resized is not looked at. 0 is what an
     * Android before 9 says of every change.
     */
    fun bringsAWindowForward(windowChanges: Int): Boolean = windowChanges == 0 || windowChanges and FORWARD != 0

    /** WINDOWS_CHANGE_ADDED, _REMOVED, _TITLE, _ACTIVE and _FOCUSED of AccessibilityEvent. */
    private const val FORWARD = 0x1 or 0x2 or 0x4 or 0x20 or 0x40

    /**
     * Whether the accessibility shortcut (holding both volume keys, or the accessibility button) is set to a
     * service of the app whose package is [own]: [targets] are Android's lists of what the shortcuts turn on
     * and off, services' names with colons between. Used on a service like the lock's watch, the shortcut
     * switches it off, with no screen to turn away.
     */
    fun shortcutSetTo(own: String, targets: List<String?>): Boolean =
        targets.any { list -> list.orEmpty().split(':').any { it.trim().startsWith("$own/") } }
}
