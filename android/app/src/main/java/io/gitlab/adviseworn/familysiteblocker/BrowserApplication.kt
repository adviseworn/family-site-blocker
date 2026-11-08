package io.gitlab.adviseworn.familysiteblocker

import android.app.Application
import io.gitlab.adviseworn.familysiteblocker.ext.components
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import mozilla.components.browser.state.action.SystemAction
import mozilla.components.browser.storage.sync.GlobalPlacesDependencyProvider
import mozilla.components.support.AppServicesInitializer
import mozilla.components.support.base.log.Log
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
            onNewTabOverride = { _, engineSession, url, selected, isPrivate ->
                components.tabsUseCases.addTab(
                    url,
                    selectTab = selected,
                    engineSession = engineSession,
                    private = isPrivate,
                )
            },
            onCloseTabOverride = { _, sessionId -> components.tabsUseCases.removeTab(sessionId) },
            onSelectTabOverride = { _, sessionId -> components.tabsUseCases.selectTab(sessionId) },
        )
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
}
