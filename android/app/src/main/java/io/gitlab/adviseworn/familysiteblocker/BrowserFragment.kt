package io.gitlab.adviseworn.familysiteblocker

import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import com.google.android.material.snackbar.Snackbar
import io.gitlab.adviseworn.familysiteblocker.databinding.FragmentBrowserBinding
import io.gitlab.adviseworn.familysiteblocker.downloads.DownloadService
import io.gitlab.adviseworn.familysiteblocker.ext.components
import io.gitlab.adviseworn.familysiteblocker.integration.ContextMenuIntegration
import io.gitlab.adviseworn.familysiteblocker.integration.FindInPageIntegration
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.mapNotNull
import mozilla.components.browser.menu.BrowserMenuBuilder
import mozilla.components.browser.menu.item.BrowserMenuCheckbox
import mozilla.components.browser.menu.item.BrowserMenuDivider
import mozilla.components.browser.menu.item.BrowserMenuImageText
import mozilla.components.browser.menu.item.BrowserMenuItemToolbar
import mozilla.components.browser.state.selector.selectedTab
import mozilla.components.browser.thumbnails.BrowserThumbnails
import mozilla.components.feature.downloads.DownloadsFeature
import mozilla.components.feature.downloads.manager.FetchDownloadManager
import mozilla.components.feature.prompts.PromptFeature
import mozilla.components.feature.search.SearchFeature
import mozilla.components.feature.session.CoordinateScrollingFeature
import mozilla.components.feature.session.FullScreenFeature
import mozilla.components.feature.session.SessionFeature
import mozilla.components.feature.session.SwipeRefreshFeature
import mozilla.components.feature.sitepermissions.SitePermissionsFeature
import mozilla.components.feature.sitepermissions.SitePermissionsRules
import mozilla.components.feature.sitepermissions.SitePermissionsRules.AutoplayAction
import mozilla.components.feature.tabs.WindowFeature
import mozilla.components.feature.tabs.toolbar.TabsToolbarFeature
import mozilla.components.feature.toolbar.ToolbarAutocompleteFeature
import mozilla.components.feature.toolbar.ToolbarFeature
import mozilla.components.lib.state.ext.consumeFlow
import mozilla.components.support.base.feature.UserInteractionHandler
import mozilla.components.support.base.feature.ViewBoundFeatureWrapper
import mozilla.components.support.ktx.android.arch.lifecycle.addObservers
import mozilla.components.support.ktx.android.view.enterImmersiveMode
import mozilla.components.support.ktx.android.view.exitImmersiveMode
import mozilla.components.support.ktx.kotlinx.coroutines.flow.ifAnyChanged
import mozilla.components.support.utils.DefaultDownloadFileUtils
import mozilla.components.support.utils.ext.requestInPlacePermissions
import mozilla.components.ui.icons.R as iconsR

/** The browser screen: toolbar, page and menu. Mozilla's features do the work; this wires them to the views. */
class BrowserFragment : Fragment(), UserInteractionHandler {
    private val sessionFeature = ViewBoundFeatureWrapper<SessionFeature>()
    private val toolbarFeature = ViewBoundFeatureWrapper<ToolbarFeature>()
    private val contextMenuIntegration = ViewBoundFeatureWrapper<ContextMenuIntegration>()
    private val downloadsFeature = ViewBoundFeatureWrapper<DownloadsFeature>()
    private val promptFeature = ViewBoundFeatureWrapper<PromptFeature>()
    private val findInPageIntegration = ViewBoundFeatureWrapper<FindInPageIntegration>()
    private val sitePermissionsFeature = ViewBoundFeatureWrapper<SitePermissionsFeature>()
    private val swipeRefreshFeature = ViewBoundFeatureWrapper<SwipeRefreshFeature>()
    private val fullScreenFeature = ViewBoundFeatureWrapper<FullScreenFeature>()
    private val thumbnailsFeature = ViewBoundFeatureWrapper<BrowserThumbnails>()
    private val searchFeature = ViewBoundFeatureWrapper<SearchFeature>()

    private var _binding: FragmentBrowserBinding? = null
    private val binding get() = _binding!!

