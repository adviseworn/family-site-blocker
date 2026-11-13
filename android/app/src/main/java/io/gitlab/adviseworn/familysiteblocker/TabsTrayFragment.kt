package io.gitlab.adviseworn.familysiteblocker

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import androidx.recyclerview.widget.GridLayoutManager
import com.google.android.material.snackbar.Snackbar
import io.gitlab.adviseworn.familysiteblocker.databinding.FragmentTabstrayBinding
import io.gitlab.adviseworn.familysiteblocker.ext.components
import io.gitlab.adviseworn.familysiteblocker.ext.tintIcons
import mozilla.components.browser.state.state.TabSessionState
import mozilla.components.browser.tabstray.TabsAdapter
import mozilla.components.browser.tabstray.TabsTray
import mozilla.components.browser.thumbnails.loader.ThumbnailLoader
import mozilla.components.feature.tabs.TabsUseCases
import mozilla.components.feature.tabs.tabstray.TabsFeature
import mozilla.components.support.base.feature.UserInteractionHandler
import mozilla.components.support.base.feature.ViewBoundFeatureWrapper
import mozilla.components.ui.icons.R as iconsR

/** The open tabs as a grid of thumbnails, with a button for a new one. */
class TabsTrayFragment : Fragment(), UserInteractionHandler {
    private val tabsFeature = ViewBoundFeatureWrapper<TabsFeature>()

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View =
        inflater.inflate(R.layout.fragment_tabstray, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        val binding = FragmentTabstrayBinding.bind(view)

        binding.toolbar.setNavigationIcon(iconsR.drawable.mozac_ic_back_24)
        binding.toolbar.setNavigationOnClickListener { closeTabsTray() }
        binding.toolbar.inflateMenu(R.menu.tabstray_menu)
        binding.toolbar.tintIcons()
        binding.toolbar.setOnMenuItemClickListener { item ->
            if (item.itemId == R.id.newTab) {
                components.tabsUseCases.addTab(AddressBar.FRESH_TAB, selectTab = true)
                closeTabsTray(focusUrlBar = true)
            }
            true
        }

        val adapter = createTabsAdapter(view)
        binding.tabsTray.adapter = adapter
        binding.tabsTray.layoutManager = GridLayoutManager(context, 2)

        tabsFeature.set(
            feature = TabsFeature(tabsTray = adapter, store = components.store, onCloseTray = { closeTabsTray() }),
            owner = this,
            view = view,
        )
    }

    override fun onBackPressed(): Boolean {
        closeTabsTray()
        return true
    }

    private fun closeTabsTray(focusUrlBar: Boolean = false) {
        parentFragmentManager.beginTransaction()
            .replace(R.id.container, BrowserFragment.create(focusUrlBar))
            .commit()
    }

    private fun createTabsAdapter(view: View): TabsAdapter {
        val components = components
        val removeWithUndo = RemoveTabWithUndo(components.tabsUseCases.removeTab, view, components.tabsUseCases.undo)
        return TabsAdapter(
            thumbnailLoader = ThumbnailLoader(components.thumbnailStorage),
            delegate = object : TabsTray.Delegate {
                override fun onTabSelected(tab: TabSessionState, source: String?) {
                    components.tabsUseCases.selectTab(tab.id)
                    closeTabsTray()
                }

                override fun onTabClosed(tab: TabSessionState, source: String?) {
                    removeWithUndo.invoke(tab.id)
                }
            },
        )
    }
}

/** Closes a tab and offers to undo it for a moment. */
private class RemoveTabWithUndo(
    private val actual: TabsUseCases.RemoveTabUseCase,
    private val view: View,
    private val undo: TabsUseCases.UndoTabRemovalUseCase,
) : TabsUseCases.RemoveTabUseCase {
    override fun invoke(tabId: String, excludedFallbackTabIds: Set<String>) {
        actual.invoke(tabId, excludedFallbackTabIds)
        Snackbar.make(view, R.string.tab_closed, Snackbar.LENGTH_LONG)
            .setAction(R.string.undo) { undo.invoke() }
            .show()
    }
}
