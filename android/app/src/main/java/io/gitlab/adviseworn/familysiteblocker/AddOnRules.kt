package io.gitlab.adviseworn.familysiteblocker

/**
 * Whether the add-on's rules are in force in this run of the app, and what the app does while they are not.
 *
 * Gecko starts the add-on by itself, but gives it its rules (the lists of sites, safe search and the rest) a
 * moment later, once it has read them. And not at all when it trips over itself: after an update of the app
 * that brings a new version of the add-on, Gecko 159 starts the version it had, swaps in the new one while the
 * old one is still reading its lists, and the new one then runs without a single rule until it is started once
 * more. Nothing on the screen says so, and a listed site opens. (ExtensionDNRStore.sys.mjs hands the new one
 * the old one's queue, which is closed: "Unexpected queueTask call on closed queue".)
 *
 * So the add-on says for itself whether its rules have started (android-bridge.js, heard through AddOnBridge),
 * and the app goes by that alone:
 *  - Until it has heard yes, no web page opens. A page the app is asked for waits and opens once the rules have
 *    started (Components, the pages that wait), and the tabs of the last run come back only then
 *    (BrowserApplication). The browser says that it is starting (BrowserFragment).
 *  - When it hears no, it has Gecko install the add-on again, which starts it once more. The old one's reading
 *    may still not be over then, so for as long as the answer stays no this is done again, after longer and
 *    longer waits ([WAITS_MS]).
 *  - When it hears nothing at all for [SILENCE_MS] from the moment Gecko has the add-on installed, it takes
 *    that as a no, and the browser says at once that the block list has not started: an add-on that is only
 *    slow has spoken long before.
 *
 * Everything here happens on the main thread.
 */
class AddOnRules(
    /** Has Gecko install the add-on again, and calls back when that is over, however it went. */
    private val installAgain: (over: () -> Unit) -> Unit,
    /** Runs something after so many milliseconds. */
    private val later: (Long, () -> Unit) -> Unit,
) {
    enum class State {
        /** Nothing heard yet, or the add-on is being started again. */
        STARTING,

        /** The add-on has said that its rules are in force. */
        STARTED,

        /**
         * Starting the add-on again has not helped so far ([SAY_SO_AFTER] times), or it has said nothing at all;
         * it is still being tried.
         */
        NOT_STARTED,
    }

    var state = State.STARTING
        private set(value) {
            if (field == value) return
            field = value
            watchers.toList().forEach { it(value) }
        }

    val started get() = state == State.STARTED

    private val watchers = mutableListOf<(State) -> Unit>()
    private val waiting = mutableListOf<() -> Unit>()

    /** The times in a row the add-on has said no, or nothing. */
    private var noes = 0

    /** From a no until the add-on is installed again: what the add-on says meanwhile is not taken. */
    private var mending = false

    /** The number of the wait for a word of the add-on that is running, so that one that is over can tell. */
    private var silence = 0

    /**
     * What the add-on said. The answer is whether it was taken; the add-on says again what was not
     * (android-bridge.js). While the add-on is being installed again nothing is taken: a word of the one that
     * is going must not count for the one that is coming.
     */
    fun heard(started: Boolean): Boolean {
        if (mending) return false
        silence += 1
        if (started) {
            noes = 0
            state = State.STARTED
            val run = waiting.toList()
            waiting.clear()
            run.forEach { it() }
        } else {
            mend(sayIt = false)
        }
        return true
    }

    /**
     * Gecko has the add-on installed and the app listens to it: from now on it has [SILENCE_MS] to speak. Not
     * from the app's start: on a slow phone Gecko alone can be longer than that in starting, most of all after
     * an update, and an add-on installed again while Gecko still reads its lists is the very fault this mends.
     */
    fun listening() {
        if (!mending && !started) waitForAWord()
    }

    /** Has the add-on installed again after a wait, and then waits for its word. */
    private fun mend(sayIt: Boolean) {
        mending = true
        state = if (sayIt || state == State.NOT_STARTED || noes >= SAY_SO_AFTER) State.NOT_STARTED else State.STARTING
        later(WAITS_MS[minOf(noes, WAITS_MS.lastIndex)]) {
            installAgain {
                mending = false
                waitForAWord()
            }
        }
        noes += 1
    }

    /** An add-on that says nothing for [SILENCE_MS] from now on is taken as one that said no. */
    private fun waitForAWord() {
        silence += 1
        val mine = silence
        later(SILENCE_MS) { if (mine == silence && !mending) mend(sayIt = true) }
    }

    /** Runs this once the rules have started: now, if they have. */
    fun whenStarted(run: () -> Unit) {
        if (started) run() else waiting += run
    }

    /** Tells the watcher the state now and at every change. Returns what ends the watching. */
    fun watch(watcher: (State) -> Unit): () -> Unit {
        watchers += watcher
        watcher(state)
        return { watchers -= watcher }
    }

    companion object {
        /**
         * How long after a no the add-on is installed again: the first time soon, since on a phone the old
         * one's reading is over within a second or two, and then less and less often.
         */
        val WAITS_MS = listOf(3_000L, 6_000L, 12_000L, 24_000L, 48_000L, 60_000L)

        /** After this many noes in a row the browser says that the block list has not started. */
        const val SAY_SO_AFTER = 4

        /**
         * How long the add-on may say nothing once Gecko has it installed, at the app's start and each time it
         * is installed again. It speaks as soon as Gecko has read its lists.
         */
        const val SILENCE_MS = 120_000L

        /**
         * Whether an address waits for the rules. Every one does but the app's own: an empty tab, a page of an
         * add-on (which of those open is for AddOnPages to say), and the page that says a page did not open,
         * which comes out of the app's file.
         */
        fun holds(address: String): Boolean =
            !address.equals(AddressBar.FRESH_TAB, ignoreCase = true) && OWN.none { address.startsWith(it, ignoreCase = true) }

        private val OWN = listOf("moz-extension://", "resource://android/")
    }
}
