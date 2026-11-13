package io.gitlab.adviseworn.familysiteblocker

import android.content.Context
import io.gitlab.adviseworn.familysiteblocker.lock.BedtimeSetting
import mozilla.components.concept.engine.EngineSession
import mozilla.components.concept.engine.webextension.MessageHandler
import mozilla.components.concept.engine.webextension.WebExtension
import mozilla.components.support.base.log.logger.Logger
import org.json.JSONObject

/**
 * The app's end of the add-on's line. The add-on in this app carries one more background script than the
 * add-on elsewhere (app/src/main/extension/android-bridge.js, added by the copyExtension task), which sends
 * the app a message when it starts and whenever its bedtime changes. The app keeps what it hears
 * ([BedtimeSetting]) for the lock, which does the phone's part of the bedtime.
 *
 * Only the add-on's own background page can send here: Gecko takes messages for the app from nowhere else.
 */
object AddOnBridge {
    /** The name the add-on sends to (android-bridge.js). */
    const val APP = "familySiteBlocker"

    private val logger = Logger("AddOnBridge")

    /** Starts listening to the add-on, once Gecko has installed it. */
    fun listen(context: Context, extension: WebExtension) {
        val setting = BedtimeSetting(context)
        extension.registerBackgroundMessageHandler(
            APP,
            object : MessageHandler {
                override fun onMessage(message: Any, source: EngineSession?): Any = answer(message) { bedtime ->
                    if (setting.hear(bedtime)) logger.info("The add-on's bedtime is now ${setting.bedtime}")
                }
            },
        )
    }

    /**
     * Takes one message, { type: "bedtime", bedtime: "<the setting as JSON text>" }, and answers true so that
     * the add-on knows it need not say it again. A message that isn't one of these is answered false and
     * changes nothing.
     *
     * The answer is a plain true or false on purpose. GeckoView hands the add-on only simple values (a number,
     * a string, true or false) and its own bundles: answered with a JSONObject it sends nothing back, the
     * add-on waits for ever, and a background page that waits is never put to sleep.
     */
    fun answer(message: Any, hearBedtime: (String) -> Unit): Boolean {
        val json = message as? JSONObject
        val bedtime = json?.opt("bedtime") as? String
        if (json?.optString("type") != "bedtime" || bedtime == null) return false
        hearBedtime(bedtime)
        return true
    }
}
