package io.gitlab.adviseworn.familysiteblocker.integration

import android.content.Context
import android.os.Environment
import android.view.View
import androidx.fragment.app.FragmentManager
import mozilla.components.browser.state.store.BrowserStore
import mozilla.components.concept.engine.EngineView
import mozilla.components.feature.contextmenu.ContextMenuCandidate
import mozilla.components.feature.contextmenu.ContextMenuFeature
import mozilla.components.feature.contextmenu.ContextMenuUseCases
import mozilla.components.feature.tabs.TabsUseCases
import mozilla.components.support.base.feature.LifecycleAwareFeature
import mozilla.components.ui.widgets.DefaultSnackbarDelegate

/**
 * The long-press menu on links, pictures and addresses. The list is spelled out instead of taking Mozilla's
 * default so that "Open in private tab" stays out: the app has no private tabs, where the add-on would not run.
 */
class ContextMenuIntegration(
    context: Context,
    fragmentManager: FragmentManager,
    store: BrowserStore,
    tabsUseCases: TabsUseCases,
    contextMenuUseCases: ContextMenuUseCases,
    parentView: View,
    engineView: EngineView,
) : LifecycleAwareFeature {
    private val snackbarDelegate = DefaultSnackbarDelegate()
    private val downloadsLocation = {
        Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS).path
    }

    private val candidates = listOf(
        ContextMenuCandidate.createOpenInNewTabCandidate(context, tabsUseCases, parentView, snackbarDelegate),
        ContextMenuCandidate.createCopyLinkCandidate(context, parentView, snackbarDelegate),
        ContextMenuCandidate.createDownloadLinkCandidate(context, contextMenuUseCases, downloadsLocation),
        ContextMenuCandidate.createShareLinkCandidate(context),
        ContextMenuCandidate.createOpenImageInNewTabCandidate(context, tabsUseCases, parentView, snackbarDelegate),
        ContextMenuCandidate.createSaveImageCandidate(context, contextMenuUseCases, downloadsLocation),
        ContextMenuCandidate.createSaveVideoAudioCandidate(context, contextMenuUseCases, downloadsLocation),
        ContextMenuCandidate.createCopyImageLocationCandidate(context, parentView, snackbarDelegate),
        ContextMenuCandidate.createAddContactCandidate(context),
        ContextMenuCandidate.createShareEmailAddressCandidate(context),
        ContextMenuCandidate.createCopyEmailAddressCandidate(context, parentView, snackbarDelegate),
    )

    private val feature = ContextMenuFeature(fragmentManager, store, candidates, engineView, contextMenuUseCases)

    override fun start() = feature.start()

    override fun stop() = feature.stop()
}
