package io.gitlab.adviseworn.familysiteblocker.lock

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.app.ActivityOptions
import android.app.AppOpsManager
import android.app.Dialog
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Point
import android.graphics.Rect
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.hardware.display.DisplayManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import android.util.TypedValue
import android.view.Display
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.core.os.HandlerCompat
import io.gitlab.adviseworn.familysiteblocker.R
import org.json.JSONObject

/**
 * The lock's watch. Android tells an accessibility service which window has come to the front and when
 * something on it changes; while the lock is on, this one turns these away:
 *  - another browser (any app that opens web links, [Browsers.packages]): its screen is covered by
 *    [LockScreenActivity], which offers Family Site Blocker instead. A window of it that the lock screen
 *    does not hide (beside another app, in a bubble, on a second screen, floating over the other apps) gets
 *    a cover of its own where it lies ([coverWhatShows]), and its screen a plain one at the window's first
 *    sign, before Android says where the window lies ([atFirstSign]);
 *  - a screen of Settings or the installer that offers to undo the lock (the app's App info with Uninstall
 *    and Force stop, the device administrator's deactivation, the accessibility switch, the uninstall dialog,
 *    its usage access): the screen is closed, and the lock screen says the lock holds it. While the lock still
 *    lacks something, the screen that gives it is left open ([Guard.undoesTheLock]);
 *  - Security & privacy ([Guard.isSecurityAndPrivacy], [Guard.isSecurityAndPrivacyScreen]): one tap on its
 *    Remove access switches this watch off. Android 14 and 15 keep that whole screen from a service like this
 *    one, so it is told by its class; later Android draws it in Settings itself, where it is told by its
 *    title, and a tap on the row that opens it puts the shield up before it comes ([shieldForATap]);
 *  - Developer options, Users and the setting up of a Private space ([Guard.wayRound]), which undo nothing
 *    but open a way round the lock: a computer's commands, a user the lock is not there for, a place for a
 *    browser it cannot see. They are closed like the others, and so is the page whose switch lets another
 *    browser display over other apps ([Guard.letsDisplayOver]): a window floated that way can be one the
 *    watch is never told about. For as long as a browser holds that leave all the same, Android is made to
 *    keep every floating window off the screens ([keepFloatingWindowsOff]);
 *  - the setting up of a work profile, which is such a place too ([Browsers.setUpOfAWorkProfile]). It is an
 *    app of its own with nothing of Settings under it, so it is covered as another browser is;
 *  - while a bedtime is set, the Settings screens that set the phone's clock, which the bedtime goes by
 *    ([ClockScreen]): closed like the screens that undo the lock;
 *  - at bedtime, with "other apps" switched on from the Lock page, every other app but the few a phone is for
 *    at night ([BedtimeWatch], [BedtimeApps]): covered like another browser.
 * It reads nothing else: the only text it looks for is the app's own name next to one of those actions
 * ([Guard.undoesTheLock]), the titles of those screens, another browser's name beside that switch and the
 * words of Date & time, and only on the screens of the apps in [Browsers.guarded] and in a tap that opens
 * Security & privacy from Settings' search or the home screen.
 *
 * A screen is looked at when it comes to the front, again while its page fills in, and after every change on
 * it ([Guard.fillInLooks], [Guard.waitBeforeLook]): what settles last is always seen. A guarded app's screen
 * is also looked at steadily for as long as it stays in front ([lookSteadily]), because a page does not
 * always say that it has changed. A window Android keeps from the watch is told by Android's record of app
 * use ([Front]).
 *
 * No look is made while Android is handing over a change: each waits its turn behind the changes that have
 * already come, so however many come at once, they are answered by one look, and the shield and the lock
 * screen are never kept waiting behind them.
 */
class LockAccessibilityService : AccessibilityService() {
    private lateinit var state: LockState
    private lateinit var front: Front
    private lateinit var bedtime: BedtimeWatch
    @Volatile private var browsers: Set<String> = emptySet()

    /** The phone's other browsers by what they are called, which is how a page of Settings names them ([Guard.letsDisplayOver]). */
    @Volatile private var browserNames: Map<String, List<String>> = emptyMap()
    private val main = Handler(Looper.getMainLooper())

    /** Marks the looks that wait their turn, so that they can be called off together. */
    private val looks = Any()
    private var lookWaits = false
    private var lastLookAt = 0L

    /**
     * How long the last look took, whether it found a guarded app's screen in front and left it open, and
     * whether the next steady look is set ([lookSteadily]).
     */
    private var lastLookTook = 0L
    private var guardedStays = false
    private var steadyWaits = false
    private var lastRecordAt = 0L
    private var lastRecorded: String? = null

    /** When one of the app's own screens last came to the front, for [Guard.writesDown]. */
    private var ownScreenAt = 0L
    private var lastCoverAt = 0L
    private var lastCovered: String? = null

    /** When Back was last sent, and when the screen it went to was brought to the front ([Guard.sendsBack]). */
    private var lastBackAt = 0L
    private var backWentTo: Long? = null

    /**
     * Which window had the focus at the last look that found no screen to close by the record, and which one
     * before that; and the screen the record has named since, by when it was brought to the front, with the
     * time of the first look that found it named ([Guard.waitsForItsWindow]).
     */
    private var focusedBefore: Int? = null
    private var focusedEarlier: Int? = null
    private var named: Long? = null
    private var namedAt = 0L

    /** When the watch first found the focus gone from that window, for the screen [named]; 0 while it has not. */
    private var focusLeftAt = 0L

    /** Back has been sent and the lock screen is about to follow it: nothing is looked at in between. */
    private var covering = false
    private val coverWaits = Any()

    /** Until when an app that the bedtime turns away, and that has said it is coming to the front, is looked for there. */
    private var bedtimeAppComesBy = 0L

    /** Marks the look set for the end of an off period, and the end it is set for. */
    private val relock = Any()
    private var lookSetFor = 0L

    /** The plain screen put over everything while a screen is being closed ([raiseShield]), and what takes it down. */
    private var shield: View? = null
    private val shieldDown = Any()

    /** The covers over the windows of other browsers that are on a screen ([coverWhatShows]), by the window's number. */
    private val covers = HashMap<Int, Cover>()

    /** Marks the look that follows while a cover is up. */
    private val coverLooks = Any()

    /** Each screen as it was last measured ([measure]), by its number. */
    private val measures = HashMap<Int, Measure>()

    /**
     * The windows to cover that were on a screen at the last look, by their numbers; when the lock screen
     * and when Home were sent for them, 0 while they have not been, and how many times Home was
     * ([Guard.againstWhatShows]). A window that was not among them starts the count afresh.
     */
    private var shownBefore: Set<Int> = emptySet()
    private var lockScreenSentAt = 0L
    private var homeSentAt = 0L
    private var homesSent = 0

    /** A window that may be one to cover did not say whose it is at the last look. */
    private var unreadBeside = false

    /** Whose each window on the screens is, by the window's number: asked once, since a window does not change hands. */
    private val owners = HashMap<Int, String>()

    /** The windows that did not say whose they are, by their numbers: when each was last asked, and how many times so far ([whose]). */
    private val unanswered = HashMap<Int, Pair<Long, Int>>()

    /**
     * Until when a window of another browser is expected among the windows on the screen: it has just told
     * the watch that it is there, and Android's list of the windows can trail that by a moment.
     */
    private var expectedUntil = 0L

    /** The lock screen's own window, by its number, from the last time it said it was in front; -1 before that. */
    private var lockScreenWindow = -1

    /** When the screen was brought to the front that the watch last took for a first sign of another browser ([signOfABrowser]). */
    private var signedAt = 0L

    /**
     * A cover or the shield has been put up in this turn and is not drawn yet. The watch draws them itself,
     * and cannot while it is busy asking Android for something: whatever would do that waits for the next
     * turn ([look], [atFirstSign]).
     */
    private var drawsFirst = false

    /**
     * Marks what follows a cover put up at a first sign, once it is drawn, and when that was set, 0 once it
     * has been done ([followsACover]).
     */
    private val firstSigns = Any()
    private var followSetAt = 0L

    /** What the last look read of the windows on the screens, for [note]. */
    private var windowsNoted = ""

    /**
     * The window that makes Android keep every app's floating windows off the screens
     * ([keepFloatingWindowsOff]), null while they may show; and when the watch last asked whether another
     * browser may float one.
     */
    private var hider: Dialog? = null
    private var floatingAskedAt = 0L

    /** Android's word that an app has been given the leave to display over other apps, or has lost it. */
    private val leaveChanged = AppOpsManager.OnOpChangedListener { _, _ -> main.post { keepFloatingWindowsOff(now = true) } }

