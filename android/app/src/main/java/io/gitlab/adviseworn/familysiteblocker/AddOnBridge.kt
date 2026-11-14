package io.gitlab.adviseworn.familysiteblocker

import android.content.Context
import io.gitlab.adviseworn.familysiteblocker.lock.BedtimeSetting
import mozilla.components.concept.engine.EngineSession
import mozilla.components.concept.engine.webextension.MessageHandler
import mozilla.components.concept.engine.webextension.Port
import mozilla.components.concept.engine.webextension.WebExtension
import mozilla.components.support.base.log.logger.Logger
import org.json.JSONObject

/**
 * The app's end of the add-on's line. The add-on in this app carries one more background script than the
 * add-on elsewhere (app/src/main/extension/android-bridge.js, added by the copyExtension task), which sends
 * the app a message when it starts, whenever its bedtime changes, and for as long as its rules have not
 * started. The app keeps the bedtime it hears ([BedtimeSetting]) for the lock, which does the phone's part of
 * it, and goes by what it hears of the rules before it opens a web page ([AddOnRules]).
 *
 * The script also holds a line open to the app for as long as it runs and sends nothing over it. Gecko puts
 * an add-on's background page to sleep after half a minute with nothing to do, but not one that holds such a
 * line, and an add-on that is awake stops a listed site opened by another road, a web proxy's say, before
 * the proxy's page is in the tab. The app has only to take the line and keep it.
 *
 * Only the add-on's own background page can send here: Gecko takes messages for the app from nowhere else.
 */
object AddOnBridge {
    /** The name the add-on sends to (android-bridge.js). */
    const val APP = "familySiteBlocker"

    private val logger = Logger("AddOnBridge")

    /** The line the add-on holds open, kept so that nothing here lets go of it. */
    private var line: Port? = null

    /** Starts listening to the add-on, once Gecko has installed it. */
    fun listen(context: Context, extension: WebExtension, rules: AddOnRules) {
        val setting = BedtimeSetting(context)
        extension.registerBackgroundMessageHandler(
            APP,
            object : MessageHandler {
                override fun onPortConnected(port: Port) {
                    line = port
                    logger.info("The add-on holds its line open: its background page stays awake")
                }

                override fun onPortDisconnected(port: Port) {
                    line = null
                    logger.info("The add-on's line has closed")
                }

                override fun onMessage(message: Any, source: EngineSession?): Any = answer(
                    message,
                    hearRules = { started ->
                        rules.heard(started).also { taken ->
                            logger.info("The add-on's rules have ${if (started) "started" else "not started"}${if (taken) "" else " (not taken: the add-on is being installed again)"}")
                        }
                    },
                ) { bedtime ->
                    if (setting.hear(bedtime)) logger.info("The add-on's bedtime is now ${setting.bedtime}")
                }
            },
        )
    }

    /**
     * Takes one message and answers true so that the add-on knows it need not say it again:
     *  - { type: "bedtime", bedtime: "<the setting as JSON text>" }
     *  - { type: "rules", started: true or false }, answered with what [hearRules] says: whether it was taken.
     * A message that isn't one of these is answered false and changes nothing.
     *
     * The answer is a plain true or false on purpose. GeckoView hands the add-on only simple values (a number,
     * a string, true or false) and its own bundles: answered with a JSONObject it sends nothing back, and
     * the add-on's telling is never answered.
     */
    fun answer(message: Any, hearRules: (Boolean) -> Boolean = { false }, hearBedtime: (String) -> Unit): Boolean {
        val json = message as? JSONObject ?: return false
        return when (json.optString("type")) {
            "bedtime" -> {
                val bedtime = json.opt("bedtime") as? String ?: return false
                hearBedtime(bedtime)
                true
            }
            "rules" -> hearRules(json.opt("started") as? Boolean ?: return false)
            else -> false
        }
    }
}
