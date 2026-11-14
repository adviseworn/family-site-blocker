package io.gitlab.adviseworn.familysiteblocker

import mozilla.components.concept.engine.webextension.WebExtension
import mozilla.components.support.base.log.logger.Logger

/** The add-on inside the app: where it lives in the APK, and its pages once Gecko has installed it. */
object FamilySiteBlocker {
    const val EXTENSION_ID = "family-site-blocker@parental-controls.local"
    const val EXTENSION_URL = "resource://android/assets/extensions/family-site-blocker/"

    const val SETTINGS_PAGE = "options.html"
    const val EVERY_TRY_PAGE = "tries.html"

    /** The part of the settings page headed "Is it working?". */
    const val IS_IT_WORKING = "working"

    private val logger = Logger("FamilySiteBlocker")

    /** moz-extension://…/ once the add-on runs; null while Gecko is still starting. */
    @Volatile
    var baseUrl: String? = null
        private set

    fun onInstalled(extension: WebExtension) {
        baseUrl = extension.getMetadata()?.baseUrl
        logger.info("Add-on ${extension.id} ready at $baseUrl")
    }

    /** The full address of one of the add-on's pages, or null while the add-on is still starting. */
    fun pageUrl(page: String): String? = baseUrl?.let { it + page }
}