    private val ownWords by lazy {
        Guard.OwnWords(getString(R.string.lock_accessibility_description), getString(R.string.lock_admin_description))
    }

    private val packagesChanged = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            rescanBrowsers()
            bedtime.rescan()
        }
    }

    /** The screen has been switched on: the steady looks stopped while it was dark ([lookSteadily]). */
    private val screenOn = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) { if (lockIsOn()) watchClosely() }
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        askForItsEvents()
        state = LockState(this)
        front = Front(this)
        // What bedtime began with in front has sent the watch nothing either: the bedtime's own clock asks for a look.
        bedtime = BedtimeWatch(this, state) { if (lockIsOn()) watchClosely() }
        rescanBrowsers()
        bedtime.start()
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
        ContextCompat.registerReceiver(this, screenOn, IntentFilter(Intent.ACTION_SCREEN_ON), ContextCompat.RECEIVER_EXPORTED) // the same
        runCatching {
            (getSystemService(APP_OPS_SERVICE) as AppOpsManager).startWatchingMode(AppOpsManager.OPSTR_SYSTEM_ALERT_WINDOW, null, leaveChanged)
        }.onFailure { note { "no word when the leave to display over other apps changes: $it" } }
        state.record("watch-on", JSONObject())
        state.noteUsageAccess(Permissions.usageOn(this))
        // Whatever is in front as the watch starts has sent it nothing yet.
        if (lockIsOn()) watchClosely()
        main.post { measureThePhonesScreen() }
    }

    /** The screen has been turned, or its bars have changed: what was measured of the screens no longer holds. */
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        measures.clear()
        main.post { measureThePhonesScreen() }
    }

    private fun measureThePhonesScreen() {
        runCatching { measure(Display.DEFAULT_DISPLAY, getSystemService(WINDOW_SERVICE) as WindowManager) }
    }

    /**
     * Asks Android once more for what the watch's description asks for (res/xml/accessibility_service.xml).
     * After an update Android can go on with the older build's description until the watch is switched off
     * and on: seen on Android 9, where the watch was then not told that the windows on the screen had
     * changed, and that is all it is told of a screen Android keeps from it.
     */
    private fun askForItsEvents() {
        val info = runCatching { serviceInfo }.getOrNull() ?: return
        info.eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED or
            AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED or AccessibilityEvent.TYPE_WINDOWS_CHANGED or
            AccessibilityEvent.TYPE_VIEW_CLICKED
        info.flags = info.flags or AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        info.notificationTimeout = 0
        runCatching { serviceInfo = info }.onFailure { note { "the watch's events: $it" } }
    }

    /**
     * Re-reads the phone's other browsers off the main thread; the field is volatile, read on the event
     * thread. The browsers known by name are added ([Browsers.knownByName]): one of them may be installed
     * where the phone does not show it to this app. The record of app use gets its first, longest reading
     * there too.
     */
    private fun rescanBrowsers() {
        val app = applicationContext
        Thread {
            val installed = Browsers.packages(app)
            browsers = installed + Browsers.knownByName.keys
            browserNames = installed.groupBy { Browsers.label(app, it) }
            main.post { keepFloatingWindowsOff(now = true) }
            front.last()
        }.start()
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        if (::bedtime.isInitialized) bedtime.stop()
        lowerShield()
        dropCovers()
        letFloatingWindowsShow()
        runCatching { (getSystemService(APP_OPS_SERVICE) as AppOpsManager).stopWatchingMode(leaveChanged) }
        runCatching { unregisterReceiver(packagesChanged) }
        runCatching { unregisterReceiver(screenOn) }
        if (::state.isInitialized) state.record("watch-off", JSONObject())
        super.onDestroy()
    }

    override fun onInterrupt() = Unit

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        val type = event.eventType
        if (type == AccessibilityEvent.TYPE_WINDOWS_CHANGED) {
            // Android's own word that the windows on the screen have changed. It comes for every window, also
            // for one whose arrival and content Android keeps from the watch.
            val changes = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) event.windowChanges else 0
            if (!Guard.bringsAWindowForward(changes)) return
            if (lockIsOn()) watchClosely()
            return
        }
        if (type == AccessibilityEvent.TYPE_VIEW_CLICKED) {
            shieldForATap(event)
            return
        }
        val cameToFront = type == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
        if (!cameToFront && type != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) return
        val packageName = event.packageName?.toString() ?: return
        // Also when the app itself is in front: the lock is switched on and off there.
        keepFloatingWindowsOff()
        if (packageName == this.packageName) {
            // The lock screen, or the browser, is in front: nothing is left under the shield to tap. The picture
            // Android shows while a screen starts does not count: it comes under the app's name too, and it lets
            // taps through to what is under it.
            if (cameToFront && event.className?.startsWith(packageName) == true) {
                ownScreenAt = SystemClock.elapsedRealtime()
                lowerShield()
                if (event.className?.toString() == LockScreenActivity::class.java.name) lockScreenWindow = event.windowId
                // The lock screen is up: a cover over what it has hidden comes off, and one over what it has not, stays.
                if (covers.isNotEmpty()) coverWhatShows()
            }
            return
        }
        if (!lockIsOn()) return
        when {
            // Another browser is covered as it comes to the front, and the look that follows covers its window
            // where the lock screen cannot.
            packageName in browsers -> if (cameToFront) coverAndLook(packageName, event) else lookSoon(event)
            // The setting up of a work profile is covered the same way.
            packageName in Browsers.setUpOfAWorkProfile -> if (cameToFront) coverAndLook(packageName, event) else lookSoon(event)
            packageName in Browsers.guarded -> when {
                !cameToFront -> lookSoon()
                // Android 13 still shows the watch that Security & privacy has come to the front.
                Guard.isSecurityAndPrivacy(event.className?.toString()) -> turnAway(packageName, LockScreenActivity.REASON_SECURITY)
                // Anything else is looked at. A way round the lock is not closed on this word alone, though it
                // names the screen's class: the word can come before the screen takes keys, and a Back sent
                // then goes to whatever was in front before. The look closes it by the record of app use, once
                // its window has the focus, or by its title.
                else -> {
                    note { "front: $packageName ${event.className} ${event.text}" }
                    watchClosely()
                }
            }
            // At bedtime, an app that is turned away then: the front is looked at, and the app is covered once
            // its window is the one there. A window says it is coming a moment before it is in front.
            bedtime.turnsAway(packageName) -> if (cameToFront) {
                bedtimeAppComesBy = SystemClock.elapsedRealtime() + Guard.fillInLooks.last()
                watchClosely()
            } else {
                lookSoon()
            }
        }
    }

    /**
     * A tap in Settings, in its search or on the home screen on what opens Settings' own Security & privacy
     * ([Guard.opensSecurityAndPrivacy], [Browsers.leadIntoSettings]): the shield goes up now, and that screen
     * comes up under it, to be closed by its title. Without this the screen would be there to tap for the moment it takes the watch to
     * be told of it, and one tap on its Remove access is enough. A shield that nothing came up under comes
     * down by itself ([SHIELD_AFTER_A_TAP]).
     */
    private fun shieldForATap(event: AccessibilityEvent) {
        val from = event.packageName?.toString() ?: return
        if (from !in Browsers.guarded && from !in Browsers.leadIntoSettings) return
        val says: List<CharSequence?> = event.text.ifEmpty { listOfNotNull(event.contentDescription) }
        if (!Guard.opensSecurityAndPrivacy(says) || !lockIsOn()) return
        note { "tapped in $from: $says" }
        raiseShield(SHIELD_AFTER_A_TAP)
        watchClosely()
    }

    /**
     * Whether the lock is on now. An off period that has run out is sealed again here; one that is still
     * running gets a look set for its end, when the lock comes back by itself: a screen Android keeps from the
     * watch could be in front then, and it sends the watch nothing to look at.
     */
    private fun lockIsOn(): Boolean {
        state.relockIfDue()
        keepFloatingWindowsOff()
        if (state.isOn) return true
        val until = state.offUntil
        if (state.isOff && until != lookSetFor) {
            lookSetFor = until
            main.removeCallbacksAndMessages(relock)
            HandlerCompat.postDelayed(main, { lookSetFor = 0; if (lockIsOn()) watchClosely() }, relock, until - System.currentTimeMillis() + 50)
        }
        return false
    }

    /** A window has come to the front, or may have: it is looked at at once, and again while its page fills in. */
    private fun watchClosely() {
        callOffLooks()
        lookWhileItFillsIn(SystemClock.elapsedRealtime(), 0)
    }

    /** One look at a window that came to the front at [cameAt], after [wait]; the next is set when it is done. */
    private fun lookWhileItFillsIn(cameAt: Long, wait: Long) {
        HandlerCompat.postDelayed(main, {
            val lookedAt = SystemClock.elapsedRealtime() - cameAt
            if (look()) Guard.nextFillInLook(SystemClock.elapsedRealtime() - cameAt, lookedAt)?.let { lookWhileItFillsIn(cameAt, it) }
        }, looks, wait)
    }

    /**
     * Something changed on a watched app's screen: it is looked at as soon as the last look allows. [from] is
     * the word of it when it came from an app to be covered: the window it came from is that app's.
     */
    private fun lookSoon(from: AccessibilityEvent? = null) {
        from?.let { ownedBy(it) }
        if (lookWaits) return
        lookWaits = true
        HandlerCompat.postDelayed(main, { lookWaits = false; look() }, looks, Guard.waitBeforeLook(SystemClock.elapsedRealtime() - lastLookAt))
    }

    /**
     * A guarded app's screen is in front and has been left open: it is looked at again [Guard.steadyLookIn]
     * after the last look, and so on for as long as it stays and the phone's screen is on, whether it says
     * that it has changed or not. A look that a change has prompted in the meantime counts as one of these.
     * Every look that reads such a screen sets the next ([look]).
     */
    private fun lookSteadily() {
        if (steadyWaits) return
        steadyWaits = true
        val wait = lastLookAt + Guard.steadyLookIn(lastLookTook) - SystemClock.elapsedRealtime()
        HandlerCompat.postDelayed(main, {
            steadyWaits = false
            when {
                !guardedStays || !screenIsOn() -> Unit
                SystemClock.elapsedRealtime() - lastLookAt in 0 until Guard.steadyLookIn(lastLookTook) -> lookSteadily()
                else -> look()
            }
        }, looks, wait.coerceAtLeast(0))
    }

    private fun screenIsOn(): Boolean = runCatching { (getSystemService(POWER_SERVICE) as PowerManager).isInteractive }.getOrDefault(true)

    private fun callOffLooks() {
        main.removeCallbacksAndMessages(looks)
        lookWaits = false
        steadyWaits = false
    }

    /**
     * Looks at what is in front, the one place that decides: Security & privacy is closed, another browser is
     * covered, and a guarded app's screen is turned away when it offers to undo the lock or, while a bedtime is
     * set, to set the phone's clock. At bedtime an app that is turned away then is covered. Whose window it is,
     * is asked of the window itself and of Android's record of app use, not of the event that prompted the
     * look: the lock screen may be in front by now.
     *
     * Says whether the window is worth another look while it fills in: a guarded app's that shows nothing to
     * turn away yet, one Android keeps from the watch, or, at bedtime, one that an app turned away then is
     * about to take the place of. A guarded app's screen that was read and left open is looked at steadily
     * after that ([lookSteadily]).
     */
    private fun look(): Boolean {
        val began = SystemClock.elapsedRealtime()
        val stayed = guardedStays
        guardedStays = false
        val again = try {
            keepFloatingWindowsOff()
            if (covering || followsACover() || !state.isOn) {
                false
            } else {
                drawsFirst = false
                val again = lookAtTheFront()
                val atTheFront = SystemClock.elapsedRealtime() - began
                // Whatever the window in front is, another browser's window may be on a screen beside it. A
                // cover or the shield that this look has put up is drawn first: the windows are gone through at
                // the next look, which is set already.
                if (!covering && !drawsFirst) coverWhatShows()
                val took = SystemClock.elapsedRealtime() - began
                if (took >= SLOW_LOOK) note { "a slow look: $took ms, $atTheFront of them on the window in front" }
                again || unreadBeside
            }
        } catch (e: RuntimeException) {
            // A window that goes away while it is being read must not stop the watch, nor its steady looks.
            note { "look: $e" }
            guardedStays = stayed
            true
        }
        // Counted from the look's end: a phone whose looks are slow still gets its breath between two.
        lastLookAt = SystemClock.elapsedRealtime()
        lastLookTook = lastLookAt - began
        if (guardedStays) lookSteadily()
        return again
    }

    private fun lookAtTheFront(): Boolean {
        // Another browser that has just been brought to the front is covered before the app in front is asked
        // anything: a browser that is busy starting takes its time to answer, and the look waits for it.
        if (signOfABrowser(front.last())) return false
        // Read the screen as it is now, not as an earlier look remembered it.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) clearCache()
        val root: AccessibilityNodeInfo? = rootInActiveWindow
        val inFront = root?.packageName?.toString()
        // Another browser's window is the one in front: its screen is covered before anything else is read.
        // The window's own word may still be on its way to the watch.
        if (inFront != null && inFront != packageName && (inFront in browsers || inFront in Browsers.setUpOfAWorkProfile)) {
            // A window that Android does not list yet does not say which screen it is on: with a second screen
            // about, the cover waits for the window's own word, which does.
            val itsWindow = runCatching { root.window }.getOrNull()
            if ((itsWindow != null || !moreThanOneScreen()) && atFirstSign(inFront, root.windowId, displayOf(itsWindow))) return false
        }

        // Android's record of app use first ([Front]). It names Security & privacy as soon as that is brought
        // to the front, before its window is up (the window in front may still be the one it was opened from,
        // one of the app's own included), and whatever Android shows the watch of it: since Android 14 that is
        // nothing.
        val last = front.last()
        val byTheRecord = Guard.byTheRecord(last?.packageName, last?.className, packageName, browsers, Browsers.guarded) { wayRound(it) != null }
        val focused = focusedWindow()
        if (byTheRecord == Guard.ByTheRecord.CLOSE) {
            val now = SystemClock.elapsedRealtime()
            if (named != last!!.at) {
                named = last.at
                namedAt = now
                focusLeftAt = 0
            }
            // Its window may not be up yet: the shield now, and Back once the focus has left the window it
            // was opened from, so that Back closes this screen and not that one. One Back, as ever.
            val onTheWindowBefore = focused != null && (focused == focusedBefore || focused == focusedEarlier)
            if (!onTheWindowBefore && focusLeftAt == 0L) focusLeftAt = now
            val waits = backWentTo != last.at && Guard.waitsForItsWindow(
                onTheWindowBefore, focused != null, (now - namedAt) / slow(), if (onTheWindowBefore) 0 else (now - focusLeftAt) / slow(),
            )
            note {
                "look: by the record of app use, in front is $last; the window in front is ${inFront ?: "kept from the watch"}; " +
                    "the focus is on window $focused, was on $focusedBefore and $focusedEarlier${if (waits) ": Back waits" else ""}"
            }
            if (waits) {
                raiseShield()
                HandlerCompat.postDelayed(main, { watchClosely() }, looks, LOOK_FOR_ITS_WINDOW_EVERY)
                return false
            }
            val reason = if (Guard.isSecurityAndPrivacy(last.className)) LockScreenActivity.REASON_SECURITY else LockScreenActivity.REASON_WAY_ROUND
            turnAway(last.packageName, reason, last, seen = false)
            return false
        }
        if (focused != null && focused != focusedBefore) {
            focusedEarlier = focusedBefore
            focusedBefore = focused
        }
        if (inFront == packageName) return false
        if (inFront == null) {
            // A window that shows the watch nothing: one that guards itself against taps passed through an
            // overlay, or one that is not up yet. The record can trail it by a moment: worth another look.
            note { "look: the window in front is kept from the watch; brought to the front last: $last; windows: ${windowsForTheLog()}" }
            // Its title is there before anything on it is: Settings' own Security & privacy is closed by it.
            titledSecurityAndPrivacy()?.let { settings ->
                note { "look: a window of $settings carries the title of Security & privacy" }
                turnAway(settings, LockScreenActivity.REASON_SECURITY, last?.takeIf { it.packageName == settings })
                return false
            }
            if (byTheRecord == Guard.ByTheRecord.COVER_IF_HIDDEN) {
                cover(last!!.packageName, LockScreenActivity.REASON_BROWSER)
                return false
            }
            // At bedtime the same goes for an app that is turned away then.
            val hidden = last?.packageName
            if (hidden == null || !bedtime.turnsAway(hidden)) {
                // A guarded app's screen that cannot be read for the moment is still looked at steadily: it
                // may be busy, and may be on another page by the time it answers. Without the record of app
                // use the watch cannot tell whose the window is, and looks all the same.
                guardedStays = last == null || last.packageName in Browsers.guarded
                return true
            }
            cover(hidden, LockScreenActivity.REASON_BEDTIME)
            return false
        }
        if (inFront in browsers || inFront in Browsers.setUpOfAWorkProfile) {
            // A window the app floats over the others is not got off the screen by the lock screen: its cover
            // is what holds it ([coverWhatShows]), and the lock screen is sent for it once, not at every look.
            val window = runCatching { root.window }.getOrNull()
            if (window?.type != AccessibilityWindowInfo.TYPE_SYSTEM) {
                val reason = if (inFront in browsers) LockScreenActivity.REASON_BROWSER else LockScreenActivity.REASON_WAY_ROUND
                cover(inFront, reason, displayOf(window))
            }
            return false
        }
        if (inFront !in Browsers.guarded) {
            if (bedtime.turnsAway(inFront)) {
                cover(inFront, LockScreenActivity.REASON_BEDTIME)
                return false
            }
            // Not in front yet, though it has said it is coming, or the record of app use names it already.
            return SystemClock.elapsedRealtime() < bedtimeAppComesBy || (last != null && bedtime.turnsAway(last.packageName))
        }
        val texts = mutableListOf<String>()
        val rows = mutableSetOf<Int>()
        collectTexts(root, texts, 0, rows)
        val title = runCatching { root.window?.title }.getOrNull()
        if (Guard.isSecurityAndPrivacyScreen(title, texts)) {
            note { "look: $inFront shows Security & privacy: window \"$title\", ${texts.take(3)}" }
            turnAway(inFront, LockScreenActivity.REASON_SECURITY, last?.takeIf { it.packageName == inFront })
            return false
        }
        val shown = last?.takeIf { it.packageName == inFront }
        wayRound(null, title, texts)?.let { way ->
            note { "look: $inFront shows a way round the lock, $way: window \"$title\", ${texts.take(3)}" }
            turnAway(inFront, LockScreenActivity.REASON_WAY_ROUND, shown)
            return false
        }
        Guard.letsDisplayOver(texts, browserNames.keys)?.let { name ->
            // For a browser that may already, the page stays open: that is where the leave is taken away.
            if (browserNames[name].orEmpty().none { Permissions.displaysOver(this, it) }) {
                note { "look: $inFront shows the switch that lets $name display over other apps: ${texts.take(6)}" }
                turnAway(inFront, LockScreenActivity.REASON_DISPLAY_OVER, shown)
                return false
            }
        }
        val appName = getString(R.string.app_name)
        val undoes = Guard.undoesTheLock(
            texts, appName, ownWords,
            administrator = { Permissions.adminOn(this) },
            usageAccess = { Permissions.usageOn(this) },
            mayNeedAllowing = { Permissions.mayNeedAllowing(this) },
            shortcutSet = { Permissions.shortcutOn(this) },
            rows = rows,
        )
        note {
            val named = texts.indices.filter { texts[it].contains(appName, ignoreCase = true) }
            val where = when {
                named.isEmpty() -> ""
                named.all { it in rows } -> ", named in a newer list's row"
                named.none { it in rows } -> ", named elsewhere"
                else -> ", named in a newer list's row and elsewhere"
            }
            "look: $inFront, ${texts.size} texts, undoes the lock: $undoes$where: ${texts.take(40)}"
        }
        val reason = when {
            undoes -> LockScreenActivity.REASON_SETTINGS
            bedtime.holdsClock() && ClockScreen.shows(texts + textsBehind(root)) -> LockScreenActivity.REASON_CLOCK
            else -> {
                guardedStays = true
                return true
            }
        }
        turnAway(inFront, reason, shown)
        return false
    }

    /**
     * Another browser, or the setting up of a work profile, says it has come to the front: its first sign
     * ([atFirstSign]), and a look follows, which goes through the windows on the screen.
     */
    private fun coverAndLook(packageName: String, event: AccessibilityEvent) {
        note { "word: $packageName ${event.className} says it is there, window ${event.windowId}, sent ${SystemClock.uptimeMillis() - event.eventTime} ms ago" }
        ownedBy(event)
        val display = displayOf(event)
        // A word that has been on its way for long is no first sign: by now the list has the window, or it has gone.
        val firstSign = Guard.wordIsFresh((SystemClock.uptimeMillis() - event.eventTime) / slow())
        if (firstSign && atFirstSign(packageName, event.windowId, display)) return
        if (followsACover()) return
        sendForTheLockScreen(packageName, display)
        watchClosely()
    }

    /**
     * Takes Android's record of app use for a first sign of another browser, and says whether a cover went
     * up for it just now. [last] is the screen brought to the front most recently: when that is another
     * browser's, or the setting up of a work profile, and it was brought forward just now
     * ([Guard.freshlyBroughtForward]), it is covered, once for each time it is brought forward. The record
     * names it before its window has said or shown anything, and reading the record asks nothing of the
     * browser. It does not say which screen an app is on, so on a phone with a second screen this sign is left
     * to the window's own word.
     */
    private fun signOfABrowser(last: Front.Screen?): Boolean {
        if (last == null || last.at == signedAt) return false
        val app = last.packageName
        if (app == packageName || !(app in browsers || app in Browsers.setUpOfAWorkProfile)) return false
        val since = System.currentTimeMillis() - last.at
        if (!Guard.freshlyBroughtForward(since / slow())) return false
        signedAt = last.at
        if (moreThanOneScreen()) return false
        note { "the record of app use names $app, brought to the front $since ms ago" }
        if (atFirstSign(app, -1, Display.DEFAULT_DISPLAY) || followsACover()) return true
        sendForTheLockScreen(app, Display.DEFAULT_DISPLAY)
        return false
    }

    /**
     * The first sign that [app], another browser or the setting up of a work profile, is coming to the front
     * on screen [display]: its window's own word or a look that finds it in front, with the window's number
     * in [window], or Android's record of app use, which names no window (-1). The screen gets a cover at
     * once ([coverAtOnce]).
     *
     * Says whether a cover went up just now. Then the caller stops there: the lock screen is sent for and a
     * look made in the watch's next turn, when the cover has been drawn ([followsACover] until then). The
     * watch draws it itself, and sending for the lock screen or asking the browser what it shows can keep it
     * busy for a moment, in which the page would be on show under a cover that is not drawn yet. When the
     * cover was up already, nothing is set and the caller goes on.
     */
    private fun atFirstSign(app: String, window: Int, display: Int): Boolean {
        if (!coverAtOnce(window, display, app)) return false
        // A look that was waiting its turn would be made before the cover is drawn: the one set here takes its place.
        callOffLooks()
        followSetAt = SystemClock.elapsedRealtime()
        HandlerCompat.postDelayed(main, {
            followSetAt = 0
            if (lockIsOn()) {
                sendForTheLockScreen(app, display)
                watchClosely()
            }
        }, firstSigns, 0)
        return true
    }

    /**
     * Whether the lock screen and the look that follow a cover put up at a first sign are still to come: the
     * watch does nothing that could keep it busy until then. They come in its very next turn; should that
     * ever fail, nothing waits for them longer than [FOLLOW_WITHIN].
     */
    private fun followsACover(): Boolean = followSetAt != 0L && SystemClock.elapsedRealtime() - followSetAt in 0 until FOLLOW_WITHIN * slow()

    /**
     * Sends for the lock screen over [app] on screen [display]. Android's list of the windows can trail the
     * sign that brought this about by a moment, so the windows are gone through again every
     * [EXPECT_LOOK_EVERY] for [EXPECT_A_WINDOW_FOR].
     */
    private fun sendForTheLockScreen(app: String, display: Int) {
        val began = SystemClock.elapsedRealtime()
        cover(app, if (app in Browsers.setUpOfAWorkProfile) LockScreenActivity.REASON_WAY_ROUND else LockScreenActivity.REASON_BROWSER, display)
        (SystemClock.elapsedRealtime() - began).let { if (it >= SLOW_LOOK) note { "slow: $it ms to send for the lock screen" } }
        expectedUntil = SystemClock.elapsedRealtime() + EXPECT_A_WINDOW_FOR * slow()
    }

    /** The window [event] came from belongs to the app it names: remembered, so that it need not say so itself ([readScreens]). */
    private fun ownedBy(event: AccessibilityEvent) {
        val window = event.windowId
        val app = event.packageName?.toString() ?: return
        if (window >= 0) owners[window] = app
    }

    /** Whether a window of another browser is still expected among the windows on the screen ([expectedUntil]). */
    private fun expectsAWindow(): Boolean {
        if (expectedUntil != 0L && SystemClock.elapsedRealtime() >= expectedUntil) expectedUntil = 0
        return expectedUntil != 0L
    }

    /** The screen the window that sent [event] is on. */
    private fun displayOf(event: AccessibilityEvent): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) event.displayId else Display.DEFAULT_DISPLAY

    /**
     * Puts a plain cover over the whole of screen [display] at the first sign of [app] there, unless one is
     * up or the window that gave the sign ([window], -1 when the sign names none) has its cover already. The
     * first sign is the window's own word that it is there, a look that finds it in front, or Android's record
     * of app use. A window says it is there as it starts to show, and Android lists it, with where it lies,
     * only when its opening has come to rest: on the test phone a bubble's page was on show for that long.
     * Nothing is asked of the window or of Android here, so that nothing can keep the cover waiting: it takes
     * the whole screen but the navigation bar, as the screen was last measured ([measure]). Once the window
     * is listed the list takes over ([putCovers]): the cover goes to where the window lies and gets its
     * words, or comes off because the lock screen has hidden the window. [Guard.unlistedCoverStays] says how
     * long it waits for that.
     */
    private fun coverAtOnce(window: Int, display: Int, app: String): Boolean {
        val key = firstSign(display)
        covers[key]?.let { up ->
            // The record named the app, and now its window has said which one it is.
            if (up.window < 0 && window >= 0 && up.app == app) up.window = window
            return false
        }
        if (window >= 0 && covers.containsKey(window)) return false
        // The record names no window: a window of the app that has its cover on that screen is the one it means.
        if (window < 0 && covers.values.any { it.app == app && it.display == display }) return false
        val onItsScreen = contextOn(display) ?: return false
        val manager = onItsScreen.getSystemService(WINDOW_SERVICE) as WindowManager
        val screen = measures[display] ?: measure(display, manager) ?: return false
        val area = Guard.coverArea(
            Guard.Shown(window, display, app, 0, 0, screen.width, screen.height, 0),
            screen.width, screen.height, screen.barLeft, screen.barRight, screen.barBottom,
        )?.let { Rect(it[0], it[1], it[2], it[3]) } ?: return false
        val view = coverView(onItsScreen)
        return runCatching {
            manager.addView(view, coverParams(area))
            covers[key] = Cover(view, manager, display, app, area, SystemClock.elapsedRealtime(), window)
            drawsFirst = true
            note { "a cover is over screen $display at the first sign of $app${if (window >= 0) ", window $window" else ""}" }
            lookAtTheCoversIn(EXPECT_LOOK_EVERY)
        }.onFailure { note { "no cover: $it" } }.isSuccess
    }

    /** Where [covers] keeps the cover put over screen [display] at a first sign: below every window's number. */
    private fun firstSign(display: Int): Int = -1 - display

    /** The screen that [window] is on. */
    private fun displayOf(window: AccessibilityWindowInfo?): Int =
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) Display.DEFAULT_DISPLAY
        else runCatching { window?.displayId }.getOrNull() ?: Display.DEFAULT_DISPLAY

    /**
     * Covers every window of another browser that is on a screen ([Guard.showing]), each where it lies, and
     * takes the covers off the ones that have gone. The lock screen hides a browser that fills the screen.
     * It does not hide one in the other half when two apps are side by side, one in a bubble opened over the
     * lock screen, one in a free window on a second screen, or one an app floats over the other apps: seen on
     * Android 17, where the home screen's menu opens any app as a bubble. A cover is an overlay of the watch's
     * own, like the shield, so it lies over every kind of window, and it stays for as long as the window does.
     *
     * Then the next step against the window ([Guard.againstWhatShows]): the lock screen, which says what
     * happened; after that Home, which closes a bubble and puts a free window away. While a cover is up the
     * watch goes through the windows again every [COVER_LOOK_EVERY].
     *
     * With the lock off, or the windows not to be read, every cover comes off: a cover must not stay over
     * something the watch can no longer see.
     */
    private fun coverWhatShows() {
        main.removeCallbacksAndMessages(coverLooks)
        // The windows as they are now, not as the look before remembered them.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) clearCache()
        val began = SystemClock.elapsedRealtime()
        val screens = if (state.isOn) runCatching { readScreens() }.onFailure { note { "the windows on the screen: $it" } }.getOrNull() else null
        (SystemClock.elapsedRealtime() - began).let { if (it >= SLOW_LOOK) note { "the windows took $it ms to read" } }
        note(screens)
        if (screens == null) {
            unreadBeside = false
            shownBefore = emptySet()
            dropCovers()
            return
        }
        val showing = Guard.showing(screens.windows) { it != packageName && (it in browsers || it in Browsers.setUpOfAWorkProfile) }
        unreadBeside = showing.unread
        if (putCovers(showing.windows, screens)) {
            // A cover has gone up that was not there: it is drawn before the watch does anything about its window.
            lookAtTheCoversIn(EXPECT_LOOK_EVERY)
            return
        }
        val now = SystemClock.elapsedRealtime()
        val shown = showing.windows.mapTo(HashSet()) { it.id }
        if (shown.isEmpty()) {
            if (shownBefore.isNotEmpty()) note { "nothing to cover is on a screen any more" }
            shownBefore = shown
            if (covers.isNotEmpty() || expectsAWindow()) lookAtTheCoversIn(EXPECT_LOOK_EVERY)
            return
        }
        expectedUntil = 0
        // The steps are counted for the windows that are there: one that was not, starts them afresh.
        val first = showing.windows.firstOrNull { it.id !in shownBefore } ?: showing.windows.first()
        if (!shownBefore.containsAll(shown)) {
            lockScreenSentAt = 0
            homeSentAt = 0
            homesSent = 0
        }
        shownBefore = shown
        val app = first.packageName!!
        val up = LockScreenActivity.upSince
        val next = Guard.againstWhatShows(
            sinceLockScreen = if (lockScreenSentAt == 0L) null else (now - lockScreenSentAt) / slow(),
            lockScreenUpFor = if (up == 0L) null else (now - up) / slow(),
            sinceHome = if (homeSentAt == 0L) null else (now - homeSentAt) / slow(),
            homes = homesSent,
            homeCanHelp = showing.windows.any { !it.floats && it.display == screens.focused },
        )
        when (next) {
            Guard.Against.LOCK_SCREEN -> {
                note { "look: $app shows on screen ${first.display}${if (first.floats) ", floating" else ""}, at ${first.left},${first.top} to ${first.right},${first.bottom}: covered" }
                lockScreenSentAt = now
                cover(app, if (app in Browsers.setUpOfAWorkProfile) LockScreenActivity.REASON_WAY_ROUND else LockScreenActivity.REASON_BROWSER, first.display)
            }
            Guard.Against.HOME -> {
                homeSentAt = now
                homesSent++
                note { "look: a window to cover still shows with the lock screen ${if (up == 0L) "not up" else "up"}: Home ($homesSent)" }
                performGlobalAction(GLOBAL_ACTION_HOME)
            }
            Guard.Against.WAIT -> Unit
        }
        lookAtTheCoversIn(COVER_LOOK_EVERY)
    }

    /** Notes the windows on the screens each time they are not what they were at the look before. */
    private fun note(screens: Screens?) {
        if (!Log.isLoggable(TAG, Log.DEBUG)) return
        val now = screens?.windows?.joinToString("; ") {
            "${it.id} ${it.packageName ?: "?"}${if (it.floats) " floating" else ""} on ${it.display} at ${it.left},${it.top} to ${it.right},${it.bottom} layer ${it.layer}"
        } ?: "not read"
        if (now == windowsNoted) return
        windowsNoted = now
        Log.d(TAG, "windows: $now")
    }

    /**
     * The windows are gone through again after [wait]: every [COVER_LOOK_EVERY] while a window to cover is
     * on a screen, and every [EXPECT_LOOK_EVERY] while one is expected or has its cover without being listed.
     * A turn that falls while Back is on its way waits for the next.
     */
    private fun lookAtTheCoversIn(wait: Long) {
        HandlerCompat.postDelayed(main, { if (covering) lookAtTheCoversIn(wait) else coverWhatShows() }, coverLooks, wait)
    }

    /** The apps' windows on every screen ([windows]), and the screen that has the focus ([focused]). */
    private class Screens(val windows: List<Guard.Shown>, val focused: Int)

    /**
     * Reads the windows on the phone's screens for [Guard.showing]: the apps' own, and the ones an app floats
     * over the others, which Android lists with the system's. A picture in a picture is left out: nothing
     * can be browsed in it. Whose a window is, is asked of it once and remembered ([owners]); the system's own
     * bars are among the floating ones and are no one's to cover.
     */
    private fun readScreens(): Screens {
        val byScreen: List<Pair<Int, List<AccessibilityWindowInfo>>> = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val all = windowsOnAllDisplays
            (0 until all.size()).map { all.keyAt(it) to all.valueAt(it) }
        } else {
            listOf(Display.DEFAULT_DISPLAY to windows)
        }
        var focused = Display.DEFAULT_DISPLAY
        val shown = ArrayList<Guard.Shown>()
        val bounds = Rect()
        var keptWaiting = false
        for ((screen, list) in byScreen) {
            for (window in list) {
                if (window.isFocused) focused = screen
                val floats = when (window.type) {
                    AccessibilityWindowInfo.TYPE_APPLICATION -> false
                    AccessibilityWindowInfo.TYPE_SYSTEM -> true
                    else -> continue
                }
                if (window.isInPictureInPictureMode) continue
                window.getBoundsInScreen(bounds)
                if (bounds.isEmpty) continue
                val id = window.id
                var whose = owners[id]
                if (whose == null && !keptWaiting) {
                    val began = SystemClock.elapsedRealtime()
                    whose = whose(window, id)
                    // One window that keeps the watch waiting for its answer is enough for one look.
                    if (SystemClock.elapsedRealtime() - began >= SLOW_LOOK) keptWaiting = true
                }
                shown += Guard.Shown(id, screen, whose, bounds.left, bounds.top, bounds.right, bounds.bottom, window.layer, floats)
            }
        }
        // A window that gave a first sign without being listed yet keeps its name for when it is.
        if (owners.size > shown.size + covers.size || unanswered.size > shown.size) {
            val kept = shown.mapTo(HashSet()) { it.id }
            unanswered.keys.retainAll(kept)
            covers.values.forEach { kept += it.window }
            owners.keys.retainAll(kept)
        }
        return Screens(shown, focused)
    }

    /**
     * Asks [window], numbered [id], whose it is, and remembers the answer ([owners]). The watch waits for the
     * answer, and a window whose app is busy can keep it waiting for seconds: seen on the test phone with a
     * second screen that had just come. So a window that did not answer is left alone for a while before it
     * is asked again ([Guard.asksAgainAfter]). A browser's window need not be asked at all once it has sent
     * the watch a word ([ownedBy]).
     */
    private fun whose(window: AccessibilityWindowInfo, id: Int): String? {
        val before = unanswered[id]
        if (before != null && SystemClock.elapsedRealtime() - before.first in 0 until Guard.asksAgainAfter(before.second) * slow()) return null
        val answer = runCatching { window.root?.packageName?.toString() }.getOrNull()
        if (answer != null) {
            owners[id] = answer
            unanswered.remove(id)
        } else {
            unanswered[id] = SystemClock.elapsedRealtime() to (before?.second ?: 0) + 1
        }
        return answer
    }

    /**
     * One cover: its view, the screen it is on and the window manager that put it there, whose window it is
     * for ([app]), and where it lies. [unlistedSince] is when it was put over the whole screen at a first sign
     * ([coverAtOnce]), 0 once Android has listed the window; until then [window] is the window that gave the
     * sign, -1 when the sign named none.
     */
    private class Cover(
        val view: TextView,
        val manager: WindowManager,
        val display: Int,
        val app: String,
        var area: Rect,
        var unlistedSince: Long,
        var window: Int,
    )

    /**
     * Puts a cover over each of [windows], moves the ones whose window has moved, and takes off the rest.
     * A cover that was put up at a first sign stays while Android does not list the window
     * ([Guard.unlistedCoverStays]); once the window is listed, the list decides: [windows] are the ones that
     * show, and a listed window that is not among them has been hidden by the lock screen.
     */
    private fun putCovers(windows: List<Guard.Shown>, screens: Screens): Boolean {
        var put = false
        for (window in windows) if (putCover(window)) put = true
        val wanted = windows.mapTo(HashSet()) { it.id }
        val now = SystemClock.elapsedRealtime()
        for (key in covers.keys.toList()) {
            if (key in wanted) continue
            val cover = covers[key] ?: continue
            val listed = if (cover.window >= 0) {
                screens.windows.any { it.id == cover.window }
            } else {
                screens.windows.any { it.packageName == cover.app && it.display == cover.display }
            }
            val stays = cover.unlistedSince != 0L && !listed && Guard.unlistedCoverStays(
                (now - cover.unlistedSince) / slow(),
                lockScreenListedSince = LockScreenActivity.upSince > cover.unlistedSince &&
                    screens.windows.any { it.id == lockScreenWindow && it.display == cover.display },
            )
            if (!stays) takeCoverOff(key)
        }
        return put
    }

    /**
     * Puts the cover over [window], which Android lists, or moves the one it has. The cover that was put over
     * the whole screen at the window's first sign becomes this window's: it goes to where the window lies
     * and gets its words. Says whether a cover went up that was not there before.
     */
    private fun putCover(window: Guard.Shown): Boolean {
        val onItsScreen = contextOn(window.display) ?: return false
        val manager = onItsScreen.getSystemService(WINDOW_SERVICE) as WindowManager
        val area = coverArea(window, manager) ?: return false
        val app = window.packageName ?: return false
        var old = covers[window.id]
        if (old == null) {
            val key = firstSign(window.display)
            val sign = covers[key]
            if (sign != null && sign.app == app && (sign.window == window.id || sign.window < 0)) {
                covers.remove(key)
                covers[window.id] = sign
                old = sign
            }
        }
        if (old != null && old.display == window.display) {
            if (old.unlistedSince != 0L) {
                old.unlistedSince = 0
                old.window = window.id
                sayWhy(old.view, app)
                note { "its window is listed: the cover goes to ${area.left},${area.top} to ${area.right},${area.bottom}" }
            }
            if (old.area != area) {
                old.area = area
                runCatching { old.manager.updateViewLayout(old.view, coverParams(area)) }.onFailure { note { "the cover did not move: $it" } }
            }
            return false
        }
        if (old != null) takeCoverOff(window.id)
        val view = coverView(onItsScreen)
        sayWhy(view, app)
        return runCatching {
            manager.addView(view, coverParams(area))
            covers[window.id] = Cover(view, manager, window.display, app, area, 0L, window.id)
            note { "a cover is over $app on screen ${window.display} at ${area.left},${area.top} to ${area.right},${area.bottom}" }
        }.onFailure { note { "no cover: $it" } }.isSuccess
    }

    /** A cover's view, plain and in the lock screen's own colours; [sayWhy] gives it its words. */
    private fun coverView(onItsScreen: Context): TextView = TextView(onItsScreen).apply {
        background = GradientDrawable().apply { setColor(ContextCompat.getColor(onItsScreen, R.color.fsb_toolbar)) }
        setTextColor(ContextCompat.getColor(onItsScreen, R.color.fsb_toolbar_text))
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
        gravity = Gravity.CENTER
        val edge = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 24f, resources.displayMetrics).toInt()
        setPadding(edge, edge, edge, edge)
    }

    /**
     * Gives a cover that lies over a listed window the lock screen's words about [app], and an edge in the
     * app's green: over the lock screen, whose colours it has, it would not show as a cover without one.
     */
    private fun sayWhy(view: TextView, app: String) {
        (view.background as? GradientDrawable)?.setStroke(
            TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 3f, resources.displayMetrics).toInt(),
            ContextCompat.getColor(this, R.color.fsb_green),
        )
        view.text = if (app in Browsers.setUpOfAWorkProfile) {
            getString(R.string.lock_screen_settings_title) + "\n\n" + getString(R.string.lock_screen_way_round_body)
        } else {
            getString(R.string.lock_screen_browser_title) + "\n\n" + getString(R.string.lock_screen_browser_body, Browsers.label(this, app))
        }
    }

    private fun takeCoverOff(id: Int) {
        val cover = covers.remove(id) ?: return
        note { "a cover comes off" }
        runCatching { cover.manager.removeView(cover.view) }
    }

    private fun dropCovers() {
        main.removeCallbacksAndMessages(coverLooks)
        covers.keys.toList().forEach { takeCoverOff(it) }
    }

    /**
     * Where the cover over [window] goes ([Guard.coverArea]): its own place as far as its screen goes, less
     * the edges of the screen that hold the navigation bar, as [manager]'s screen tells them now ([measure]).
     */
    private fun coverArea(window: Guard.Shown, manager: WindowManager): Rect? {
        val screen = measure(window.display, manager) ?: return null
        val area = Guard.coverArea(window, screen.width, screen.height, screen.barLeft, screen.barRight, screen.barBottom) ?: return null
        return Rect(area[0], area[1], area[2], area[3])
    }

    /** A screen's size, and how much of its left, right and bottom edge holds the navigation bar. */
    private class Measure(val width: Int, val height: Int, val barLeft: Int, val barRight: Int, val barBottom: Int)

    /**
     * Measures screen [display], which [manager] is for, and keeps the measure ([measures]) for a cover that
     * cannot wait for it ([coverAtOnce]). The size is asked of the screen itself: what the watch carries of a
     * second screen is the phone's own size, seen on Android 17, where a cover on a wider second screen
     * stopped short of a window's right edge. An accessibility overlay lies over the navigation bar and is
     * not kept clear of it by Android, so the watch does that itself. An Android before 11 does not tell the
     * bar's edges for a screen as a whole; there a cover takes the window's whole place, and Home is sent by
     * the watch.
     */
    private fun measure(display: Int, manager: WindowManager): Measure? = runCatching {
        val screen = getSystemService(DisplayManager::class.java).getDisplay(display) ?: return@runCatching null
        val size = Point()
        @Suppress("DEPRECATION")
        screen.getRealSize(size)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val bars = manager.currentWindowMetrics.windowInsets.getInsetsIgnoringVisibility(WindowInsets.Type.navigationBars())
            Measure(size.x, size.y, bars.left, bars.right, bars.bottom)
        } else {
            Measure(size.x, size.y, 0, 0, 0)
        }
    }.onFailure { note { "screen $display: $it" } }.getOrNull()?.also {
        val before = measures.put(display, it)
        if (before == null || before.width != it.width || before.height != it.height || before.barLeft != it.barLeft ||
            before.barRight != it.barRight || before.barBottom != it.barBottom
        ) {
            note { "screen $display measures ${it.width} by ${it.height}, navigation bar ${it.barLeft} left, ${it.barRight} right, ${it.barBottom} bottom" }
        }
    }

    private fun coverParams(area: Rect): WindowManager.LayoutParams = WindowManager.LayoutParams(
        area.width(),
        area.height(),
        area.left,
        area.top,
        WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
        PixelFormat.OPAQUE,
    ).apply {
        gravity = Gravity.TOP or Gravity.LEFT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // Counted from the screen's own corner, whatever bars and cut-outs it has.
            fitInsetsTypes = 0
            layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
    }

    /**
     * While the lock is on and another browser is allowed to display over other apps, Android is made to
     * keep every app's floating windows off the screens. Such a browser can float a window that takes no
     * touches, and Android never tells the watch of that window, so no cover can go over it
     * ([coverWhatShows]). What the watch can do, from Android 12, is hold up a window of its own that lets
     * nothing be floated over it ([android.view.Window.setHideOverlayWindows]): Android then hides the
     * floating windows of every app, wherever they lie, as it does while a page of Settings is in front. The
     * watch's window is one dot of the screen, see-through, and takes no touches and no keys. Its covers and
     * the shield stay: they are an accessibility service's windows, which Android does not count among the
     * floating ones.
     *
     * It is up only for as long as a browser holds that leave, because the floating windows of every other
     * app go with the browser's: a chat's bubble that an app draws itself, a floating player, a screen
     * dimmer. The Lock page says so and names the browser ([LockFragment]). The watch asks at every look, at
     * most every [ASK_ABOUT_FLOATING_EVERY] otherwise ([now] asks at once), and when Android says that a
     * leave has changed ([leaveChanged]).
     */
    private fun keepFloatingWindowsOff(now: Boolean = false) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || !::state.isInitialized) return
        val at = SystemClock.elapsedRealtime()
        if (!now && at - floatingAskedAt in 0 until ASK_ABOUT_FLOATING_EVERY) return
        floatingAskedAt = at
        val holder = if (state.isOn) browserNames.values.asSequence().flatten().firstOrNull { Permissions.displaysOver(this, it) } else null
        if (holder == null) {
            letFloatingWindowsShow()
            return
        }
        if (hider != null) return
        runCatching {
            val dialog = Dialog(this, android.R.style.Theme_Translucent_NoTitleBar)
            dialog.setCancelable(false)
            dialog.window!!.apply {
                setType(WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY)
                addFlags(
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                        WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                )
                clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
                setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
                setGravity(Gravity.TOP or Gravity.LEFT)
                setLayout(1, 1)
                setHideOverlayWindows(true)
            }
            dialog.setContentView(View(this))
            dialog.show()
            hider = dialog
            note { "$holder may display over other apps: floating windows are kept off the screens" }
        }.onFailure { note { "floating windows are not kept off: $it" } }
    }

    private fun letFloatingWindowsShow() {
        val dialog = hider ?: return
        hider = null
        note { "floating windows may show again" }
        runCatching { dialog.dismiss() }
    }

    /**
     * The watch itself for the phone's screen, and for the screen numbered [display] the watch as it stands
     * on that screen: what is made with it has that screen's measures, and its window manager puts a cover
     * there. Android gives a service like this one such a window manager from Android 11 on; before that,
     * null, and nothing is covered on a second screen.
     */
    private fun contextOn(display: Int): Context? {
        if (display == Display.DEFAULT_DISPLAY) return this
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        return runCatching {
            getSystemService(DisplayManager::class.java).getDisplay(display)?.let { createDisplayContext(it) }
        }.onFailure { note { "screen $display: $it" } }.getOrNull()
    }

    /**
     * The way round the lock that a screen of a guarded app opens, if it is to be closed now
     * ([Guard.wayRound]): told by its class in the record of app use, or by its window's title or its heading.
     */
    private fun wayRound(className: String?, windowTitle: CharSequence? = null, texts: List<String> = emptyList()): Guard.WayRound? =
        Guard.wayRound(className, windowTitle, texts, debugging = { debuggingOn() }, userSwitching = { Permissions.userSwitchOn(this) })

    /**
     * Whether a computer can give this phone commands already ([Permissions.debuggingOn]): Developer options
     * then stays open, to switch that off. A test phone is driven through just that, so there
     * `adb shell setprop log.tag.FsbLockNoCable DEBUG` makes the watch act as on a phone without it.
     */
    private fun debuggingOn(): Boolean = Permissions.debuggingOn(this) && !Log.isLoggable(NO_CABLE_TAG, Log.DEBUG)

    /**
     * The guarded app whose window in front carries the title of Settings' own Security & privacy
     * ([Guard.namesSecurityAndPrivacy]), if there is one: a window has its title before it shows the watch
     * anything else.
     */
    private fun titledSecurityAndPrivacy(): String? = runCatching {
        windows.firstOrNull { (it.isActive || it.isFocused) && Guard.namesSecurityAndPrivacy(it.title) }
            ?.root?.packageName?.toString()?.takeIf { it in Browsers.guarded }
    }.getOrNull()

    /** The number of the window that has the focus, as the watch is shown the windows; null when none has it. */
    private fun focusedWindow(): Int? = runCatching { windows.firstOrNull { it.isFocused }?.id }.getOrNull()

    /**
     * The words on the other windows the guarded apps have on the screen, behind the one in front: a dialog
     * (the one that sets the time, say) must not hide the screen it was opened from. Read only for the clock,
     * while a bedtime is set.
     */
    private fun textsBehind(inFront: AccessibilityNodeInfo): List<String> {
        val texts = mutableListOf<String>()
        runCatching { windows }.getOrNull()?.forEach { window ->
            if (window.type != AccessibilityWindowInfo.TYPE_APPLICATION) return@forEach
            val root = window.root ?: return@forEach
            if (root != inFront && root.packageName?.toString() in Browsers.guarded) collectTexts(root, texts, 0)
        }
        return texts
    }

    /**
     * The texts of a window, from the top down, into [into]. Where [rows] is given it takes the places of
     * the texts that stand in a row of one of Settings' newer lists, or in anything else there that can be
     * tapped ([Guard.isRow]; [Guard.undoesTheLock] tells the app's row in a list from the heading of its
     * own page by that).
     */
    private fun collectTexts(node: AccessibilityNodeInfo, into: MutableList<String>, depth: Int, rows: MutableSet<Int>? = null, tapped: Boolean = false) {
        if (depth > 40 || into.size > 600) return
        val canBeTapped = tapped || (rows != null && Guard.isRow(node.isClickable, node.className))
        for (text in listOf(node.text, node.contentDescription)) {
            if (text.isNullOrBlank()) continue
            if (canBeTapped) rows?.add(into.size)
            into += text.toString()
        }
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            collectTexts(child, into, depth + 1, rows, canBeTapped)
        }
    }

    /**
     * Turns a guarded screen away: closes it, then covers what is left with the lock screen. Closing takes the
     * screen off the top of Settings. An earlier build only covered it, so it stayed there, and Settings came
     * back to it, and so to the lock screen, every time it was opened.
     *
     * A shield goes up first ([raiseShield]). Then Back is sent, and the lock screen follows once the screen
     * has closed ([coverOnceClosed]), so that Back lands on the screen being closed and not on the lock screen.
     * A screen gets one Back each time it is brought to the front ([Guard.sendsBack]); [screen] is that screen
     * as the record of app use names it, when it does, and [seen] whether the watch has seen its window: one
     * it has not may still be coming up, and is given longer to close ([Guard.coverFollows]). A screen that
     * Back did not close (a menu was open over it, say) is covered all the same, and closed the next time it
     * is brought to the front.
     */
    private fun turnAway(packageName: String, reason: String, screen: Front.Screen? = null, seen: Boolean = true) {
        callOffLooks()
        raiseShield()
        if (covering) return
        val now = SystemClock.elapsedRealtime()
        if (!Guard.sendsBack((now - lastBackAt) / slow(), screen?.at, backWentTo)) {
            cover(packageName, reason)
            return
        }
        lastBackAt = now
        backWentTo = screen?.at
        covering = true
        note { "turned away ($reason): back, then the lock screen" }
        performGlobalAction(GLOBAL_ACTION_BACK)
        coverOnceClosed(packageName, reason, screen, seen)
    }

    /** Brings the lock screen up behind Back as soon as [Guard.coverFollows] says so, asking every [ASK_EVERY]. */
    private fun coverOnceClosed(packageName: String, reason: String, screen: Front.Screen?, seen: Boolean) {
        HandlerCompat.postDelayed(main, {
            val sinceBack = SystemClock.elapsedRealtime() - lastBackAt
            val inFront = if (screen == null) null else front.last()?.at
            if (Guard.coverFollows(sinceBack / slow(), screen?.at, inFront, seen)) {
                covering = false
                note { "$sinceBack ms after Back: ${if (screen == null) "the record does not say" else if (inFront != screen.at) "the screen has closed" else "the screen is still the last one brought to the front"}" }
                cover(packageName, reason)
            } else {
                coverOnceClosed(packageName, reason, screen, seen)
            }
        }, coverWaits, ASK_EVERY)
    }

    /**
     * Puts a plain screen over everything at once, for the moment it takes to close a screen and bring the
     * lock screen up. A tap in that moment lands on the shield and not on the screen being closed, where one
     * tap on Remove access is enough. Keys still go to the screen underneath, so Back closes it. The shield
     * comes down when one of the app's own screens is in front, or [SHIELD_FOR] after the lock screen was
     * last sent for at the latest ([cover]): a lock screen that could not come up must not leave the phone
     * under a blank screen. [atLatest] is that time, counted afresh each time the shield is raised.
     */
    private fun raiseShield(atLatest: Long = SHIELD_FOR) {
        main.removeCallbacksAndMessages(shieldDown)
        HandlerCompat.postDelayed(main, { lowerShield() }, shieldDown, atLatest * slow())
        if (shield != null) return
        val view = View(this).apply { setBackgroundColor(ContextCompat.getColor(this@LockAccessibilityService, R.color.fsb_toolbar)) }
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.OPAQUE,
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // Under the status bar, the navigation bar and a camera cut-out too.
            params.fitInsetsTypes = 0
            params.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
        }
        runCatching {
            (getSystemService(WINDOW_SERVICE) as WindowManager).addView(view, params)
            shield = view
            drawsFirst = true
            note { "the shield is up" }
        }.onFailure { note { "no shield: $it" } }
    }

    private fun lowerShield() {
        main.removeCallbacksAndMessages(shieldDown)
        val view = shield ?: return
        shield = null
        note { "the shield comes down" }
        runCatching { (getSystemService(WINDOW_SERVICE) as WindowManager).removeView(view) }
    }

    /**
     * Puts the lock screen in front. It is started once in [COVER_ONCE_IN] for one screen, however many looks
     * find that screen before the lock screen is up, and the record gets one entry for each turning away
     * ([Guard.writesDown]).
     */
    private fun cover(packageName: String, reason: String, display: Int = Display.DEFAULT_DISPLAY) {
        val now = SystemClock.elapsedRealtime()
        val what = "$reason $packageName"
        if (what == lastCovered && now - lastCoverAt in 0 until COVER_ONCE_IN) return
        lastCoverAt = now
        lastCovered = what
        note { "the lock screen ($reason) over $packageName" }
        if (Guard.writesDown(what == lastRecorded, now - lastRecordAt, ownScreenAt > lastRecordAt)) {
            lastRecordAt = now
            lastRecorded = what
            state.record(
                when (reason) {
                    LockScreenActivity.REASON_BROWSER -> "blocked-browser"
                    LockScreenActivity.REASON_SECURITY -> "blocked-security"
                    LockScreenActivity.REASON_BEDTIME -> "blocked-bedtime"
                    LockScreenActivity.REASON_CLOCK -> "blocked-clock"
                    else -> "blocked-settings"
                },
                JSONObject().put("app", Browsers.label(this, packageName)).put("package", packageName),
            )
        }
        val lockScreen = Intent(this, LockScreenActivity::class.java)
            .putExtra(LockScreenActivity.EXTRA_REASON, reason)
            .putExtra(LockScreenActivity.EXTRA_APP, Browsers.label(this, packageName))
            .putExtra(LockScreenActivity.EXTRA_UNTIL, if (reason == LockScreenActivity.REASON_BEDTIME) bedtime.until() else null)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        // On a phone with a second screen the lock screen goes to the screen the app is on. With one screen
        // nothing is said about where: that is how every phone so far has been covered.
        val where = if (moreThanOneScreen()) runCatching { ActivityOptions.makeBasic().setLaunchDisplayId(display).toBundle() }.getOrNull() else null
        runCatching { startActivity(lockScreen, where) }
            .recoverCatching { if (where != null) startActivity(lockScreen) else throw it }
            .onFailure { note { "no lock screen: $it" } }
        // A shield that is up waits for the lock screen from now, not from when it went up.
        if (shield != null) raiseShield()
    }

    private fun moreThanOneScreen(): Boolean =
        runCatching { getSystemService(DisplayManager::class.java).displays.size > 1 }.getOrDefault(false)

    /** The windows on the screen as the watch is shown them, for [note]: each one's kind, title and app. */
    private fun windowsForTheLog(): String = runCatching {
        windows.joinToString("; ") { window ->
            val root = window.root
            "${window.id} type ${window.type} \"${window.title}\"${if (window.isActive) " active" else ""}${if (window.isFocused) " focused" else ""} ${root?.packageName ?: "no content"}"
        }
    }.getOrElse { it.toString() }

    /**
     * By how much the waits are stretched. On a test phone many times slower than a real one they are too
     * short to show anything: with a cable, `adb shell setprop log.tag.FsbLockSlow DEBUG` makes the shield's
     * time and the waits for a window and for a screen to close eight times as long. 1 otherwise.
     */
    private fun slow(): Long = if (Log.isLoggable(SLOW_TAG, Log.DEBUG)) SLOW_BY else 1L

    /** What the watch saw and did, for someone with a cable: `adb shell setprop log.tag.FsbLock DEBUG`. Off otherwise. */
    private inline fun note(message: () -> String) {
        if (Log.isLoggable(TAG, Log.DEBUG)) Log.d(TAG, message())
    }

    private companion object {
        const val TAG = "FsbLock"
        const val SLOW_TAG = "FsbLockSlow"
        const val NO_CABLE_TAG = "FsbLockNoCable"
        const val SLOW_BY = 8L

        /** How often the watch asks whether a screen that was sent Back has closed, in milliseconds. */
        const val ASK_EVERY = 30L

        /** How often the watch looks for the window of a screen the record names before it sends Back ([Guard.waitsForItsWindow]), in milliseconds. */
        const val LOOK_FOR_ITS_WINDOW_EVERY = 50L

        /** The longest the shield waits for the lock screen, in milliseconds. */
        const val SHIELD_FOR = 4000L

        /**
         * The longest the shield put up at a tap waits for Security & privacy to come up under it, in
         * milliseconds: a phone opens a screen of Settings well within that, also when it is busy.
         */
        const val SHIELD_AFTER_A_TAP = 2500L

        /** The lock screen is started for one screen at most once in this long, in milliseconds: it takes about that long to come up. */
        const val COVER_ONCE_IN = 300L

        /** How often the watch looks again while a cover is up, in milliseconds: a window that moves takes its cover along that fast. */
        const val COVER_LOOK_EVERY = 200L

        /** For how long, and how often, the windows are gone through for one that has said it is there and is not among them yet, in milliseconds. */
        const val EXPECT_A_WINDOW_FOR = 1500L
        const val EXPECT_LOOK_EVERY = 50L

        /** A look that takes this long is noted for someone with a cable, in milliseconds. */
        const val SLOW_LOOK = 150L

        /** Between two looks the watch asks at most this often whether another browser may display over other apps, in milliseconds. */
        const val ASK_ABOUT_FLOATING_EVERY = 500L

        /** The longest the watch holds back for what follows a cover put up at a first sign, in milliseconds. */
        const val FOLLOW_WITHIN = 2000L
    }
}
