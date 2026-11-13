package io.gitlab.adviseworn.familysiteblocker

import android.app.Application
import android.os.Handler
import android.os.Looper
import io.gitlab.adviseworn.familysiteblocker.ext.components
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import mozilla.components.browser.state.action.SystemAction
import mozilla.components.browser.state.selector.findTab
import mozilla.components.browser.storage.sync.GlobalPlacesDependencyProvider
import mozilla.components.concept.engine.EngineSession
import mozilla.components.support.AppServicesInitializer
import mozilla.components.support.base.log.Log
import mozilla.components.support.base.log.logger.Logger
import mozilla.components.support.base.log.sink.AndroidLogSink
import mozilla.components.support.ktx.android.content.isMainProcess
import mozilla.components.support.ktx.android.content.runOnlyInMainProcess
import mozilla.components.support.rusthttp.RustHttpConfig
import mozilla.components.support.webextensions.WebExtensionSupport

/**
 * The app. It wires the browser together once per process, brings the tabs back after a restart, and lets the
 * add-on open, close and pick tabs.
 */
class BrowserApplication : Application() {
    val components by lazy { Components(this) }

    override fun onCreate() {
        super.onCreate()
        Log.addSink(AndroidLogSink())

        // Gecko runs pages and the GPU work in extra processes, which start this Application too.
        // Only the main process sets up the browser.
        if (!isMainProcess()) return

        // Mozilla's Rust components (the history database) must start before any other call into them.
        AppServicesInitializer.init(AppServicesInitializer.Config(crashReporting = null))
        RustHttpConfig.setClient(lazy { components.client })

        components.engine.warmUp()
        restoreTabs()
        components.downloadsUseCases.restoreDownloads()
        GlobalPlacesDependencyProvider.initialize(components.historyStorage)

        WebExtensionSupport.initialize(
            runtime = components.engine,
            store = components.store,
            onNewTabOverride = { extension, engineSession, url, selected, isPrivate ->
                if (extension?.id != UBlockOrigin.EXTENSION_ID && components.addOnPages.opens(url)) {
                    components.tabsUseCases.addTab(
                        url,
                        selectTab = selected,
                        engineSession = engineSession,
                        private = isPrivate,
                    )
                } else {
                    Logger("BrowserApplication").info("${extension?.id} asked for a tab that does not open here")
                    turnAway(engineSession)
                }
            },
            onCloseTabOverride = { _, sessionId -> components.tabsUseCases.removeTab(sessionId) },
            onSelectTabOverride = { _, sessionId ->
                if (components.store.state.findTab(sessionId) != null) components.tabsUseCases.selectTab(sessionId)
            },
        )
    }

    /**
     * A tab an add-on asked for that does not open. uBlock Origin asks for one whenever it wants to show its
     * settings, for instance when a link that adds a filter list is tapped on a web page; in this app it has
     * no settings (AddOnPages). Gecko has made the page's session before the app is asked, and starts the
     * page in it whatever the app answers. So the session gets no tab, where nobody can see or touch it, and
     * is closed once Gecko has opened it: closing it sooner does nothing. The answer wanted is a tab's id;
     * it gets the one in front.
     */
    private fun turnAway(engineSession: EngineSession): String {
        val main = Handler(Looper.getMainLooper())
        for (wait in TURNED_AWAY_CLOSES_AFTER_MS) main.postDelayed({ engineSession.close() }, wait)
        return components.store.state.selectedTabId.orEmpty()
    }

    private fun restoreTabs() = components.applicationScope.launch(Dispatchers.Main) {
        components.tabsUseCases.restore(components.sessionStorage)
        components.sessionStorage.autoSave(components.store)
            .periodicallyInForeground(interval = 30, unit = TimeUnit.SECONDS)
            .whenGoingToBackground()
            .whenSessionsChange()
    }

    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        runOnlyInMainProcess {
            components.store.dispatch(SystemAction.LowMemoryAction(level))
            components.icons.onTrimMemory(level)
        }
    }

    private companion object {
        /** When a session that got no tab is closed: soon, and once more for a phone that was slow to open it. */
        val TURNED_AWAY_CLOSES_AFTER_MS = longArrayOf(1_000, 15_000)
    }
}
