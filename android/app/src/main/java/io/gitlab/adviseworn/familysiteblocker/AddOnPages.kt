package io.gitlab.adviseworn.familysiteblocker

import android.content.SharedPreferences
import androidx.core.content.edit
import mozilla.components.browser.state.action.BrowserAction
import mozilla.components.browser.state.action.ContentAction
import mozilla.components.browser.state.action.TabListAction
import mozilla.components.browser.state.state.BrowserState
import mozilla.components.lib.state.Middleware
import mozilla.components.lib.state.Store
import mozilla.components.support.base.log.logger.Logger

/**
 * Which pages of an add-on (moz-extension://…) open in a tab: Family Site Blocker's own, and the one page
 * uBlock Origin shows in place of a page it has stopped. Nothing else.
 *
 * That keeps uBlock Origin's settings out of reach. They are no place to leave open here: its own filters can
 * restyle or script any page, and one line of them shows every picture the picture filter has hidden; its
 * lists can be swapped for any list on the web; and it can be switched off. Gecko gives every add-on's pages
 * an address that can be typed, and uBlock Origin's stopped page shows that address, so "no button leads
 * there" would not be enough.
 *
 * An add-on's address is its own from the day Gecko first installs it, for as long as the app's data lasts,
 * and Gecko reports it a moment after every start. The app keeps the last report ([kept]), so that a page
 * asked for in that moment, by a tab that comes back or a link from another app, is judged like any other.
 */
class AddOnPages(private val kept: SharedPreferences) {
    /** Whether a tab may go to [url]. */
    fun opens(url: String): Boolean = opens(
        url,
        ours = FamilySiteBlocker.baseUrl ?: kept.getString(KEPT_OURS, null),
        adBlockers = UBlockOrigin.baseUrl ?: kept.getString(KEPT_AD_BLOCKERS, null),
    )

    /** An add-on has reported its address: keep both as they now stand. */
    fun reported() = kept.edit {
        FamilySiteBlocker.baseUrl?.let { putString(KEPT_OURS, it) }
        UBlockOrigin.baseUrl?.let { putString(KEPT_AD_BLOCKERS, it) }
    }

    companion object {
        private const val SCHEME = "moz-extension:"
        private const val KEPT_OURS = "add_on_address"
        private const val KEPT_AD_BLOCKERS = "ad_blocker_address"

        /**
         * Whether a tab may go to [url], with the two add-ons' addresses (moz-extension://…/) as far as the
         * app knows them.
         *
         * A page of uBlock Origin's opens only if it is the stopped page. Any other add-on page opens only if
         * it is Family Site Blocker's. That holds as soon as Family Site Blocker's address is known ([ours]),
         * even if uBlock Origin's is not ([adBlockers] null): what is not ours stays shut.
         *
         * [ours] is null only in the first moments of the first start after the app was installed or updated
         * to a version that keeps the addresses. Then a page is turned away only if it is known to be uBlock
         * Origin's, so that "This site is blocked" and the bedtime page show from the first moment. Nothing is
         * let through by that: while uBlock Origin's address has never been reported, it is at most seconds
         * old and nobody has seen it.
         */
        fun opens(url: String, ours: String?, adBlockers: String?): Boolean {
            val address = asGeckoReadsIt(url)
            if (!address.startsWithInAnyCase(SCHEME)) return true
            if (adBlockers != null && address.startsWithInAnyCase(folder(adBlockers))) {
                // The stopped page itself, with or without what follows a ? or a #. A longer path is another page.
                val stopped = folder(adBlockers) + UBlockOrigin.STOPPED_PAGE
                val next = address.getOrNull(stopped.length)
                return address.startsWithInAnyCase(stopped) && (next == null || next == '?' || next == '#')
            }
            return ours == null || address.startsWithInAnyCase(folder(ours))
        }

        /**
         * A typed address as Gecko will read it. Gecko first drops what stands around it: spaces of every
         * kind, a no-break space and a byte-order mark among them, line ends and control characters. Its URL
         * parser then drops the tabs and line breaks inside it. So "moz-ext\tension:" and " moz-extension:"
         * are told for what they are. This drops a little more than Gecko does (every mark that takes no
         * room), which can only turn more away.
         */
        private fun asGeckoReadsIt(url: String): String =
            url.filterNot { it == '\t' || it == '\n' || it == '\r' }.trim { it.standsAround() }

        private fun Char.standsAround(): Boolean =
            this <= ' ' || isWhitespace() || isISOControl() || category == CharCategory.FORMAT

        private fun folder(baseUrl: String): String = if (baseUrl.endsWith("/")) baseUrl else "$baseUrl/"

        /** A to Z only, as in an address's scheme and host: no letter from elsewhere counts as one of these. */
        private fun String.startsWithInAnyCase(prefix: String): Boolean =
            length >= prefix.length && prefix.indices.all { lower(this[it]) == lower(prefix[it]) }

        private fun lower(letter: Char): Char = if (letter in 'A'..'Z') letter + ('a' - 'A') else letter
    }
}

/**
 * The second look at an add-on's page. [AddOnPages] is asked before Gecko goes to a page, with the address as
 * it was typed or linked, and Gecko does not ask about every page: one out of a tab's history comes back
 * unasked. This looks at where a tab has in fact arrived, in Gecko's own writing of the address. A tab that
 * has come to a page that does not open is closed. Its history goes with it, so Back cannot lead to the page
 * either, and the browser opens a fresh tab when none is left.
 */
class AddOnPagesWatch(private val pages: AddOnPages) : Middleware<BrowserState, BrowserAction> {
    private val logger = Logger("AddOnPages")

    override fun invoke(store: Store<BrowserState, BrowserAction>, next: (BrowserAction) -> Unit, action: BrowserAction) {
        next(action)
        if (action is ContentAction.UpdateUrlAction && !pages.opens(action.url)) {
            logger.info("A tab came to an add-on's page that does not open here and was closed")
            store.dispatch(TabListAction.RemoveTabAction(action.sessionId))
        }
    }
}
