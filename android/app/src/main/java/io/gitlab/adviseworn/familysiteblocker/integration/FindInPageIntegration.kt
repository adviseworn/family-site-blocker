package io.gitlab.adviseworn.familysiteblocker.integration

import android.view.View
import mozilla.components.browser.state.selector.selectedTab
import mozilla.components.browser.state.store.BrowserStore
import mozilla.components.concept.engine.EngineView
import mozilla.components.feature.findinpage.FindInPageFeature
import mozilla.components.feature.findinpage.view.FindInPageView
import mozilla.components.support.base.feature.LifecycleAwareFeature
import mozilla.components.support.base.feature.UserInteractionHandler

/** The find-in-page bar under the toolbar: shown from the menu, hidden with its close button or the back button. */
class FindInPageIntegration(
    private val store: BrowserStore,
    private val view: FindInPageView,
    engineView: EngineView,
) : LifecycleAwareFeature, UserInteractionHandler {
    private val feature = FindInPageFeature(store, view, engineView, ::onClose)

    override fun start() = feature.start()

    override fun stop() = feature.stop()

    override fun onBackPressed(): Boolean = feature.onBackPressed()

    fun launch() {
        val tab = store.state.selectedTab ?: return
        view.asView().visibility = View.VISIBLE
        feature.bind(tab)
    }

    private fun onClose() {
        view.asView().visibility = View.GONE
    }
}
