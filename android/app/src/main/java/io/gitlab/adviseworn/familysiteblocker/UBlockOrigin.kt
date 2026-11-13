package io.gitlab.adviseworn.familysiteblocker

import mozilla.components.concept.engine.webextension.WebExtension
import mozilla.components.support.base.log.logger.Logger

/**
 * uBlock Origin inside the app: it blocks the advertisements. It is Raymond Hill's add-on (GPL 3), every file
 * as Mozilla's add-on site hands it to Firefox; the build fetches it (app/build.gradle) and Gecko installs it
 * from the APK's assets beside Family Site Blocker. Like Family Site Blocker it has no off switch here, and
 * none of its own pages opens but one ([AddOnPages]).
 */
object UBlockOrigin {
    const val EXTENSION_ID = "uBlock0@raymondhill.net"
    const val EXTENSION_URL = "resource://android/assets/extensions/ublock-origin/"

    /** The page it shows in place of one it has stopped whole: "uBlock Origin has prevented the following page from loading". */
    const val STOPPED_PAGE = "document-blocked.html"

    private val logger = Logger("UBlockOrigin")

    /** moz-extension://…/ once it runs; null while Gecko is still starting. */
    @Volatile
    var baseUrl: String? = null
        private set

    fun onInstalled(extension: WebExtension) {
        baseUrl = extension.getMetadata()?.baseUrl
        logger.info("uBlock Origin ${extension.getMetadata()?.version} ready at $baseUrl")
    }
}
