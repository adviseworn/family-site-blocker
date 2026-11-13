package io.gitlab.adviseworn.familysiteblocker

import android.graphics.Bitmap
import mozilla.components.browser.state.search.SearchEngine
import mozilla.components.browser.state.state.SearchState

/**
 * What the browser searches with: Google, and nothing else. A word typed into the address bar that is no
 * address goes there, and so do text marked on a page ("Search" over the selection) and text shared from
 * another app.
 *
 * The engine is in the browser's state from the moment the state is made (Components.store), so nothing has
 * to be read or waited for. Mozilla's own list of engines is left out on purpose. Its code reads that list
 * only when the app asks for it, which this app never did: up to app build 26 the state held no engine, and a
 * typed word was searched nowhere and left the page as it was. Its pick also changes with the country, to
 * engines the add-on's safe search does not know, and its addresses carry Firefox's partner codes, which are
 * not this app's to send.
 *
 * The address asks for Google's strict filter itself. The add-on's safe search (extension/lib/safesearch.js)
 * lets such an address through as it is and adds the setting to any Google search without it, so a search
 * from here is filtered even while the add-on is still starting. SearchTest holds this address and the
 * add-on's rules together.
 */
object Search {
    /** Where a search goes. The words searched for take the place of {searchTerms}, encoded by Mozilla's code. */
    const val TEMPLATE = "https://www.google.com/search?q={searchTerms}&safe=active"

    private const val ID = "google"

    /** The state the browser starts with: the one engine, already there and already the one in use. */
    fun state(): SearchState {
        val engine = SearchEngine(
            id = ID,
            name = "Google",
            // No page of the app shows an engine's picture, so it is an empty one.
            icon = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888),
            type = SearchEngine.Type.BUNDLED,
            resultUrls = listOf(TEMPLATE),
            isGeneral = true,
        )
        return SearchState(regionSearchEngines = listOf(engine), regionDefaultSearchEngineId = ID, complete = true)
    }
}
