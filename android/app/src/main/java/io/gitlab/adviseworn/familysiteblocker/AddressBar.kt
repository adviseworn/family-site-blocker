package io.gitlab.adviseworn.familysiteblocker

import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import mozilla.components.browser.toolbar.BrowserToolbar
import mozilla.components.concept.toolbar.Toolbar
import mozilla.components.support.ktx.android.view.hideKeyboard

/**
 * The address bar as Mozilla's ToolbarFeature is given it: Mozilla's toolbar, with what was wrong about the
 * field someone types into set right.
 *
 * The page in front cannot touch what someone is typing. ToolbarFeature tells the toolbar the front tab's
 * search words again at every change to that tab: a step of its loading, a new title, a new picture.
 * BrowserToolbar puts what it is told straight into the field while the field is being edited, which it
 * means for a suggestion picked to work on. Together the two emptied the field under the person's fingers
 * whenever the page behind was doing anything, and Go then searched for nothing. Here the words wait until
 * the editing is over. The toolbar then has them for the next time the field is opened, where the words of
 * a search stand ready to be changed.
 *
 * The keyboard goes when the field does. Mozilla's field no longer closes it, and Android leaves a keyboard
 * up when the field it was for is gone: it stayed over the page after Go, and the first Back only closed it.
 *
 * Back closes the bar and does nothing else (the listener's onCancelEditing has the how).
 *
 * A fresh tab has no address. Its bar shows the hint, and opens empty rather than on "about:blank".
 */
class AddressBar(private val toolbar: BrowserToolbar) : Toolbar by toolbar {
    private val words = WordsHeldWhileTyping(toolbar::setSearchTerms)

    /** The Back that is closing the bar goes on to the keyboard, which closes itself with it. */
    private var keyboardTakesThisBack = false

    init {
        toolbar.setOnEditListener(
            object : Toolbar.OnEditListener {
                override fun onStartEditing() = words.typingStarted()

                // The toolbar says this at every return to the address shown, also when nobody was typing.
                override fun onStopEditing() {
                    if (words.typingOver() && !keyboardTakesThisBack) toolbar.hideKeyboard()
                    keyboardTakesThisBack = false
                }

                // Back with the bar open, on an Android that hands a Back to the field before anyone else
                // (up to 15; a later one tells nobody here, and takes one Back for the keyboard and one for
                // the bar). The toolbar asks whether to close the bar, and passes the Back on whatever the
                // answer. With the keyboard up the answer is yes: the keyboard takes that Back and closes
                // itself with it. It must be left to do so, because a keyboard closed from here first lets
                // the Back through to the page, which then goes back as well. With no keyboard up nobody
                // would take the Back, so the answer is no: it reaches the app's own Back
                // (BrowserFragment.onBackPressed), which closes the bar and keeps it.
                override fun onCancelEditing(): Boolean {
                    keyboardTakesThisBack = keyboardIsUp()
                    return keyboardTakesThisBack
                }
            },
        )
    }

    private fun keyboardIsUp(): Boolean =
        ViewCompat.getRootWindowInsets(toolbar)?.isVisible(WindowInsetsCompat.Type.ime()) == true

    override var url: CharSequence
        get() = toolbar.url
        set(value) {
            toolbar.url = if (value.toString() == FRESH_TAB) "" else value
        }

    override fun setSearchTerms(searchTerms: String) = words.told(searchTerms)

    /**
     * Opens the bar on a tab made this moment, empty. The toolbar still holds the address and the search
     * words of the tab that was in front before, and would open on those.
     */
    fun openEmpty() {
        toolbar.url = ""
        toolbar.setSearchTerms("")
        toolbar.editMode()
    }

    companion object {
        /** The address of a tab that has been given none yet. */
        const val FRESH_TAB = "about:blank"
    }
}

/** The first rule of [AddressBar] by itself: what is told while someone types waits, and only the last of it counts. */
class WordsHeldWhileTyping(private val pass: (String) -> Unit) {
    private var typing = false
    private var waiting: String? = null

    fun typingStarted() {
        typing = true
    }

    /** Passes on what waited, and says whether someone was typing at all. */
    fun typingOver(): Boolean {
        val wasTyping = typing
        typing = false
        waiting?.let { held ->
            waiting = null
            pass(held)
        }
        return wasTyping
    }

    fun told(words: String) {
        if (typing) waiting = words else pass(words)
    }
}