    private val defaultBrowserRequest =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            if (_binding != null && !DefaultBrowser.isDefault(requireContext())) {
                Snackbar.make(binding.root, R.string.default_browser_hint, Snackbar.LENGTH_LONG)
                    .setAction(R.string.default_browser_open_settings) { DefaultBrowser.openSettings(requireContext()) }
                    .show()
            }
        }

    @Suppress("LongMethod")
    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentBrowserBinding.inflate(inflater, container, false)
        val components = components
        val context = requireContext()

        styleToolbar()
        binding.toolbar.display.menuBuilder = createMenu()
        binding.engineView.setActivityContext(requireActivity())

        sessionFeature.set(
            feature = SessionFeature(
                components.store,
                components.sessionUseCases.goBack,
                components.sessionUseCases.goForward,
                binding.engineView,
            ),
            owner = this,
            view = binding.root,
        )

        toolbarFeature.set(
            feature = ToolbarFeature(
                binding.toolbar,
                components.store,
                components.sessionUseCases.loadUrl,
                components.defaultSearchUseCase,
            ),
            owner = this,
            view = binding.root,
        )
        ToolbarAutocompleteFeature(binding.toolbar, components.engine).apply {
            updateAutocompleteProviders(
                providers = listOf(components.historyStorage, components.shippedDomainsProvider),
                refreshAutocomplete = false,
            )
        }
        TabsToolbarFeature(
            toolbar = binding.toolbar,
            store = components.store,
            sessionId = null,
            lifecycleOwner = viewLifecycleOwner,
            showTabs = ::showTabs,
            countBasedOnSelectedTabType = false,
        )

        swipeRefreshFeature.set(
            feature = SwipeRefreshFeature(components.store, components.sessionUseCases.reload, binding.swipeToRefresh),
            owner = this,
            view = binding.root,
        )

        downloadsFeature.set(
            feature = DownloadsFeature(
                context.applicationContext,
                store = components.store,
                useCases = components.downloadsUseCases,
                fragmentManager = childFragmentManager,
                downloadManager = FetchDownloadManager(
                    context.applicationContext,
                    components.store,
                    DownloadService::class,
                    notificationsDelegate = components.notificationsDelegate,
                ),
                onNeedToRequestPermissions = { permissions ->
                    requestInPlacePermissions(REQUEST_KEY_DOWNLOAD_PERMISSIONS, permissions) { result ->
                        downloadsFeature.get()?.onPermissionsResult(result.keys.toTypedArray(), result.toGrantResults())
                    }
                },
                downloadFileUtils = DefaultDownloadFileUtils(context = context),
            ),
            owner = this,
            view = binding.root,
        )

        contextMenuIntegration.set(
            feature = ContextMenuIntegration(
                context = context,
                fragmentManager = parentFragmentManager,
                store = components.store,
                tabsUseCases = components.tabsUseCases,
                contextMenuUseCases = components.contextMenuUseCases,
                parentView = binding.root,
                engineView = binding.engineView,
            ),
            owner = this,
            view = binding.root,
        )

        promptFeature.set(
            feature = PromptFeature(
                fragment = this,
                store = components.store,
                customTabId = null,
                tabsUseCases = components.tabsUseCases,
                fragmentManager = parentFragmentManager,
                fileUploadsDirCleaner = components.fileUploadsDirCleaner,
                onNeedToRequestPermissions = { permissions ->
                    requestInPlacePermissions(REQUEST_KEY_PROMPT_PERMISSIONS, permissions) { result ->
                        promptFeature.get()?.onPermissionsResult(result.keys.toTypedArray(), result.toGrantResults())
                    }
                },
            ),
            owner = this,
            view = binding.root,
        )

        sitePermissionsFeature.set(
            feature = SitePermissionsFeature(
                context = context,
                sessionId = null,
                storage = components.permissionStorage,
                fragmentManager = parentFragmentManager,
                sitePermissionsRules = SitePermissionsRules(
                    autoplayAudible = AutoplayAction.BLOCKED,
                    autoplayInaudible = AutoplayAction.ALLOWED,
                    camera = SitePermissionsRules.Action.ASK_TO_ALLOW,
                    location = SitePermissionsRules.Action.ASK_TO_ALLOW,
                    notification = SitePermissionsRules.Action.ASK_TO_ALLOW,
                    microphone = SitePermissionsRules.Action.ASK_TO_ALLOW,
                    persistentStorage = SitePermissionsRules.Action.ASK_TO_ALLOW,
                    mediaKeySystemAccess = SitePermissionsRules.Action.ASK_TO_ALLOW,
                    crossOriginStorageAccess = SitePermissionsRules.Action.ASK_TO_ALLOW,
                    localDeviceAccess = SitePermissionsRules.Action.ASK_TO_ALLOW,
                    localNetworkAccess = SitePermissionsRules.Action.ASK_TO_ALLOW,
                ),
                onNeedToRequestPermissions = { permissions ->
                    requestInPlacePermissions(REQUEST_KEY_SITE_PERMISSIONS, permissions) { result ->
                        sitePermissionsFeature.get()
                            ?.onPermissionsResult(result.keys.toTypedArray(), result.toGrantResults())
                    }
                },
                onShouldShowRequestPermissionRationale = { shouldShowRequestPermissionRationale(it) },
                store = components.store,
            ),
            owner = this,
            view = binding.root,
        )

        findInPageIntegration.set(
            feature = FindInPageIntegration(components.store, binding.findInPage, binding.engineView),
            owner = this,
            view = binding.root,
        )

        fullScreenFeature.set(
            feature = FullScreenFeature(
                components.store,
                components.sessionUseCases,
                fullScreenChanged = { inFullScreen ->
                    if (inFullScreen) activity?.enterImmersiveMode() else activity?.exitImmersiveMode()
                },
            ),
            owner = this,
            view = binding.root,
        )

        thumbnailsFeature.set(
            feature = BrowserThumbnails(context, binding.engineView, components.store),
            owner = this,
            view = binding.root,
        )

        searchFeature.set(
            feature = SearchFeature(components.store) { request, _ ->
                components.searchUseCases.newTabSearch.invoke(request.query)
            },
            owner = this,
            view = binding.root,
        )

        lifecycle.addObservers(
            CoordinateScrollingFeature(components.store, binding.engineView, binding.toolbar),
            WindowFeature(components.store, components.tabsUseCases),
        )

        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        val components = components

        consumeFlow(components.store) { flow ->
            flow.mapNotNull { state -> state.selectedTab }
                .ifAnyChanged { tab -> arrayOf(tab.content.loading, tab.content.canGoBack, tab.content.canGoForward) }
                .collect { binding.toolbar.invalidateActions() }
        }

        // No tab left (first start, or every tab closed): open a fresh one with the address bar ready.
        consumeFlow(components.store) { flow ->
            flow.filter { state -> state.restoreComplete }
                .map { state -> state.tabs.isEmpty() }
                .distinctUntilChanged()
                .collect { noTabs -> if (noTabs) newTab() }
        }

        if (savedInstanceState == null) {
            if (arguments?.getBoolean(ARG_FOCUS_URL_BAR) == true) binding.toolbar.editMode()
            DefaultBrowser.askOnce(requireContext(), components.preferences) { intent ->
                defaultBrowserRequest.launch(intent)
            }
        }
    }

    private fun styleToolbar() {
        val context = requireContext()
        val text = ContextCompat.getColor(context, R.color.fsb_toolbar_text)
        val hint = ContextCompat.getColor(context, R.color.fsb_toolbar_hint)
        val hintText = getString(R.string.toolbar_hint)
        with(binding.toolbar.display) {
            colors = colors.copy(
                siteInfoIconSecure = text,
                siteInfoIconInsecure = text,
                siteInfoIconLocalPdf = text,
                emptyIcon = text,
                menu = text,
                hint = hint,
                title = text,
                text = text,
                separator = hint,
            )
            setUrlBackground(ContextCompat.getDrawable(context, R.drawable.url_background))
            this.hint = hintText
            urlFormatter = { url -> if (url == NEW_TAB_URL) "" else url }
        }
        with(binding.toolbar.edit) {
            colors = colors.copy(clear = text, icon = text, hint = hint, text = text)
            setUrlBackground(ContextCompat.getDrawable(context, R.drawable.url_background))
            this.hint = hintText
        }
    }

    private fun createMenu(): BrowserMenuBuilder {
        val components = components
        val store = components.store
        val iconTint = R.color.fsb_menu_icon

        val back = BrowserMenuItemToolbar.TwoStateButton(
            primaryImageResource = iconsR.drawable.mozac_ic_back_24,
            primaryContentDescription = getString(R.string.menu_back),
            primaryImageTintResource = iconTint,
            isInPrimaryState = { store.state.selectedTab?.content?.canGoBack ?: true },
            secondaryImageTintResource = R.color.fsb_menu_icon_disabled,
            disableInSecondaryState = true,
        ) {
            components.sessionUseCases.goBack()
        }
        val forward = BrowserMenuItemToolbar.TwoStateButton(
            primaryImageResource = iconsR.drawable.mozac_ic_forward_24,
            primaryContentDescription = getString(R.string.menu_forward),
            primaryImageTintResource = iconTint,
            isInPrimaryState = { store.state.selectedTab?.content?.canGoForward ?: true },
            secondaryImageTintResource = R.color.fsb_menu_icon_disabled,
            disableInSecondaryState = true,
        ) {
            components.sessionUseCases.goForward()
        }
        val refresh = BrowserMenuItemToolbar.TwoStateButton(
            primaryImageResource = iconsR.drawable.mozac_ic_arrow_clockwise_24,
            primaryContentDescription = getString(R.string.menu_refresh),
            primaryImageTintResource = iconTint,
            isInPrimaryState = { store.state.selectedTab?.content?.loading == false },
            secondaryImageResource = iconsR.drawable.mozac_ic_cross_24,
            secondaryContentDescription = getString(R.string.menu_stop),
            secondaryImageTintResource = iconTint,
            disableInSecondaryState = false,
        ) {
            if (store.state.selectedTab?.content?.loading == true) {
                components.sessionUseCases.stopLoading()
            } else {
                components.sessionUseCases.reload()
            }
        }

        val items = listOf(
            BrowserMenuItemToolbar(listOf(back, forward, refresh)),
            BrowserMenuDivider(),
            BrowserMenuImageText(getString(R.string.menu_new_tab), iconsR.drawable.mozac_ic_plus_24, iconTint) {
                newTab()
            },
            BrowserMenuImageText(getString(R.string.menu_share), iconsR.drawable.mozac_ic_share_android_24, iconTint) {
                share()
            }.apply {
                visible = { store.state.selectedTab?.content?.url?.startsWith("http") == true }
            },
            BrowserMenuImageText(getString(R.string.menu_find_in_page), iconsR.drawable.mozac_ic_search_24, iconTint) {
                findInPageIntegration.get()?.launch()
            },
            BrowserMenuCheckbox(
                getString(R.string.menu_desktop_site),
                { store.state.selectedTab?.content?.desktopMode == true },
            ) { checked ->
                components.sessionUseCases.requestDesktopSite(checked)
            },
            BrowserMenuDivider(),
            BrowserMenuImageText(getString(R.string.menu_settings), iconsR.drawable.mozac_ic_settings_24, iconTint) {
                openExtensionPage(FamilySiteBlocker.SETTINGS_PAGE)
            },
            BrowserMenuImageText(getString(R.string.menu_every_try), iconsR.drawable.mozac_ic_history_24, iconTint) {
                openExtensionPage(FamilySiteBlocker.EVERY_TRY_PAGE)
            },
            BrowserMenuImageText(
                getString(R.string.menu_is_it_working),
                iconsR.drawable.mozac_ic_shield_checkmark_24,
                iconTint,
            ) {
                openExtensionPage(FamilySiteBlocker.CHECK_PAGE)
            },
            BrowserMenuImageText(getString(R.string.menu_default_browser), iconsR.drawable.mozac_ic_globe_24, iconTint) {
                requestDefaultBrowser()
            }.apply {
                visible = { !DefaultBrowser.isDefault(requireContext()) }
            },
        )
        return BrowserMenuBuilder(items)
    }

    private fun newTab() {
        components.tabsUseCases.addTab(NEW_TAB_URL, selectTab = true)
        binding.toolbar.editMode()
    }

    private fun share() {
        val url = components.store.state.selectedTab?.content?.url ?: return
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, url)
        }
        startActivity(Intent.createChooser(send, getString(R.string.menu_share)))
    }

    /** Opens one of the add-on's pages, going back to its tab when it is already open. */
    private fun openExtensionPage(page: String) {
        val url = FamilySiteBlocker.pageUrl(page)
        if (url == null) {
            Snackbar.make(binding.root, R.string.add_on_still_starting, Snackbar.LENGTH_SHORT).show()
            return
        }
        val components = components
        val open = components.store.state.tabs.firstOrNull { tab ->
            tab.content.url.substringBefore('#').substringBefore('?') == url
        }
        if (open != null) {
            components.tabsUseCases.selectTab(open.id)
        } else {
            components.tabsUseCases.addTab(url, selectTab = true)
        }
    }

    private fun requestDefaultBrowser() {
        val intent = DefaultBrowser.requestIntent(requireContext())
        if (intent != null) defaultBrowserRequest.launch(intent) else DefaultBrowser.openSettings(requireContext())
    }

    private fun showTabs() {
        parentFragmentManager.beginTransaction()
            .replace(R.id.container, TabsTrayFragment())
            .commit()
    }

    override fun onBackPressed(): Boolean =
        listOf(fullScreenFeature, findInPageIntegration, toolbarFeature, sessionFeature).any { it.onBackPressed() }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (promptFeature.get()?.onActivityResult(requestCode, data, resultCode) != true) {
            @Suppress("DEPRECATION")
            super.onActivityResult(requestCode, resultCode, data)
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        binding.engineView.setActivityContext(null)
        _binding = null
    }

    private fun Map<String, Boolean>.toGrantResults(): IntArray = values.map { granted ->
        if (granted) PackageManager.PERMISSION_GRANTED else PackageManager.PERMISSION_DENIED
    }.toIntArray()

    companion object {
        private const val NEW_TAB_URL = "about:blank"
        private const val ARG_FOCUS_URL_BAR = "focus_url_bar"
        private const val REQUEST_KEY_DOWNLOAD_PERMISSIONS = "downloadFeature"
        private const val REQUEST_KEY_PROMPT_PERMISSIONS = "promptFeature"
        private const val REQUEST_KEY_SITE_PERMISSIONS = "sitePermissionsFeature"

        fun create(focusUrlBar: Boolean = false) = BrowserFragment().apply {
            arguments = Bundle().apply { putBoolean(ARG_FOCUS_URL_BAR, focusUrlBar) }
        }
    }
}
